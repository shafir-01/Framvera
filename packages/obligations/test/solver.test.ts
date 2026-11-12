import { describe, expect, it } from 'vitest';
import type { SolverLike } from '../src/recover.ts';
import { recover } from '../src/recover.ts';
import { committed, intent, payment, T, world } from './fixture.ts';

const solver = (await import('@framvera/solver').then(
  (m: Record<string, unknown>) => (typeof m.solve === 'function' ? m : null),
  () => null,
)) as SolverLike | null;

describe.skipIf(!solver)('recover with the MIP solver', () => {
  it('keeps unaffected obligations and rejects the cheaper plan from scratch', async () => {
    const { agreement } = committed();
    const pay = payment(agreement, 'sP1', 'CAPTURE_COMPLETED');
    const r = await recover(agreement, world(), intent(), { id: 'd1', kind: 'withdraw', actor: 'sP1', detail: 'Söder Print withdraws', at: T('16T06:00') }, { solver, payments: [pay] });
    expect(r.feasible).toBe(true);
    expect(r.kept.sort()).toEqual([agreement.obligations[1]!.id, agreement.obligations[2]!.id].sort());
    const repair = r.candidates.find((c) => c.source === 'solver-repair')!;
    expect(repair.permissible).toBe(true);
    const scratch = r.candidates.find((c) => c.source === 'solver-scratch')!;
    expect(scratch.permissible).toBe(false);
    expect(scratch.extraCostMinor).toBeLessThan(r.extraCost.minor);
    expect(scratch.reasons.some((x) => /accepted obligation of Kista Pack/.test(x))).toBe(true);
    expect(r.payments.refunds[0]!.amount.minor).toBe(pay.charged.minor);
  });

  it('returns a core naming the uncovered stage when nothing can replace the failure', async () => {
    const w = world();
    w.offers = w.offers.filter((o) => o.id !== 'oP2' && o.id !== 'oP3');
    const { agreement } = committed();
    const r = await recover(agreement, w, intent(), { id: 'd2', kind: 'withdraw', actor: 'sP1', detail: 'Söder Print withdraws', at: T('16T06:00') }, { solver });
    expect(r.feasible).toBe(false);
    expect(r.core!.constraints.map((c) => c.id)).toContain('demand:print');
  });
});
