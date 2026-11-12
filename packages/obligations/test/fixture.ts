import type { Actor, Agreement, Allocation, Intent, Offer, PaymentIntent, Plan, SolveReport, Stage, World } from '@framvera/contracts';
import { acceptMessage, commit, proposeAgreement, type AcceptanceInput } from '../src/agreement.ts';
import { allocationCost, earliestSlot } from '../src/model.ts';
import type { SolverLike } from '../src/recover.ts';
import { iso, ms } from '../src/util.ts';

export const T = (s: string) => `2026-11-${s}:00.000Z`;
const MON = '16';
const TUE = '17';

const stages: Stage[] = [
  { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 1 },
  { id: 'assemble', name: 'Assemble kits', unit: 'kits', after: ['print'], perOutcome: 1 },
  { id: 'deliver', name: 'Deliver kits', unit: 'kits', after: ['assemble'], perOutcome: 1 },
];

const actor = (id: string, name: string): Actor => ({ id, name, kind: 'supplier', city: 'Stockholm', description: '', active: true });

export function offer(p: Partial<Offer> & Pick<Offer, 'id' | 'actor' | 'stage'>, priceKr: number): Offer {
  return {
    version: 1,
    capacity: 600,
    minQty: 0,
    ratePerHour: 100,
    setupFee: { currency: 'SEK', minor: 0 },
    tiers: [{ minQty: 0, unit: { currency: 'SEK', minor: priceKr * 100 } }],
    window: { start: T(`${MON}T06:00`), end: T('20T23:00') },
    handoffHours: 2,
    validUntil: T('30T00:00'),
    negotiable: [],
    provenance: { source: 'synthetic-market', observedAt: T(`${MON}T00:00`) },
    claims: [],
    ...p,
  };
}

export function world(): World {
  return {
    id: 'w1',
    version: 1,
    seed: 1,
    name: 'Promotional kits, Stockholm',
    currency: 'SEK',
    stages,
    actors: [
      actor('sP1', 'Söder Print'),
      actor('sP2', 'Kista Print'),
      actor('sP3', 'Solna Print'),
      actor('sA1', 'Kista Pack'),
      actor('sA2', 'Haga Pack'),
      actor('sD1', 'City Courier'),
      actor('sD2', 'North Freight'),
    ],
    offers: [
      offer({ id: 'oP1', actor: 'sP1', stage: 'print', window: { start: T(`${MON}T08:00`), end: T('18T18:00') }, claims: ['c1'] }, 20),
      offer({ id: 'oP2', actor: 'sP2', stage: 'print', capacity: 500, ratePerHour: 50 }, 25),
      offer({ id: 'oP3', actor: 'sP3', stage: 'print', capacity: 300, minQty: 100 }, 18),
      offer({ id: 'oA1', actor: 'sA1', stage: 'assemble', window: { start: T(`${TUE}T08:00`), end: T('19T18:00') }, handoffHours: 1 }, 30),
      offer({ id: 'oA2', actor: 'sA2', stage: 'assemble', ratePerHour: 60, window: { start: T(`${TUE}T08:00`), end: T('19T18:00') }, handoffHours: 1 }, 26),
      offer({ id: 'oD1', actor: 'sD1', stage: 'deliver', capacity: 1000, ratePerHour: 500, handoffHours: 4 }, 5),
      offer({ id: 'oD2', actor: 'sD2', stage: 'deliver', capacity: 1000, ratePerHour: 500, handoffHours: 4 }, 6),
    ],
    claims: [
      {
        id: 'c1',
        actor: 'sP1',
        subject: 'capacity:oP1',
        assertion: 'Can print 600 inserts by Wednesday',
        value: 600,
        tier: 'single-claim',
        provenance: { source: 'synthetic-market', observedAt: T(`${MON}T00:00`) },
      },
    ],
    family: 'salvageable',
    createdAt: T(`${MON}T00:00`),
  };
}

export function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i1',
    text: '500 promotional kits by Friday under 30,000 kr',
    quantity: 500,
    budget: { currency: 'SEK', minor: 3_000_000 },
    deadline: T('20T12:00'),
    deliverTo: 'Stockholm',
    negotiable: { deadlineHours: 24 },
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: { currency: 'SEK', minor: 3_000_000 } },
    provenance: { source: 'buyer', observedAt: T(`${MON}T00:00`) },
    ...over,
  };
}

/** Schedules a chain of (offer, qty) picks stage by stage at the earliest moment. */
export function schedule(w: World, picks: { offer: string; qty: number }[], notBefore = -8.64e15): Allocation[] {
  const out: Allocation[] = [];
  for (const stage of w.stages) {
    const predReady = Math.max(notBefore, ...out.filter((a) => stage.after.includes(a.stage)).map((a) => ms(a.finish)));
    for (const p of picks) {
      const o = w.offers.find((x) => x.id === p.offer)!;
      if (o.stage !== stage.id) continue;
      const slot = earliestSlot(o, p.qty, predReady);
      if (!slot) throw new Error(`no slot for ${p.offer}`);
      out.push({ offer: o.id, actor: o.actor, stage: o.stage, qty: p.qty, start: iso(slot.start), finish: iso(slot.finish), cost: allocationCost(o, p.qty) });
    }
  }
  return out;
}

export function planOf(w: World, allocations: Allocation[], id = 'p1'): Plan {
  const total = allocations.reduce((s, a) => s + a.cost.minor, 0);
  const feeders = new Set(w.stages.flatMap((s) => s.after));
  const finals = allocations.filter((a) => !feeders.has(a.stage)).map((a) => ms(a.finish));
  return { id, worldVersion: w.version, intent: 'i1', allocations, total: { currency: 'SEK', minor: total }, readyAt: iso(Math.max(...finals)), objective: 'cost' };
}

/** P1 prints 500, A1 assembles from Tuesday 08:00, D1 delivers. */
export function basePlan(w = world()): Plan {
  return planOf(
    w,
    schedule(w, [
      { offer: 'oP1', qty: 500 },
      { offer: 'oA1', qty: 500 },
      { offer: 'oD1', qty: 500 },
    ]),
  );
}

/** A deterministic stand-in solver for tests: returns given plans per objective. */
export function fakeSolver(plans: { cost?: (w: World) => Allocation[] | null; repair?: (w: World, fixed: Allocation[]) => Allocation[] | null }): SolverLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async solve(w, _i, opts) {
      const objective = opts?.objective ?? 'cost';
      calls.push(objective);
      const fn = objective === 'repair' ? plans.repair : plans.cost;
      const allocs = fn ? (objective === 'repair' ? (fn as (w: World, f: Allocation[]) => Allocation[] | null)(w, opts?.fixed ?? []) : (fn as (w: World) => Allocation[] | null)(w)) : null;
      const report: SolveReport = allocs
        ? { status: 'optimal', solver: { name: 'test', version: '0', ms: 0 }, plan: planOf(w, allocs, `fake-${objective}`) }
        : { status: 'infeasible', solver: { name: 'test', version: '0', ms: 0 } };
      return report;
    },
  };
}

export function acceptAll(plan: Plan, i = intent()): AcceptanceInput[] {
  const draft = proposeAgreement(plan, i);
  return draft.parties.map((p) => ({ ...acceptMessage(draft, p, `m-${p}`, i.provenance.observedAt), basis: p === 'buyer' ? ('buyer' as const) : ('synthetic-policy' as const) }));
}

export function committed(): { agreement: Agreement; plan: Plan } {
  const plan = basePlan();
  const agreement = commit(plan, intent(), acceptAll(plan));
  return { agreement, plan };
}

export function payment(a: Agreement, payee: string, state: PaymentIntent['state']): PaymentIntent {
  const obs = a.obligations.filter((o) => o.actor === payee);
  const amount = { currency: 'SEK' as const, minor: obs.reduce((s, o) => s + o.amount.minor, 0) };
  const captured = ['CAPTURE_COMPLETED', 'REFUND_COMPLETED', 'REFUND_DENIED'].includes(state);
  return {
    id: `pay-${payee}`,
    operationKey: `op-${payee}`,
    agreement: a.id,
    obligations: obs.map((o) => o.id),
    payee,
    amount,
    charged: amount,
    state,
    paypal: { env: 'sandbox', ...(state === 'PAYMENT_PROPOSED' ? {} : { orderId: 'ORDER1' }), ...(captured ? { captureId: 'CAP1' } : {}), refunds: [], debugIds: [] },
  };
}

