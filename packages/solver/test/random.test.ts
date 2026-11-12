import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Intent, NegotiableField, Offer, Stage, World } from '@framvera/contracts';
import { cheapestCover } from '../src/compile.ts';
import { applyConcessions, explainInfeasible, findInterventions, solve, verifyPlan } from '../src/index.ts';
import { statusWith } from './helpers.ts';
import { NOW, offer } from './fixtures.ts';

const FIELDS: NegotiableField[] = ['unitPrice', 'windowEnd', 'windowStart', 'capacity', 'minQty', 'setupFee'];

const offerArb = fc.record({
  capacity: fc.integer({ min: 20, max: 600 }),
  minQty: fc.integer({ min: 0, max: 250 }),
  rate: fc.integer({ min: 5, max: 200 }),
  setup: fc.integer({ min: 0, max: 4000 }),
  price: fc.integer({ min: 1, max: 60 }),
  breakAt: fc.option(fc.integer({ min: 50, max: 500 }), { nil: undefined }),
  startDay: fc.integer({ min: 0, max: 2 }),
  startHour: fc.integer({ min: 0, max: 23 }),
  length: fc.integer({ min: 4, max: 80 }),
  handoff: fc.integer({ min: 0, max: 8 }),
  negotiable: fc.subarray(FIELDS, { maxLength: 3 }),
});

const worldArb = fc
  .record({
    stageCount: fc.integer({ min: 1, max: 3 }),
    perOutcome: fc.array(fc.constantFrom(1, 2), { minLength: 3, maxLength: 3 }),
    offers: fc.array(fc.array(offerArb, { minLength: 1, maxLength: 3 }), { minLength: 3, maxLength: 3 }),
    quantity: fc.integer({ min: 10, max: 400 }),
    budgetKr: fc.integer({ min: 500, max: 120000 }),
    deadlineHours: fc.integer({ min: 12, max: 140 }),
    bendHours: fc.integer({ min: 0, max: 48 }),
  })
  .map(({ stageCount, perOutcome, offers, quantity, budgetKr, deadlineHours, bendHours }) => {
    const stages: Stage[] = Array.from({ length: stageCount }, (_, i) => ({
      id: `s${i}`,
      name: `Stage ${i}`,
      unit: 'units',
      after: i === 0 ? [] : [`s${i - 1}`],
      perOutcome: perOutcome[i]!,
    }));
    const all: Offer[] = [];
    stages.forEach((s, si) =>
      offers[si]!.forEach((o, oi) => {
        const end = new Date(Date.UTC(2026, 10, 16 + o.startDay, o.startHour) + o.length * 3_600_000);
        const tiers: [number, number][] = o.breakAt ? [[0, o.price], [o.breakAt, Math.max(1, o.price - 3)]] : [[0, o.price]];
        all.push({
          ...offer({
            id: `o${si}-${oi}`,
            actor: `a${si}-${oi}`,
            stage: s.id,
            capacity: o.capacity,
            minQty: o.minQty,
            rate: o.rate,
            setup: o.setup,
            tiers,
            window: [o.startDay, o.startHour, 0, 0],
            handoff: o.handoff,
            negotiable: o.negotiable,
          }),
          window: { start: new Date(Date.UTC(2026, 10, 16 + o.startDay, o.startHour)).toISOString(), end: end.toISOString() },
        });
      }),
    );
    const world: World = {
      id: 'w-rand',
      version: 1,
      seed: 0,
      name: 'random',
      currency: 'SEK',
      stages,
      actors: all.map((o) => ({ id: o.actor, name: `Supplier ${o.actor}`, kind: 'supplier', city: 'Stockholm', description: '', active: true })),
      offers: all,
      claims: [],
      family: 'random',
      createdAt: NOW,
    };
    const intent: Intent = {
      id: 'i-rand',
      text: 'random',
      quantity,
      budget: { currency: 'SEK', minor: budgetKr * 100 },
      deadline: new Date(Date.parse(NOW) + deadlineHours * 3_600_000).toISOString(),
      deliverTo: 'Stockholm',
      negotiable: bendHours ? { deadlineHours: bendHours } : {},
      authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: { currency: 'SEK', minor: budgetKr * 100 } },
      provenance: { source: 'buyer', observedAt: NOW },
    };
    return { world, intent };
  });

describe('random worlds', () => {
  it('every plan the solver returns passes the independent check', async () => {
    let feasible = 0;
    let infeasible = 0;
    await fc.assert(
      fc.asyncProperty(worldArb, async ({ world, intent }) => {
        const r = await solve(world, intent, { explain: false });
        expect(['optimal', 'infeasible']).toContain(r.status);
        if (r.plan) {
          feasible++;
          const v = verifyPlan(r.plan, world, intent);
          expect(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok))).toBe(true);
        } else infeasible++;
      }),
      { numRuns: 150, seed: 7 },
    );
    expect(feasible).toBeGreaterThan(10);
    expect(infeasible).toBeGreaterThan(10);
  }, 120000);

  it('every infeasible core is proven and minimal', async () => {
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(worldArb, async ({ world, intent }) => {
        const core = await explainInfeasible(world, intent);
        if (!core.proven) return;
        checked++;
        expect(core.minimal).toBe(true);
        const ids = new Set(core.constraints.map((x) => x.id));
        const status = (enabled: Set<string>) => statusWith(world, intent, enabled);
        expect(await status(ids)).toBe('infeasible');
        for (const id of ids) expect(await status(new Set([...ids].filter((x) => x !== id)))).toBe('optimal');
      }),
      { numRuns: 60, seed: 11 },
    );
    expect(checked).toBeGreaterThan(5);
  }, 180000);

  it('every intervention only touches negotiable fields and is confirmed by a fresh solve', async () => {
    let found = 0;
    await fc.assert(
      fc.asyncProperty(worldArb, async ({ world, intent }) => {
        const ivs = await findInterventions(world, intent, { k: 2 });
        for (const iv of ivs) {
          found++;
          for (const c of iv.concessions) {
            if (c.target.kind === 'offer') {
              const t = c.target;
              expect(world.offers.find((o) => o.id === t.offer)!.negotiable).toContain(t.field);
            } else {
              expect(intentAllowed(intent, c.target.field)).toBe(true);
            }
          }
          const next = applyConcessions(world, intent, iv.concessions);
          const r = await solve(next.world, next.intent, { explain: false });
          expect(r.plan).toBeDefined();
          expect(verifyPlan(r.plan!, next.world, next.intent).ok).toBe(true);
        }
      }),
      { numRuns: 40, seed: 5 },
    );
    expect(found).toBeGreaterThan(3);
  }, 240000);
});

function intentAllowed(intent: Intent, field: 'deadline' | 'budget'): boolean {
  return field === 'deadline' ? (intent.negotiable.deadlineHours ?? 0) > 0 : (intent.negotiable.budgetMinor ?? 0) > 0;
}

describe('optimality against brute force', () => {
  it('matches exhaustive search on small single-stage worlds', async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async ({ world, intent }) => {
        const w: World = { ...world, stages: [{ ...world.stages[0]!, after: [] }], offers: world.offers.filter((o) => o.stage === 's0').slice(0, 2) };
        const i: Intent = { ...intent, quantity: Math.min(intent.quantity, 120) };
        const r = await solve(w, i, { explain: false });
        const best = bruteForce(w, i);
        if (best === null) expect(r.status).toBe('infeasible');
        else expect(r.plan?.total.minor).toBe(best);
      }),
      { numRuns: 60, seed: 3 },
    );
  }, 120000);
});

function bruteForce(world: World, intent: Intent): number | null {
  const stage = world.stages[0]!;
  const need = Math.ceil(intent.quantity * stage.perOutcome);
  const dl = Date.parse(intent.deadline);
  const options = world.offers.map((o) => {
    const opts: { q: number; cost: number }[] = [{ q: 0, cost: 0 }];
    for (let q = Math.max(1, o.minQty); q <= o.capacity; q++) {
      const start = Date.parse(o.window.start);
      const workEnd = start + (q / o.ratePerHour) * 3_600_000;
      if (workEnd > Date.parse(o.window.end) + 1) break;
      if (workEnd + o.handoffHours * 3_600_000 > dl + 1) break;
      const tiers = o.tiers.slice().sort((a, b) => a.minQty - b.minQty);
      let unit = tiers[0]!.unit.minor;
      for (const t of tiers) if (q >= t.minQty) unit = t.unit.minor;
      opts.push({ q, cost: unit * q + o.setupFee.minor });
    }
    return opts;
  });
  let best: number | null = null;
  const walk = (i: number, q: number, cost: number) => {
    if (i === options.length) {
      if (q >= need && cost <= intent.budget.minor && (best === null || cost < best)) best = cost;
      return;
    }
    for (const o of options[i]!) walk(i + 1, q + o.q, cost + o.cost);
  };
  walk(0, 0, 0);
  return best;
}

describe('stage cost floor', () => {
  it('equals exhaustive search over quantities', () => {
    const optionArb = fc.record({
      minQ: fc.integer({ min: 1, max: 30 }),
      qmax: fc.integer({ min: 1, max: 60 }),
      setup: fc.integer({ min: 0, max: 500 }),
      unit: fc.integer({ min: 1, max: 40 }),
      breakAt: fc.option(fc.integer({ min: 2, max: 50 }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(optionArb, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 80 }), (raw, need) => {
        const options = raw.map((o) => ({
          minQ: o.minQ,
          qmax: o.qmax,
          setup: o.setup,
          tiers: o.breakAt ? [{ minQty: 0, unit: o.unit }, { minQty: o.breakAt, unit: Math.max(1, o.unit - 5) }] : [{ minQty: 0, unit: o.unit }],
        }));
        const price = (o: (typeof options)[number], q: number) => {
          let unit = o.tiers[0]!.unit;
          for (const t of o.tiers) if (q >= t.minQty) unit = t.unit;
          return unit * q + o.setup;
        };
        let best = Infinity;
        const walk = (i: number, got: number, cost: number) => {
          if (i === options.length) {
            if (got >= need) best = Math.min(best, cost);
            return;
          }
          const o = options[i]!;
          walk(i + 1, got, cost);
          for (let q = Math.max(1, o.minQ); q <= o.qmax; q++) walk(i + 1, got + q, cost + price(o, q));
        };
        walk(0, 0, 0);
        expect(cheapestCover(need, options)).toBe(best);
      }),
      { numRuns: 300, seed: 13 },
    );
  });
});

describe('coalition records', () => {
  it('never draw more from a member than its effective capacity, and split payment exactly', async () => {
    const { flagshipWorld } = await import('@framvera/market');
    const { effectiveCapacity } = await import('@framvera/contracts');
    const { synthesizeCoalitions, describeCoalition, deriveOffer } = await import('../src/index.ts');
    const { world, intent } = flagshipWorld();
    const ids = synthesizeCoalitions(world, intent).map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...ids), fc.integer({ min: 1, max: 2000 }), (id, qty) => {
        const c = describeCoalition(world, id, qty)!;
        for (const input of c.inputs) {
          const offer = world.offers.find((o) => o.id === input.offer)!;
          expect(input.qty).toBeLessThanOrEqual(effectiveCapacity(world, offer));
        }
        const joint = deriveOffer(world, id)!;
        const total = c.split.reduce((a, s) => a + s.share.minor, 0);
        expect(total).toBe(joint.setupFee.minor + joint.tiers[0]!.unit.minor * qty);
      }),
      { numRuns: 200, seed: 21 },
    );
  });
});
