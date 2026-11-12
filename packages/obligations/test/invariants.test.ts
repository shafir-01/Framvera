import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Agreement, Allocation, Disruption, Offer, PaymentIntent, Stage, World } from '@framvera/contracts';
import { commit, reservations } from '../src/agreement.ts';
import { Ledger, record } from '../src/ledger.ts';
import { allocationCost, earliestSlot } from '../src/model.ts';
import { apply, refundable, type PaymentEvent } from '../src/payment.ts';
import { disrupt } from '../src/disrupt.ts';
import { recover } from '../src/recover.ts';
import { ObligationError, iso, ms } from '../src/util.ts';
import { acceptAll, intent as baseIntent, offer, payment, planOf } from './fixture.ts';

const BASE = Date.parse('2026-11-16T06:00:00.000Z');
const H = 3_600_000;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

const offerArb = fc.record({
  capacity: fc.integer({ min: 50, max: 800 }),
  rate: fc.integer({ min: 20, max: 200 }),
  price: fc.integer({ min: 5, max: 50 }),
  minQty: fc.integer({ min: 0, max: 150 }),
  startH: fc.integer({ min: 0, max: 24 }),
  lenH: fc.integer({ min: 12, max: 96 }),
  handoff: fc.integer({ min: 0, max: 6 }),
});

const scenarioArb = fc.record({
  stages: fc.integer({ min: 1, max: 3 }),
  offers: fc.array(fc.array(offerArb, { minLength: 2, maxLength: 4 }), { minLength: 3, maxLength: 3 }),
  quantity: fc.integer({ min: 50, max: 400 }),
  slackH: fc.integer({ min: 0, max: 48 }),
  budgetPct: fc.integer({ min: 0, max: 60 }),
  kind: fc.constantFrom<Disruption['kind']>('withdraw', 'capacity-drop', 'delay', 'price-change'),
  target: fc.nat(),
  capacity: fc.integer({ min: 0, max: 400 }),
  delayH: fc.integer({ min: 1, max: 60 }),
  pricePct: fc.integer({ min: 1, max: 100 }),
  reserve: fc.array(fc.integer({ min: 0, max: 300 }), { minLength: 12, maxLength: 12 }),
});

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

function build(s: Scenario) {
  const stages: Stage[] = Array.from({ length: s.stages }, (_, i) => ({ id: `s${i}`, name: `Stage ${i}`, unit: 'units', after: i ? [`s${i - 1}`] : [], perOutcome: 1 }));
  const offers: Offer[] = [];
  stages.forEach((st, i) =>
    s.offers[i]!.forEach((o, j) =>
      offers.push(
        offer(
          {
            id: `o${i}${j}`,
            actor: `a${i}${j}`,
            stage: st.id,
            capacity: o.capacity,
            ratePerHour: o.rate,
            minQty: o.minQty,
            handoffHours: o.handoff,
            window: { start: iso(BASE + o.startH * H), end: iso(BASE + (o.startH + o.lenH) * H) },
          },
          o.price,
        ),
      ),
    ),
  );
  const world: World = {
    id: 'pw',
    version: 1,
    seed: 0,
    name: 'generated',
    currency: 'SEK',
    stages,
    actors: offers.map((o) => ({ id: o.actor, name: o.actor, kind: 'supplier', city: 'Stockholm', description: '', active: true })),
    offers,
    claims: [],
    family: 'feasible',
    createdAt: iso(BASE),
  };
  const allocs: Allocation[] = [];
  for (const st of stages) {
    const ready = Math.max(-8.64e15, ...allocs.filter((a) => st.after.includes(a.stage)).map((a) => ms(a.finish)));
    const pick = offers
      .filter((o) => o.stage === st.id && o.capacity >= s.quantity && o.minQty <= s.quantity && earliestSlot(o, s.quantity, ready))
      .sort((a, b) => allocationCost(a, s.quantity).minor - allocationCost(b, s.quantity).minor)[0];
    if (!pick) return null;
    const slot = earliestSlot(pick, s.quantity, ready)!;
    allocs.push({ offer: pick.id, actor: pick.actor, stage: st.id, qty: s.quantity, start: iso(slot.start), finish: iso(slot.finish), cost: allocationCost(pick, s.quantity) });
  }
  const plan = planOf(world, allocs);
  const finals = allocs.filter((a) => a.stage === stages[stages.length - 1]!.id);
  plan.readyAt = iso(Math.max(...finals.map((a) => ms(a.finish))));
  const total = plan.total.minor;
  const intent = baseIntent({
    quantity: s.quantity,
    deadline: iso(ms(plan.readyAt) + s.slackH * H),
    budget: { currency: 'SEK', minor: Math.round(total * (1 + s.budgetPct / 100)) },
  });
  intent.authority = { ...intent.authority, maxSpend: intent.budget };
  const reserved = new Map<string, number>();
  offers.forEach((o, i) => {
    if (!allocs.some((a) => a.offer === o.id)) reserved.set(o.id, Math.min(o.capacity, s.reserve[i % 12]!));
  });
  const used = allocs[s.target % allocs.length]!;
  const d: Disruption = {
    id: 'pd',
    kind: s.kind,
    offer: used.offer,
    actor: used.actor,
    detail: '',
    at: iso(BASE - H),
    ...{ params: { capacity: s.capacity, delayHours: s.delayH, pricePercent: s.pricePct } },
  } as Disruption;
  return { world, plan, intent, reserved, d };
}

describe('invariants (property-based)', () => {
  const stats = { changed: 0, untouched: 0, infeasible: 0 };
  it('recovery never over-allocates, breaks budget or deadline, or changes unaffected accepted obligations', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const b = build(s);
        fc.pre(b !== null);
        const { world, plan, intent, reserved, d } = b!;
        const agreement = commit(plan, intent, acceptAll(plan, intent));
        expect(agreement.state).toBe('COMMITTED');
        deepFreeze(agreement);
        deepFreeze(world);
        const before = JSON.stringify([agreement, world]);
        const r = await recover(agreement, world, intent, d, { solver: null, reservedElsewhere: reserved });
        expect(JSON.stringify([agreement, world])).toBe(before);
        stats[r.feasible ? (r.amended.length + r.cancelled.length ? 'changed' : 'untouched') : 'infeasible']++;

        const seen = disrupt(agreement, world, d, { reservedElsewhere: reserved });
        const affected = new Set(seen.affected.map((o) => o.id));
        const movable = new Set([...affected, ...seen.atRisk.map((o) => o.id)]);
        for (const k of r.kept) expect(affected.has(k)).toBe(false);
        for (const id of [...r.amended, ...r.cancelled]) expect(movable.has(id)).toBe(true);
        const replay = await recover(agreement, r.world, intent, d, { solver: null, reservedElsewhere: reserved });
        expect([replay.feasible, replay.kept, replay.amended, replay.cancelled]).toEqual([r.feasible, r.kept, r.amended, r.cancelled]);

        const all = agreement.obligations.map((o) => o.id);
        const failed = new Set([...r.impact.failed, ...r.impact.mustChange]);
        const flexible = new Set([...failed, ...r.impact.atRisk]);
        for (const k of r.kept) expect(failed.has(k)).toBe(false);
        for (const id of [...r.amended, ...r.cancelled]) expect(flexible.has(id)).toBe(true);
        if (!r.feasible) return;
        expect([...r.kept, ...r.amended, ...r.cancelled].sort()).toEqual([...all].sort());
        for (const id of all) if (!flexible.has(id)) expect(r.kept).toContain(id);

        const allocs = r.plan!.allocations;
        const use = new Map<string, number>();
        for (const a of allocs) use.set(a.offer, (use.get(a.offer) ?? 0) + a.qty);
        for (const [id, q] of use) {
          const o = r.world.offers.find((x) => x.id === id);
          expect(o).toBeDefined();
          expect(q + (reserved.get(id) ?? 0)).toBeLessThanOrEqual(o!.capacity);
        }
        for (const st of world.stages) expect(allocs.filter((a) => a.stage === st.id).reduce((x, a) => x + a.qty, 0)).toBeGreaterThanOrEqual(intent.quantity);
        expect(allocs.reduce((x, a) => x + a.cost.minor, 0)).toBeLessThanOrEqual(intent.budget.minor);
        expect(ms(r.plan!.readyAt)).toBeLessThanOrEqual(ms(intent.deadline) + 60_000);
        for (const a of allocs) {
          const st = world.stages.find((x) => x.id === a.stage)!;
          for (const p of allocs.filter((x) => st.after.includes(x.stage))) expect(ms(a.start) + 60_000).toBeGreaterThanOrEqual(ms(p.finish));
        }
      }),
      { numRuns: 150 },
    );
    expect(stats.changed).toBeGreaterThan(10);
    expect(stats.infeasible).toBeGreaterThan(0);
  });

  it('commitments never conflict: reserved capacity never exceeds an offer', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ offer: fc.integer({ min: 0, max: 2 }), qty: fc.integer({ min: 1, max: 400 }) }), { minLength: 1, maxLength: 12 }), (orders) => {
        const s = build({
          stages: 1,
          offers: [[0, 1, 2].map(() => ({ capacity: 500, rate: 200, price: 10, minQty: 0, startH: 0, lenH: 96, handoff: 0 })), [], []],
          quantity: 1,
          slackH: 48,
          budgetPct: 0,
          kind: 'withdraw',
          target: 0,
          capacity: 0,
          delayH: 1,
          pricePct: 1,
          reserve: Array(12).fill(0),
        })!;
        const agreements: Agreement[] = [];
        orders.forEach((o, n) => {
          const of = s.world.offers[o.offer]!;
          const slot = earliestSlot(of, o.qty, -8.64e15)!;
          const plan = planOf(s.world, [{ offer: of.id, actor: of.actor, stage: of.stage, qty: o.qty, start: iso(slot.start), finish: iso(slot.finish), cost: allocationCost(of, o.qty) }], `p${n}`);
          const i = baseIntent({ quantity: o.qty });
          try {
            agreements.push(commit(plan, i, acceptAll(plan, i), { world: s.world, reserved: reservations(agreements) }));
          } catch (e) {
            expect((e as ObligationError).code).toBe('over-allocation');
          }
        });
        for (const [id, q] of reservations(agreements)) expect(q).toBeLessThanOrEqual(s.world.offers.find((o) => o.id === id)!.capacity);
      }),
      { numRuns: 200 },
    );
  });

  it('commit refuses any plan above the budget', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), (budget) => {
        const s = build({
          stages: 1,
          offers: [[{ capacity: 500, rate: 200, price: 10, minQty: 0, startH: 0, lenH: 96, handoff: 0 }, { capacity: 500, rate: 200, price: 12, minQty: 0, startH: 0, lenH: 96, handoff: 0 }], [], []],
          quantity: 300,
          slackH: 0,
          budgetPct: 0,
          kind: 'withdraw',
          target: 0,
          capacity: 0,
          delayH: 1,
          pricePct: 1,
          reserve: Array(12).fill(0),
        })!;
        const i = baseIntent({ quantity: 300, budget: { currency: 'SEK', minor: budget } });
        const ok = s.plan.total.minor <= budget;
        if (ok) expect(commit(s.plan, i, acceptAll(s.plan, i)).state).toBe('COMMITTED');
        else expect(() => commit(s.plan, i, acceptAll(s.plan, i))).toThrow(/budget/);
      }),
    );
  });

  const SEK = (minor: number) => ({ currency: 'SEK' as const, minor });
  const eventArb: fc.Arbitrary<PaymentEvent> = fc.oneof(
    fc.constant<PaymentEvent>({ type: 'ORDER_CREATED', orderId: 'O1' }),
    fc.constant<PaymentEvent>({ type: 'APPROVED' }),
    fc.constant<PaymentEvent>({ type: 'CAPTURE_REQUESTED' }),
    fc.constantFrom('C1', 'C2').map<PaymentEvent>((id) => ({ type: 'CAPTURE_COMPLETED', captureId: id, amount: SEK(1_000_000) })),
    fc.constant<PaymentEvent>({ type: 'CAPTURE_DENIED' }),
    fc.constantFrom<'create' | 'capture' | 'refund'>('create', 'capture', 'refund').map<PaymentEvent>((op) => ({ type: 'TIMEOUT', operation: op })),
    fc.constant<PaymentEvent>({ type: 'VOID' }),
    fc.record({ k: fc.nat({ max: 5 }), m: fc.integer({ min: -10, max: 1_200_000 }) }).map<PaymentEvent>(({ k, m }) => ({ type: 'REFUND_REQUESTED', operationKey: `r${k}`, amount: SEK(m) })),
    fc.record({ k: fc.nat({ max: 5 }), m: fc.integer({ min: 1, max: 1_200_000 }) }).map<PaymentEvent>(({ k, m }) => ({ type: 'REFUND_COMPLETED', refundId: `R${k}`, operationKey: `r${k}`, amount: SEK(m) })),
    fc.constant<PaymentEvent>({ type: 'REFUND_DENIED' }),
    fc.record({ c: fc.boolean(), st: fc.constantFrom('COMPLETED', 'PENDING', 'DECLINED') }).map<PaymentEvent>(({ c, st }) => ({
      type: 'RECONCILED',
      orderStatus: 'APPROVED',
      ...(c ? { capture: { id: 'C1', status: st, amount: SEK(1_000_000) } } : {}),
    })),
  );

  it('refunds stay within captured minus refunded and a capture id never changes', () => {
    const base = (() => {
      const s = build({
        stages: 1,
        offers: [[{ capacity: 600, rate: 200, price: 20, minQty: 0, startH: 0, lenH: 96, handoff: 0 }, { capacity: 600, rate: 200, price: 30, minQty: 0, startH: 0, lenH: 96, handoff: 0 }], [], []],
        quantity: 500,
        slackH: 0,
        budgetPct: 0,
        kind: 'withdraw',
        target: 0,
        capacity: 0,
        delayH: 1,
        pricePct: 1,
        reserve: Array(12).fill(0),
      })!;
      const a = commit(s.plan, baseIntent({ quantity: 500 }), acceptAll(s.plan, baseIntent({ quantity: 500 })));
      return payment(a, a.obligations[0]!.actor, 'PAYMENT_PROPOSED');
    })();
    expect(base.charged.minor).toBe(1_000_000);
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        let pi: PaymentIntent = base;
        let capture: string | undefined;
        for (const e of events) {
          const r = apply(pi, e);
          if (!r.ok) continue;
          pi = r.pi;
          if (capture) expect(pi.paypal.captureId).toBe(capture);
          capture = pi.paypal.captureId ?? capture;
          const done = pi.paypal.refunds.filter((x) => x.status === 'COMPLETED').reduce((s, x) => s + x.amount.minor, 0);
          expect(done).toBeLessThanOrEqual(pi.paypal.captureId ? pi.charged.minor : 0);
          expect(refundable(pi)).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a timeout can never lead to a second charge', () => {
    const start: PaymentIntent = { ...payment({ id: 'agr', obligations: [] } as unknown as Agreement, 'x', 'PAYMENT_PROPOSED'), charged: SEK(500), amount: SEK(500) };
    fc.assert(
      fc.property(fc.array(fc.record({ action: fc.constantFrom('capture', 'reconcile'), reached: fc.boolean(), timeout: fc.boolean() }), { maxLength: 30 }), (steps) => {
        const gateway: string[] = [];
        let pi = (apply(start, { type: 'ORDER_CREATED', orderId: 'O' }) as { pi: PaymentIntent }).pi;
        pi = (apply(pi, { type: 'APPROVED' }) as { pi: PaymentIntent }).pi;
        for (const st of steps) {
          if (st.action === 'capture') {
            const r = apply(pi, { type: 'CAPTURE_REQUESTED' });
            if (!r.ok) continue;
            pi = r.pi;
            if (st.reached) gateway.push(`C${gateway.length + 1}`);
            if (st.timeout || !st.reached) pi = (apply(pi, { type: 'TIMEOUT', operation: 'capture' }) as { pi: PaymentIntent }).pi;
            else pi = (apply(pi, { type: 'CAPTURE_COMPLETED', captureId: gateway[0]!, amount: SEK(500) }) as { pi: PaymentIntent }).pi;
          } else {
            const truth: PaymentEvent = gateway.length
              ? { type: 'RECONCILED', orderStatus: 'COMPLETED', capture: { id: gateway[0]!, status: 'COMPLETED', amount: SEK(500) } }
              : { type: 'RECONCILED', orderStatus: 'APPROVED' };
            const r = apply(pi, truth);
            if (r.ok) pi = r.pi;
          }
          expect(gateway.length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('branches cannot mutate committed state', () => {
    const s = build({
      stages: 2,
      offers: [[{ capacity: 600, rate: 200, price: 20, minQty: 0, startH: 0, lenH: 96, handoff: 1 }, { capacity: 600, rate: 100, price: 25, minQty: 0, startH: 0, lenH: 96, handoff: 1 }], [{ capacity: 600, rate: 200, price: 20, minQty: 0, startH: 0, lenH: 96, handoff: 1 }, { capacity: 600, rate: 100, price: 25, minQty: 0, startH: 0, lenH: 96, handoff: 1 }], []],
      quantity: 300,
      slackH: 24,
      budgetPct: 20,
      kind: 'withdraw',
      target: 0,
      capacity: 0,
      delayH: 1,
      pricePct: 1,
      reserve: Array(12).fill(0),
    })!;
    const agreement = commit(s.plan, s.intent, acceptAll(s.plan, s.intent));
    const ledger = new Ledger();
    record.agreement(ledger, 'm', agreement);
    const head = ledger.events('m');
    const state = JSON.stringify(ledger.state('m'));
    fc.assert(
      fc.property(fc.array(fc.record({ ob: fc.nat({ max: 1 }), to: fc.constantFrom('AT_RISK', 'BREACHED', 'FULFILLED', 'CANCELLED', 'REPLACED') }), { maxLength: 8 }), (moves) => {
        const branch = ledger.branch('m');
        for (const [n, m] of moves.entries()) {
          const ob = branch.state().obligations[agreement.obligations[m.ob]!.id]!;
          try {
            branch.append({ id: `b${n}`, market: 'm', type: 'obligation.state', data: { obligation: { ...ob, state: m.to } } });
          } catch (e) {
            expect(e).toBeInstanceOf(ObligationError);
          }
        }
        expect(ledger.events('m')).toEqual(head);
        expect(JSON.stringify(ledger.state('m'))).toBe(state);
      }),
      { numRuns: 100 },
    );
  });
});
