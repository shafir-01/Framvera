import { describe, expect, it } from 'vitest';
import { estimateAcceptance, selectQuestions } from '../src/voi.ts';
import { concession, smallIntent, smallInterventions, smallWorld } from './fixture.ts';

describe('estimateAcceptance', () => {
  const world = smallWorld();
  const intent = smallIntent();

  it('gives explicit ranges that shrink with larger asks', () => {
    const small = estimateAcceptance(concession('k', 'o1', 'capacity', 300, 320), world, intent);
    const big = estimateAcceptance(concession('k', 'o1', 'capacity', 300, 450), world, intent);
    expect(small.lo).toBeLessThanOrEqual(small.mid);
    expect(small.mid).toBeLessThanOrEqual(small.hi);
    expect(big.mid).toBeLessThan(small.mid);
    expect(small.signals.length).toBeGreaterThan(0);
  });

  it('uses price position against the market and negotiable flags', () => {
    const aboveMedian = estimateAcceptance(concession('k', 'o3', 'unitPrice', 4600, 4300), world, intent);
    const undercut = estimateAcceptance(concession('k', 'o4', 'unitPrice', 3900, 3000), world, intent);
    expect(aboveMedian.mid).toBeGreaterThan(undercut.mid);
    expect(undercut.signals.join(' ')).toMatch(/undercuts/);
    const notListed = estimateAcceptance(concession('k', 'o4', 'capacity', 300, 320), world, intent);
    expect(notListed.mid).toBeLessThan(0.3);
  });

  it('treats buyer flexibility as needing explicit consent', () => {
    const i = { ...intent, negotiable: { deadlineHours: 24 } };
    const c = { id: 'd', target: { kind: 'intent' as const, field: 'deadline' as const }, from: intent.deadline, to: new Date(Date.parse(intent.deadline) + 12 * 3_600_000).toISOString(), estimate: { currency: 'SEK' as const, minor: 0 }, rationale: '' };
    const e = estimateAcceptance(c, world, i);
    expect(e.mid).toBeGreaterThan(0.8);
    expect(e.signals.join(' ')).toMatch(/explicit yes/);
  });
});

describe('selectQuestions', () => {
  const world = smallWorld();
  const intent = smallIntent();

  it('respects the query budget, groups conditional proposals and states the benefit', () => {
    const qs = selectQuestions(world, intent, smallInterventions(), 4);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.filter((q) => !q.buyerQuestion).length).toBeLessThanOrEqual(4);
    const first = qs.filter((q) => q.group === qs[0]!.group);
    expect(first.length).toBe(2);
    for (const q of first) {
      expect(q.message.type).toBe('Propose');
      if (q.message.type === 'Propose') {
        expect(q.message.conditional).toEqual(first.map((x) => x.message.id).filter((id) => id !== q.message.id));
      }
      expect(q.benefit).toMatch(/kr/);
      expect(q.benefit).toMatch(/under budget/);
      expect(q.voiRange.lo).toBeLessThanOrEqual(q.voi + 1e-9);
      expect(q.voiRange.hi).toBeGreaterThanOrEqual(q.voi - 1e-9);
    }
    expect(first[0]!.pAccept.mid).toBeLessThanOrEqual(first[1]!.pAccept.mid);
  });

  it('dedupes a concession shared by two interventions and asks it once', () => {
    const qs = selectQuestions(world, intent, smallInterventions(), 6);
    const keys = qs.map((q) => `${q.concession.target.kind === 'offer' ? q.concession.target.offer : ''}:${q.concession.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(qs.filter((q) => q.concession.target.kind === 'offer' && q.concession.target.offer === 'o2').length).toBe(1);
  });

  it('skips paths with a refused concession and stops when the budget is spent', () => {
    const answers = new Map([['offer:o2:capacity=500', false]]);
    expect(selectQuestions(world, intent, smallInterventions(), 6, { answers })).toEqual([]);
    expect(selectQuestions(world, intent, smallInterventions(), 1)).toEqual([]);
  });

  it('asks only nonbinding preferences when the buyer has not granted authority to negotiate', () => {
    const i = { ...intent, authority: { ...intent.authority, mayNegotiate: false } };
    const qs = selectQuestions(world, i, smallInterventions(), 4);
    expect(qs.every((q) => q.message.type === 'AskPreference')).toBe(true);
  });
});
