import { describe, expect, it } from 'vitest';
import type { Disruption } from '@framvera/contracts';
import { commit, sign } from '../src/agreement.ts';
import { applyDisruption, disrupt } from '../src/disrupt.ts';
import { commitRecovery, recover } from '../src/recover.ts';
import { acceptAll, basePlan, committed, fakeSolver, intent, payment, schedule, T, world } from './fixture.ts';

const D = (p: Partial<Disruption> & Pick<Disruption, 'kind'>): Disruption => ({ id: `d-${p.kind}`, detail: '', at: T('16T06:00'), ...p });

describe('disrupt', () => {
  it('withdrawal breaks the printer obligation and flags dependents as at risk', () => {
    const { agreement } = committed();
    expect(agreement.state).toBe('COMMITTED');
    const r = disrupt(agreement, world(), D({ kind: 'withdraw', actor: 'sP1' }));
    expect(r.failed.map((o) => o.offer)).toEqual(['oP1']);
    expect(r.failed[0]!.state).toBe('BREACHED');
    expect(r.mustChange).toEqual([]);
    expect(r.atRisk.map((o) => o.offer).sort()).toEqual(['oA1', 'oD1']);
    expect(r.world.offers.some((o) => o.id === 'oP1')).toBe(false);
    expect(r.world.actors.find((a) => a.id === 'sP1')!.active).toBe(false);
    expect(r.graph.edges.some((e) => e.kind === 'precedence')).toBe(true);
  });

  it('is idempotent on an already disrupted world', () => {
    const w = world();
    const d = D({ kind: 'delay', offer: 'oA1', detail: 'Assembly line down for 30 hours' });
    const once = applyDisruption(w, d).world;
    const twice = applyDisruption(once, d).world;
    expect(twice.offers.find((o) => o.id === 'oA1')!.handoffHours).toBe(31);
    expect(twice).toBe(once);
  });

  it('a long delay makes the downstream courier provably late', () => {
    const { agreement } = committed();
    const r = disrupt(agreement, world(), D({ kind: 'delay', offer: 'oA1', detail: 'Assembly line down for 30 hours' }));
    expect(r.failed.map((o) => o.offer)).toEqual(['oA1']);
    expect(r.mustChange.map((o) => o.offer)).toEqual(['oD1']);
  });

  it('marks endangered payments', () => {
    const { agreement } = committed();
    const pay = payment(agreement, 'sP1', 'CAPTURE_COMPLETED');
    const r = disrupt(agreement, world(), D({ kind: 'withdraw', actor: 'sP1' }), { payments: [pay] });
    expect(r.endangeredPayments).toEqual([{ payment: pay.id, severity: 'refund-or-void', obligations: [agreement.obligations[0]!.id] }]);
  });
});

describe('recover', () => {
  it('rejects the cheapest global re-plan because it breaks an accepted obligation', async () => {
    const { agreement } = committed();
    const d = D({ kind: 'withdraw', actor: 'sP1', detail: 'Söder Print withdraws' });
    const solver = fakeSolver({
      cost: (w) =>
        schedule(w, [
          { offer: 'oP3', qty: 300 },
          { offer: 'oP2', qty: 200 },
          { offer: 'oA2', qty: 500 },
          { offer: 'oD1', qty: 500 },
        ]),
      repair: () => null,
    });
    const pay = payment(agreement, 'sP1', 'CAPTURE_COMPLETED');
    const r = await recover(agreement, world(), intent(), d, { solver, payments: [pay] });
    expect(solver.calls).toContain('cost');
    expect(r.feasible).toBe(true);
    const scratch = r.candidates.find((c) => c.source === 'solver-scratch')!;
    expect(scratch.permissible).toBe(false);
    expect(scratch.extraCostMinor).toBeLessThan(r.extraCost.minor);
    expect(scratch.reasons.join(' ')).toMatch(/Cancels the accepted obligation of Kista Pack/);
    expect(r.rejected.some((x) => x.description === 'Cheapest new plan from scratch')).toBe(true);
    expect(r.kept.sort()).toEqual([agreement.obligations[1]!.id, agreement.obligations[2]!.id].sort());
    expect(r.cancelled).toEqual([agreement.obligations[0]!.id]);
    expect(r.added.map((a) => a.offer)).toEqual(['oP2']);
    expect(r.extraCost.minor).toBe(500 * 2500 - 500 * 2000);
    expect(r.slipHours).toBe(0);
    expect(r.payments.refunds).toEqual([{ payment: pay.id, operationKey: `refund:${r.id}:${pay.id}`, amount: { currency: 'SEK', minor: 1_000_000 }, reason: expect.any(String) }]);
    expect(r.payments.orders.map((o) => [o.payee, o.amount.minor, o.state])).toEqual([['sP2', 1_250_000, 'PAYMENT_PROPOSED']]);
    expect(r.amendment!.version).toBe(2);
    expect(r.amendment!.state).toBe('PROPOSED');
    expect(agreement.version).toBe(1);
  });

  it('works without a solver and the original plan is a rejected counterfactual', async () => {
    const { agreement } = committed();
    const r = await recover(agreement, world(), intent(), D({ kind: 'withdraw', actor: 'sP1' }), { solver: null });
    expect(r.feasible).toBe(true);
    const original = r.candidates.find((c) => c.source === 'original')!;
    expect(original.permissible).toBe(false);
    expect(r.added.map((a) => a.offer)).toEqual(['oP2']);
  });

  it('capacity drop prefers amending the printer down plus a top-up', async () => {
    const { agreement } = committed();
    const r = await recover(agreement, world(), intent(), D({ kind: 'capacity-drop', offer: 'oP1', detail: 'Capacity falls to 200 inserts' }), { solver: null });
    expect(r.feasible).toBe(true);
    expect(r.amended).toEqual([agreement.obligations[0]!.id]);
    expect(r.replacements[0]!.allocation.qty).toBe(200);
    expect(r.added.map((a) => [a.offer, a.qty])).toEqual([['oP3', 300]]);
  });

  it('price change keeps the supplier at the new price when that is the smallest change', async () => {
    const { agreement } = committed();
    const r = await recover(agreement, world(), intent(), D({ kind: 'price-change', offer: 'oP1', detail: 'Unit price rises to 24 kr' }), { solver: null });
    expect(r.amended).toEqual([agreement.obligations[0]!.id]);
    expect(r.added).toEqual([]);
    expect(r.extraCost.minor).toBe(500 * 400);
  });

  it('delay amends the late assembler and shifts the courier, never touching the printer', async () => {
    const { agreement } = committed();
    const d = D({ kind: 'delay', offer: 'oA1', detail: 'Assembly line down for 30 hours' });
    const r = await recover(agreement, world(), intent(), d, { solver: null });
    expect(r.feasible).toBe(true);
    expect(r.kept).toEqual([agreement.obligations[0]!.id]);
    expect(r.amended.sort()).toEqual([agreement.obligations[1]!.id, agreement.obligations[2]!.id].sort());
    expect(r.slipHours).toBeGreaterThan(0);
    const again = await recover(agreement, applyDisruption(world(), d).world, intent(), d, { solver: null });
    expect(again.kept).toEqual(r.kept);
    expect(again.amended).toEqual(r.amended);
  });

  it('gives the same answer on a world that already has the withdrawal applied', async () => {
    const { agreement } = committed();
    const d = D({ kind: 'withdraw', actor: 'sP1' });
    const hit = disrupt(agreement, world(), d);
    const again = disrupt(agreement, hit.world, d);
    expect(again.affected.map((o) => [o.id, o.state])).toEqual(hit.affected.map((o) => [o.id, o.state]));
    const a = await recover(agreement, world(), intent(), d, { solver: null });
    const b = await recover(agreement, hit.world, intent(), d, { solver: null });
    expect([b.kept, b.cancelled, b.added]).toEqual([a.kept, a.cancelled, a.added]);
  });

  it('claim overturned removes offers that depended on it', async () => {
    const { agreement } = committed();
    const r = await recover(agreement, world(), intent(), D({ kind: 'claim-overturned', detail: 'Claim c1 contradicted by delivery records' }), { solver: null });
    expect(r.cancelled).toEqual([agreement.obligations[0]!.id]);
    expect(r.feasible).toBe(true);
  });

  it('returns a core and the smallest concession when the deadline cannot hold', async () => {
    const { agreement } = committed();
    const tight = intent({ deadline: T('17T20:00') });
    const r = await recover(agreement, world(), tight, D({ kind: 'delay', offer: 'oA1', detail: 'Assembly line down for 30 hours' }), { solver: null });
    expect(r.feasible).toBe(false);
    expect(r.core!.constraints.length).toBeGreaterThan(0);
    expect(r.core!.proven).toBe(false);
    expect(r.concessionsNeeded!.map((c) => c.target)).toEqual([{ kind: 'intent', field: 'deadline' }]);
  });

  it('is infeasible with a core when no replacement capacity exists', async () => {
    const w = world();
    w.offers = w.offers.filter((o) => o.id !== 'oP2' && o.id !== 'oP3');
    const plan = basePlan(w);
    const agreement = commit(plan, intent(), acceptAll(plan));
    const r = await recover(agreement, w, intent(), D({ kind: 'withdraw', actor: 'sP1' }), { solver: null });
    expect(r.feasible).toBe(false);
    expect(r.core!.constraints.map((c) => c.id)).toContain('demand:print');
    expect(r.core!.summary).toMatch(/Print inserts needs 500 more/);
    expect(r.cancelled).toEqual([]);
  });

  it('respects capacity promised to other agreements', async () => {
    const { agreement } = committed();
    const r = await recover(agreement, world(), intent(), D({ kind: 'withdraw', actor: 'sP1' }), { solver: null, reservedElsewhere: { oP2: 300 } });
    expect(r.feasible).toBe(true);
    expect(r.added.map((a) => [a.offer, a.qty]).sort()).toEqual([['oP2', 200], ['oP3', 300]]);
    const blocked = await recover(agreement, world(), intent(), D({ kind: 'withdraw', actor: 'sP1' }), { solver: null, reservedElsewhere: { oP2: 400 } });
    expect(blocked.feasible).toBe(false);
  });
});

describe('counterfactual and commit of a recovery', () => {
  it('shows what happens if nothing changes', async () => {
    const { agreement } = committed();
    const delay = await recover(agreement, world(), intent(), D({ kind: 'delay', offer: 'oA1', detail: 'Assembly line down for 30 hours' }), { solver: null });
    expect(delay.counterfactual.lateHours).toBe(30);
    expect(delay.counterfactual.missesDeadline).toBe(false);
    const tight = await recover(agreement, world(), intent({ deadline: T('17T20:00') }), D({ kind: 'delay', offer: 'oA1', detail: '30 hours' }), { solver: null });
    expect(tight.counterfactual.missesDeadline).toBe(true);
    const gone = await recover(agreement, world(), intent(), D({ kind: 'withdraw', actor: 'sP1' }), { solver: null });
    expect(gone.counterfactual.shortfall).toEqual([{ stage: 'print', units: 500 }]);
    expect(gone.counterfactual.text).toMatch(/500 short/);
  });

  it('commits the amendment only with every party, superseding the original', async () => {
    const { agreement } = committed();
    const r = await recover(agreement, world(), intent(), D({ kind: 'withdraw', actor: 'sP1' }), { solver: null });
    const next = r.amendment!;
    expect(next.parties).toEqual(['buyer', 'sA1', 'sD1', 'sP2']);
    const signs = next.parties.map((p) => ({ actor: p, message: `r-${p}`, termsHash: next.termsHash, basis: p === 'buyer' ? ('buyer' as const) : ('seller-terminal' as const) }));
    expect(() => commitRecovery(agreement, r, signs.slice(0, 2))).toThrow(/Waiting for acceptance/);
    const done = commitRecovery(agreement, r, signs);
    expect(done.amended.state).toBe('COMMITTED');
    expect(done.original.state).toBe('AMENDED');
    expect(done.original.termsHash).toBe(agreement.termsHash);
    expect(done.obligations.map((o) => [o.id, o.state])).toEqual([[agreement.obligations[0]!.id, 'CANCELLED']]);
    expect(done.amended.obligations.filter((o) => o.state === 'ACTIVE')).toHaveLength(3);
    const signed = sign(next, r.world);
    expect(signed.declined).toEqual([]);
    expect(signed.agreement.state).toBe('COMMITTED');
  });
});
