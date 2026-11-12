import { describe, expect, it } from 'vitest';
import { exchangeMarket, findExchangeCycles, verifyExchange, type ExchangeMarket } from '../src/index.ts';
import { kr } from './fixtures.ts';

function triangle(): ExchangeMarket {
  return {
    id: 'x-tri',
    currency: 'SEK',
    participants: [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
      { id: 'C', name: 'C' },
    ],
    lots: [
      { id: 'a1', owner: 'A', good: 'board', qty: 500, unit: 'sheets', reserve: kr(1000) },
      { id: 'b1', owner: 'B', good: 'van', qty: 2, unit: 'days', reserve: kr(3000) },
      { id: 'c1', owner: 'C', good: 'laser', qty: 10, unit: 'hours', reserve: kr(2000) },
    ],
    wants: [
      { id: 'wb', participant: 'B', good: 'board', minQty: 300, value: kr(2500) },
      { id: 'wc', participant: 'C', good: 'van', minQty: 1, value: kr(2800) },
      { id: 'wa', participant: 'A', good: 'laser', minQty: 5, value: kr(4000) },
    ],
  };
}

describe('findExchangeCycles', () => {
  it('finds a three-way cycle no pair could do and balances it with cash', async () => {
    const mk = triangle();
    const r = await findExchangeCycles(mk);
    expect(r.status).toBe('cleared');
    expect(r.cycles).toHaveLength(1);
    const cy = r.cycles[0]!;
    expect(cy.transfers).toHaveLength(3);
    expect(cy.surplus.minor).toBe((2500 - 1000 + 2800 - 3000 + 4000 - 2000) * 100);
    expect(cy.parties.reduce((a, p) => a + p.cash.minor, 0)).toBe(0);
    for (const p of cy.parties) expect(p.gain.minor).toBeGreaterThanOrEqual(0);
    const b = cy.parties.find((p) => p.participant === 'B')!;
    expect(b.valueIn.minor - b.valueOut.minor).toBe(-50000);
    expect(b.cash.minor).toBeGreaterThan(50000);
    expect(r.verification.ok).toBe(true);
  });

  it('skips cycles with no positive surplus', async () => {
    const mk = triangle();
    mk.wants = mk.wants.map((w) => ({ ...w, value: kr(500) }));
    const r = await findExchangeCycles(mk);
    expect(r.status).toBe('no-cycles');
    expect(r.cycles).toEqual([]);
    expect(r.verification.ok).toBe(true);
  });

  it('uses each lot once when cycles compete for it', async () => {
    const mk = triangle();
    mk.participants.push({ id: 'D', name: 'D' });
    mk.lots.push({ id: 'd1', owner: 'D', good: 'laser', qty: 10, unit: 'hours', reserve: kr(100) });
    mk.wants.push({ id: 'wd', participant: 'D', good: 'board', minQty: 100, value: kr(5000) });
    const r = await findExchangeCycles(mk);
    expect(r.status).toBe('cleared');
    const moved = r.cycles.flatMap((c) => c.transfers.map((x) => x.lot));
    expect(new Set(moved).size).toBe(moved.length);
    expect(moved.filter((l) => l === 'a1')).toHaveLength(1);
    expect(r.verification.ok).toBe(true);
  });

  it('min-cash split moves no more cash than the equal split and keeps everyone whole', async () => {
    const mk = triangle();
    const eq = await findExchangeCycles(mk, { split: 'equal' });
    const mc = await findExchangeCycles(mk, { split: 'min-cash' });
    expect(mc.cashMoved.minor).toBeLessThanOrEqual(eq.cashMoved.minor);
    expect(mc.cashMoved.minor).toBe(500 * 100);
    expect(mc.verification.ok).toBe(true);
    for (const p of mc.cycles[0]!.parties) expect(p.gain.minor).toBeGreaterThanOrEqual(0);
  });

  it('flags tampered cash', async () => {
    const mk = triangle();
    const r = await findExchangeCycles(mk);
    const bad = structuredClone(r);
    bad.cycles[0]!.parties[0]!.cash.minor += 1;
    const v = verifyExchange(bad, mk);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.id === 'cash')!.ok).toBe(false);
    const stolen = structuredClone(r);
    stolen.cycles[0]!.transfers[0]!.from = 'B';
    expect(verifyExchange(stolen, mk).ok).toBe(false);
  });

  it('clears seeded sample markets with verified results', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const mk = exchangeMarket(seed, 10);
      const r = await findExchangeCycles(mk);
      expect(r.verification.ok).toBe(true);
      expect(['cleared', 'no-cycles']).toContain(r.status);
    }
    const r = await findExchangeCycles(exchangeMarket(1, 10));
    expect(r.cycles.length).toBeGreaterThan(0);
  });
});
