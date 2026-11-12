import type { Allocation, Concession, Intent, Intervention, NegotiationMessage, Offer, Plan, SolveReport, World } from '@framvera/contracts';
import type { Deps, Family, Generated } from '../src/types.ts';

const H = 3_600_000;
const T0 = '2026-01-01T00:00:00.000Z';
const iso = (ms: number) => new Date(ms).toISOString();

/** Test-only stand-ins for the sibling modules: one stage, window extensions as the only negotiable move. */
export function fakeGenerate(seed: number, family: Family): Generated {
  const feasibleWindowH = family === 'feasible' ? 48 : 5;
  const cap = family === 'impossible' ? 20 : 200;
  const mk = (id: string, actor: string, price: number): Offer => ({
    id, version: 1, actor, stage: 's', capacity: cap, minQty: 0, ratePerHour: 10,
    setupFee: { currency: 'SEK', minor: 0 }, tiers: [{ minQty: 0, unit: { currency: 'SEK', minor: price } }],
    window: { start: T0, end: iso(Date.parse(T0) + feasibleWindowH * H) }, handoffHours: 0,
    validUntil: iso(Date.parse(T0) + 999 * H), negotiable: family === 'impossible' ? [] : ['windowEnd'],
    provenance: { source: 'synthetic-market', observedAt: T0 }, claims: [],
  });
  const world: World = {
    id: `w${seed}`, version: 1, seed, name: 'fake', currency: 'SEK',
    stages: [{ id: 's', name: 'S', unit: 'u', after: [], perOutcome: 1 }],
    actors: ['a', 'b'].map((id) => ({ id, name: id, kind: 'supplier' as const, city: 'x', description: '', active: true })),
    offers: [mk('oa', 'a', 100), mk('ob', 'b', 120)], claims: [], family, createdAt: T0,
  };
  const intent: Intent = {
    id: 'i', text: 't', quantity: 100, budget: { currency: 'SEK', minor: 100_000 }, deadline: iso(Date.parse(T0) + 24 * H),
    deliverTo: 'x', negotiable: {}, authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: { currency: 'SEK', minor: 100_000 } },
    provenance: { source: 'buyer', observedAt: T0 },
  };
  const truth = {
    policies: { a: { maxExtendH: 12 }, b: { maxExtendH: 2 } } as Record<string, unknown>,
    realCapacity: { oa: cap, ob: cap }, shocks: [{ id: 'sh', kind: 'withdraw' as const, actor: 'a', detail: 'x', at: T0 }],
  };
  return { world, intent, truth };
}

function planFor(world: World, intent: Intent, o: Offer): Plan | null {
  const qty = intent.quantity;
  const start = Date.parse(o.window.start);
  const end = start + (qty / o.ratePerHour) * H;
  if (qty > o.capacity || end > Date.parse(o.window.end) || end > Date.parse(intent.deadline)) return null;
  const cost = (o.tiers[0]?.unit.minor ?? 0) * qty;
  if (cost > intent.budget.minor) return null;
  const a: Allocation = { offer: o.id, actor: o.actor, stage: o.stage, qty, start: iso(start), finish: iso(end), cost: { currency: 'SEK', minor: cost } };
  return { id: 'p', worldVersion: world.version, intent: intent.id, allocations: [a], total: a.cost, readyAt: a.finish, objective: 'cost' };
}

export function fakeDeps(opts: { lie?: boolean } = {}): Deps {
  const solve = async (world: World, intent: Intent): Promise<SolveReport> => {
    const plans = world.offers.map((o) => planFor(world, intent, o)).filter((p): p is Plan => !!p).sort((a, b) => a.total.minor - b.total.minor);
    const plan = plans[0];
    const solver = { name: 'fake', version: '0', ms: 1 };
    if (opts.lie) {
      const o = world.offers[0] as Offer;
      const a = { offer: o.id, actor: o.actor, stage: o.stage, qty: intent.quantity, start: T0, finish: T0, cost: { currency: 'SEK' as const, minor: 1 } };
      return { status: 'feasible', solver, plan: { id: 'lie', worldVersion: 1, intent: intent.id, allocations: [a], total: a.cost, readyAt: T0, objective: 'x' } };
    }
    return plan ? { status: 'optimal', solver, plan } : { status: 'infeasible', solver };
  };
  const conc = (o: Offer): Concession => ({
    id: `c-${o.id}`, target: { kind: 'offer', offer: o.id, field: 'windowEnd' }, from: o.window.end,
    to: iso(Date.parse(o.window.end) + 12 * H), estimate: { currency: 'SEK', minor: 10 }, rationale: 'extend',
  });
  return {
    market: { generateWorld: fakeGenerate, flagshipWorld: () => fakeGenerate(1, 'salvageable') },
    solver: {
      solve,
      async findInterventions(world) {
        return world.offers.filter((o) => o.negotiable.includes('windowEnd')).map((o): Intervention => ({
          id: `iv-${o.id}`, concessions: [conc(o)], unlocks: true, totalAfter: { currency: 'SEK', minor: (o.tiers[0]?.unit.minor ?? 0) * 100 },
          method: 'exhaustive', minimality: 'fake',
        }));
      },
      applyConcessions(world, intent, cs) {
        const offers = world.offers.map((o) => {
          const c = cs.find((x) => x.target.kind === 'offer' && x.target.offer === o.id && x.target.field === 'windowEnd');
          return c ? { ...o, window: { ...o.window, end: String(c.to) } } : o;
        });
        return { world: { ...world, offers }, intent };
      },
      verifyPlan(plan, world, intent) {
        const o = world.offers.find((x) => x.id === plan.allocations[0]?.offer);
        const ok = !!o && !!planFor(world, intent, o);
        return { ok, checks: [{ id: 'all', ok, text: 'fake' }] };
      },
    },
    negotiation: {
      selectQuestions(_w, _i, ivs, budget) {
        return ivs.flatMap((iv) => iv.concessions).slice(0, budget).map((c) => ({
          voi: 1,
          message: { type: 'Propose', id: `q-${c.id}`, from: 'buyer', to: c.target.kind === 'offer' ? (c.target.offer === 'oa' ? 'a' : 'b') : 'x', concession: c, expires: T0, at: T0 } as NegotiationMessage,
        }));
      },
      decide(msg, policy) {
        const c = msg.type === 'Propose' ? msg.concession : null;
        const hrs = c ? (Date.parse(String(c.to)) - Date.parse(String(c.from))) / H : 0;
        const accept = hrs <= (policy as { maxExtendH: number }).maxExtendH;
        return { message: msg.id, accept, basis: 'synthetic-policy', reason: accept ? 'ok' : 'no' };
      },
      challengeClaims: () => [],
    },
    obligations: {
      commit(plan) {
        return {
          id: 'ag', version: 1, intent: plan.intent, plan: plan.id, parties: [], state: 'COMMITTED', termsHash: 'h', acceptances: [], createdAt: T0,
          obligations: plan.allocations.map((a) => ({ id: `ob-${a.offer}`, agreement: 'ag', actor: a.actor, offer: a.offer, stage: a.stage, qty: a.qty, start: a.start, due: a.finish, amount: a.cost, state: 'ACTIVE' as const })),
        };
      },
      disrupt(ag, world, d) {
        return { affected: ag.obligations.filter((o) => o.actor === d.actor), world };
      },
      async recover() {
        return { id: 'r', disruption: 'sh', feasible: true, kept: [], amended: [], cancelled: [], added: [], extraCost: { currency: 'SEK', minor: 0 }, slipHours: 0, rejected: [] };
      },
    },
  };
}
