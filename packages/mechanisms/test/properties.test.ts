import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findExchangeCycles, publishedBids, runReverseAuction, type ExchangeMarket, type PackageBid } from '../src/index.ts';
import { allocate } from '../src/util.ts';
import { NOW, intent, kr, world } from './fixtures.ts';

const GOODS = ['board', 'van', 'laser', 'foam', 'racks'];

const marketArb = fc
  .record({
    n: fc.integer({ min: 2, max: 6 }),
    lots: fc.array(fc.record({ owner: fc.nat(5), good: fc.nat(2), qty: fc.integer({ min: 10, max: 50 }), reserve: fc.integer({ min: 0, max: 5000 }) }), { minLength: 2, maxLength: 12 }),
    wants: fc.array(fc.record({ who: fc.nat(5), good: fc.nat(2), minQty: fc.integer({ min: 1, max: 30 }), value: fc.integer({ min: 0, max: 8000 }), count: fc.integer({ min: 1, max: 2 }) }), { minLength: 2, maxLength: 12 }),
  })
  .map(({ n, lots, wants }): ExchangeMarket => ({
    id: 'prop',
    currency: 'SEK',
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
    lots: lots.map((l, i) => ({ id: `l${i}`, owner: `p${l.owner % n}`, good: GOODS[l.good]!, qty: l.qty, unit: 'u', reserve: kr(l.reserve) })),
    wants: wants.map((w, i) => ({ id: `w${i}`, participant: `p${w.who % n}`, good: GOODS[w.good]!, minQty: w.minQty, value: kr(w.value), count: w.count })),
  }));

describe('conservation properties', () => {
  it('allocate splits any amount exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), fc.array(fc.integer({ min: 0, max: 1e6 }), { minLength: 1, maxLength: 8 }), (total, w) => {
        const parts = allocate(total, w);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        for (const p of parts) expect(Number.isSafeInteger(p)).toBe(true);
      }),
    );
  });

  it('proportional pool shares never exceed a reference when the pooled cost is below their sum', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1e7 }), { minLength: 2, maxLength: 6 }), fc.double({ min: 0, max: 0.999, noNaN: true }), (refs, f) => {
        const sum = refs.reduce((a, b) => a + b, 0);
        const total = Math.floor(sum * f);
        const shares = allocate(total, refs);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        shares.forEach((s, i) => expect(s).toBeLessThanOrEqual(refs[i]!));
      }),
    );
  });

  it('exchange cash sums to zero per cycle, lots move once, nobody loses, verifier agrees', async () => {
    let cleared = 0;
    await fc.assert(
      fc.asyncProperty(marketArb, fc.constantFrom('equal' as const, 'min-cash' as const), async (mk, split) => {
        const r = await findExchangeCycles(mk, { split, maxLength: 4 });
        expect(r.verification.ok).toBe(true);
        if (r.cycles.length) cleared++;
        const moved = r.cycles.flatMap((c) => c.transfers.map((x) => x.lot));
        expect(new Set(moved).size).toBe(moved.length);
        for (const c of r.cycles) {
          expect(c.parties.reduce((a, p) => a + p.cash.minor, 0)).toBe(0);
          for (const p of c.parties) expect(p.gain.minor).toBeGreaterThanOrEqual(0);
          expect(c.parties.reduce((a, p) => a + p.gain.minor, 0)).toBe(c.surplus.minor);
        }
      }),
      { numRuns: 60 },
    );
    expect(cleared).toBeGreaterThan(5);
  });

  it('auction payments equal winning bids, capacity holds, verifier agrees', async () => {
    const w = world();
    const i = intent({ budget: kr(1_000_000) });
    const offers = w.offers;
    const bidArb = fc.array(
      fc.record({ offers: fc.uniqueArray(fc.nat(offers.length - 1), { minLength: 1, maxLength: 2 }), share: fc.double({ min: 0.2, max: 1, noNaN: true }), price: fc.integer({ min: 100, max: 20000 }), grouped: fc.boolean() }),
      { minLength: 1, maxLength: 14 },
    );
    let awarded = 0;
    let cheaperThanPublished = 0;
    await fc.assert(
      fc.asyncProperty(bidArb, async (specs) => {
        const bids: PackageBid[] = publishedBids(w, i, [0.5, 1]);
        specs.forEach((s, k) => {
          const os = s.offers.map((j) => offers[j]!);
          if (new Set(os.map((o) => o.actor)).size !== 1) return;
          bids.push({
            id: `b${k}`,
            bidder: os[0]!.actor,
            items: os.map((o) => ({ offer: o.id, qty: Math.max(o.minQty, Math.min(o.capacity, Math.ceil(300 * s.share))) })),
            price: kr(s.price),
            ...(s.grouped ? { exclusiveGroup: os[0]!.actor } : {}),
            provenance: { source: 'seller-terminal', observedAt: NOW },
          });
        });
        const r = await runReverseAuction(w, i, bids);
        expect(r.verification.ok).toBe(true);
        if (r.status !== 'awarded') return;
        awarded++;
        if (r.winners.some((x) => !x.bid.startsWith('pub:'))) cheaperThanPublished++;
        const byId = new Map(bids.map((b) => [b.id, b]));
        expect(r.total!.minor).toBe(r.winners.reduce((a, x) => a + byId.get(x.bid)!.price.minor, 0));
        expect(r.plan!.allocations.reduce((a, x) => a + x.cost.minor, 0)).toBe(r.total!.minor);
        for (const o of offers) {
          const drawn = r.winners.flatMap((x) => x.items).filter((it) => it.offer === o.id).reduce((a, it) => a + it.qty, 0);
          expect(drawn).toBeLessThanOrEqual(o.capacity);
        }
      }),
      { numRuns: 40 },
    );
    expect(awarded).toBeGreaterThan(30);
    expect(cheaperThanPublished).toBeGreaterThan(0);
  });
});
