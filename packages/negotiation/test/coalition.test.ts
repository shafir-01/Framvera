import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Coalition } from '@framvera/contracts';
import { shapleyExact, splitCoalition } from '../src/coalition.ts';
import { smallWorld } from './fixture.ts';

const sek = (minor: number) => ({ currency: 'SEK' as const, minor });

function printCoalition(): Coalition {
  return {
    id: 'co1',
    members: ['a1', 'a3', 'a4'],
    output: { stage: 'print', qty: 500 },
    inputs: [
      { offer: 'o1', qty: 250 },
      { offer: 'o3', qty: 250 },
      { offer: 'o4', qty: 0 },
    ],
    split: [],
    rationality: [],
  };
}

describe('splitCoalition', () => {
  it('Shapley shares sum exactly to the coalition payment (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 7 }), fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 128, maxLength: 128 }), fc.integer({ min: 1, max: 10_000_000 }), (n, raw, total) => {
        const full = (1 << n) - 1;
        const v = (mask: number) => (mask === 0 ? 0 : mask === full ? total : raw[mask % raw.length]!);
        const phi = shapleyExact(n, v);
        expect(phi.reduce((a, b) => a + b, 0)).toBeCloseTo(total, 4);
      }),
      { numRuns: 200 },
    );
    const world = smallWorld();
    for (const payment of [1_999_999, 2_150_000, 3_000_001]) {
      const out = splitCoalition(printCoalition(), undefined, { world, payment: sek(payment) });
      expect(out.split.reduce((a, s) => a + s.share.minor, 0)).toBe(payment);
      expect(out.split.every((s) => Number.isInteger(s.share.minor))).toBe(true);
    }
  });

  it('splits by marginal contribution: equal outside options give equal shares, a better alternative earns more', () => {
    const world = smallWorld();
    const co: Coalition = { ...printCoalition(), members: ['a1', 'a3'], inputs: [{ offer: 'o1', qty: 250 }, { offer: 'o3', qty: 250 }] };
    const pol = (a: number, b: number) => ({
      a1: { reservation: {}, riskTolerance: 0.5, outside: sek(a) },
      a3: { reservation: {}, riskTolerance: 0.5, outside: sek(b) },
    });
    const even = splitCoalition(co, pol(500_000, 500_000), { world, payment: sek(2_000_000) });
    expect(even.analysis.method).toBe('shapley-exact');
    expect(even.split.map((s) => s.share.minor)).toEqual([1_000_000, 1_000_000]);
    const uneven = splitCoalition(co, pol(800_000, 200_000), { world, payment: sek(2_000_000) });
    expect(uneven.split.map((s) => s.share.minor)).toEqual([1_300_000, 700_000]);
    expect(uneven.analysis.inCore).toBe(true);
  });

  it('repairs an individual-rationality failure with a side payment from surplus', () => {
    const world = smallWorld();
    const outside = { a1: 1_200_000, a3: 300_000, a4: 950_000 };
    const pol = Object.fromEntries(Object.entries(outside).map(([k, v]) => [k, { reservation: {}, riskTolerance: 0.5, outside: sek(v) }]));
    const out = splitCoalition(printCoalition(), pol, { world, payment: sek(2_600_000) });
    expect(out.analysis.outsideSource).toBe('private-policy');
    expect(out.analysis.irBefore).toBe(false);
    expect(out.analysis.irAfter).toBe(true);
    expect(out.analysis.sidePayments.length).toBeGreaterThan(0);
    expect(out.rationality.every((r) => r.ok)).toBe(true);
    expect(out.split.reduce((a, s) => a + s.share.minor, 0)).toBe(2_600_000);
    for (const s of out.split) expect(s.share.minor).toBeGreaterThanOrEqual(outside[s.actor as keyof typeof outside]);
  });

  it('reports when no split can meet every outside option', () => {
    const world = smallWorld();
    const pol = {
      a1: { reservation: {}, riskTolerance: 0.5, outside: sek(1_500_000) },
      a3: { reservation: {}, riskTolerance: 0.5, outside: sek(1_400_000) },
      a4: { reservation: {}, riskTolerance: 0.5, outside: sek(100_000) },
    };
    const out = splitCoalition(printCoalition(), pol, { world, payment: sek(2_600_000) });
    expect(out.analysis.irAfter).toBe(false);
    expect(out.analysis.shortfall?.minor).toBe(400_000);
    expect(out.analysis.summary).toMatch(/short/);
    expect(out.split.reduce((a, s) => a + s.share.minor, 0)).toBe(2_600_000);
  });

  it('checks the final split against every sub-coalition', () => {
    const world = smallWorld();
    const out = splitCoalition(printCoalition(), undefined, { world, payment: sek(2_150_000) });
    expect(typeof out.analysis.inCore).toBe('boolean');
    if (!out.analysis.inCore) expect(out.analysis.blocking.length).toBeGreaterThan(0);
  });
});
