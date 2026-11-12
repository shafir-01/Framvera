import { describe, expect, it } from 'vitest';
import { publishedBids, runReverseAuction, verifyAuction } from '../src/index.ts';
import { at, bid, intent, offer, world } from './fixtures.ts';

const courier = bid('c', 's-courier', [['o-c', 300]], 1700);

describe('runReverseAuction', () => {
  it('awards a package bid that beats separate bids and pays exactly the bids', async () => {
    const bids = [
      bid('pa', 's-print-a', [['o-pa', 300]], 3100),
      bid('aa', 's-asm-a', [['o-aa', 300]], 8200),
      bid('combo', 's-combo', [['o-pc', 300], ['o-ac', 300]], 10500),
      courier,
    ];
    const w = world();
    const r = await runReverseAuction(w, intent(), bids);
    expect(r.status).toBe('awarded');
    expect(r.paymentRule).toBe('pay-as-bid');
    expect(r.winners.map((x) => x.bid).sort()).toEqual(['c', 'combo']);
    expect(r.total!.minor).toBe((10500 + 1700) * 100);
    expect(r.plan!.allocations.reduce((a, x) => a + x.cost.minor, 0)).toBe(r.total!.minor);
    expect(r.verification.ok).toBe(true);
    expect(r.optimality).toMatch(/proven optimal/);
  });

  it('never draws one offer beyond its capacity across bids', async () => {
    const bids = [
      bid('pa1', 's-print-a', [['o-pa', 200]], 1000),
      bid('pa2', 's-print-a', [['o-pa', 200]], 1000),
      bid('pa3', 's-print-a', [['o-pa', 250]], 1000),
      bid('aa', 's-asm-a', [['o-aa', 300]], 8200),
      courier,
    ];
    const w = world();
    w.offers = w.offers.map((o) => (o.id === 'o-pa' ? { ...o, capacity: 450 } : o));
    const r = await runReverseAuction(w, intent(), bids);
    expect(r.status).toBe('awarded');
    const drawn = r.winners.flatMap((x) => x.items).filter((i) => i.offer === 'o-pa').reduce((a, i) => a + i.qty, 0);
    expect(drawn).toBeLessThanOrEqual(450);
    expect(r.verification.ok).toBe(true);
  });

  it('counts only capacity left after corroborated bookings', async () => {
    const w = world();
    w.claims = [{ id: 'cl-1', actor: 's-print-a', subject: 'booked:o-pa', assertion: 'Booked for another order', value: 450, tier: 'corroborated', provenance: { source: 'synthetic-market', observedAt: '2026-11-16T07:00:00.000Z' } }];
    const r = await runReverseAuction(w, intent(), [bid('pa', 's-print-a', [['o-pa', 300]], 100), bid('pb', 's-print-b', [['o-pb', 300]], 4100), bid('aa', 's-asm-a', [['o-aa', 300]], 8200), courier]);
    expect(r.rejected.find((x) => x.bid === 'pa')?.reason).toMatch(/bookings/);
    expect(r.winners.map((x) => x.bid)).toContain('pb');
    expect(r.verification.ok).toBe(true);
  });

  it('respects exclusive menus', async () => {
    const bids = [
      bid('pa-150', 's-print-a', [['o-pa', 150]], 900, 'menu'),
      bid('pa-150b', 's-print-a', [['o-pa', 150]], 900, 'menu'),
      bid('pb', 's-print-b', [['o-pb', 300]], 4100),
      bid('aa', 's-asm-a', [['o-aa', 300]], 8200),
      courier,
    ];
    const r = await runReverseAuction(world(), intent(), bids);
    expect(r.status).toBe('awarded');
    expect(r.winners.filter((x) => x.bid.startsWith('pa-')).length).toBeLessThanOrEqual(1);
    expect(r.winners.map((x) => x.bid)).toContain('pb');
  });

  it('rejects invalid bids with reasons', async () => {
    const bids = [
      bid('wrong-owner', 's-print-a', [['o-pb', 300]], 100),
      bid('too-many', 's-print-a', [['o-pa', 700]], 100),
      bid('too-few', 's-asm-a', [['o-aa', 100]], 100),
      { ...bid('usd', 's-print-b', [['o-pb', 300]], 100), price: { currency: 'USD' as const, minor: 100 } },
      bid('buyer', 'b1', [['o-pa', 300]], 100),
    ];
    const r = await runReverseAuction(world(), intent(), bids);
    expect(r.status).toBe('no-award');
    expect(r.rejected.map((x) => x.bid).sort()).toEqual(['buyer', 'too-few', 'too-many', 'usd', 'wrong-owner']);
    expect(r.winners).toEqual([]);
  });

  it('reports a budget problem when every covering award is too expensive', async () => {
    const bids = [bid('pa', 's-print-a', [['o-pa', 300]], 3100), bid('aa', 's-asm-a', [['o-aa', 300]], 8200), courier];
    const r = await runReverseAuction(world(), intent({ budget: { currency: 'SEK', minor: 500000 } }), bids);
    expect(r.status).toBe('no-award');
    expect(r.optimality).toMatch(/proved/);
    expect(r.diagnosis.join(' ')).toMatch(/above the budget/);
  });

  it('cuts a cheaper winner set that cannot be scheduled and awards the next one', async () => {
    const late = offer({ id: 'o-late', actor: 's-print-b', stage: 'print', capacity: 400, minQty: 50, rate: 100, setup: 0, tiers: [[0, 1]], window: [3, 8, 3, 18], handoff: 2 });
    const w = world([late]);
    const bids = [bid('late', 's-print-b', [['o-late', 300]], 300), bid('pa', 's-print-a', [['o-pa', 300]], 3100), bid('aa', 's-asm-a', [['o-aa', 300]], 8200), courier];
    const r = await runReverseAuction(w, intent(), bids);
    expect(r.status).toBe('awarded');
    expect(r.scheduleCuts.length).toBeGreaterThanOrEqual(1);
    expect(r.scheduleCuts[0]!.bids).toContain('late');
    expect(r.winners.map((x) => x.bid)).not.toContain('late');
    expect(r.verification.ok).toBe(true);
    expect(Date.parse(r.plan!.readyAt)).toBeLessThanOrEqual(Date.parse(at(4, 12)));
  });

  it('flags a tampered result', async () => {
    const bids = [bid('pa', 's-print-a', [['o-pa', 300]], 3100), bid('aa', 's-asm-a', [['o-aa', 300]], 8200), courier];
    const w = world();
    const i = intent();
    const r = await runReverseAuction(w, i, bids);
    const tampered = structuredClone(r);
    tampered.winners[0]!.price.minor += 100;
    const v = verifyAuction(tampered, w, i, bids);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.id === 'payments')!.ok).toBe(false);
    const shifted = structuredClone(r);
    shifted.plan!.allocations[0]!.start = at(-1, 0);
    expect(verifyAuction(shifted, w, i, bids).ok).toBe(false);
  });

  it('runs on a published-price bid book', async () => {
    const w = world();
    const i = intent();
    const bids = publishedBids(w, i);
    const r = await runReverseAuction(w, i, bids);
    expect(r.status).toBe('awarded');
    expect(r.verification.ok).toBe(true);
    expect(r.total!.minor).toBe(r.publishedTotal!.minor);
  });
});
