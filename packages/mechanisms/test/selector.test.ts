import { describe, expect, it } from 'vitest';
import { compareMechanisms, createBidBoundary, publishedBids } from '../src/index.ts';
import { publishedPrice } from '../src/util.ts';
import { intent, truth, world } from './fixtures.ts';

describe('createBidBoundary', () => {
  it('bids at or above private cost and never above the published price', () => {
    const w = world();
    const i = intent();
    const { desk, audit } = createBidBoundary(truth, w, { markup: { 's-print-a': 0.1, 's-combo': 0.2, 's-asm-a': 0, 's-courier': 0.05, 's-print-b': 0.3 } });
    const bids = desk.solicit({ world: w, intent: i, bundles: true, levels: [0.5, 1] });
    expect(bids.length).toBeGreaterThan(0);
    const offers = new Map(w.offers.map((o) => [o.id, o]));
    for (const b of bids) {
      expect(b.price.minor).toBeGreaterThanOrEqual(audit.cost(b.items));
      expect(b.price.minor).toBeLessThanOrEqual(b.items.reduce((a, it) => a + publishedPrice(offers.get(it.offer)!, it.qty), 0));
      expect(JSON.stringify(b)).not.toMatch(/reservation/);
    }
    expect(bids.some((b) => b.bidder === 's-combo' && b.items.length === 2)).toBe(true);
    expect(publishedBids(w, i).length).toBeGreaterThan(0);
  });
});

describe('compareMechanisms', () => {
  it('reports verified n/N, surplus with intervals and a bounded statement', async () => {
    const exp = await compareMechanisms(world(), intent(), truth, { trials: 6, seed: 3 });
    expect(exp.trials).toBe(6);
    expect(exp.runs).toHaveLength(6);
    expect(exp.mechanisms.map((m) => m.id)).toEqual(['posted-price', 'reverse-auction', 'combinatorial-auction']);
    for (const m of exp.mechanisms) {
      expect(m.verified).toBeGreaterThanOrEqual(0);
      expect(m.verified).toBeLessThanOrEqual(6);
      expect(m.counted).toBeLessThanOrEqual(m.verified);
      expect(m.belowCost).toBe(0);
    }
    for (const t of exp.runs) {
      for (const r of t.results) {
        if (!r.verified || !r.deliverable) {
          expect(r.buyerSurplus).toBe(0);
          continue;
        }
        expect(r.totalSurplus).toBe(r.buyerSurplus + r.supplierSurplus);
        expect(r.supplierSurplus).toBeGreaterThanOrEqual(0);
      }
    }
    expect(exp.best.buyer).not.toBeNull();
    expect(exp.statement).toMatch(/\d+\/6 trials/);
    expect(exp.statement).toMatch(/this world/);
    const lead = exp.mechanisms.find((m) => m.id === exp.best.buyer)!;
    for (const m of exp.mechanisms) expect(lead.buyerSurplus!.mean).toBeGreaterThanOrEqual(m.counted ? m.buyerSurplus!.mean : -Infinity);
  });

  it('scores nothing for an award that relies on capacity a supplier does not really have', async () => {
    const liar = { ...truth, realCapacity: { 'o-pa': 100, 'o-pb': 100, 'o-pc': 100 } };
    const exp = await compareMechanisms(world(), intent(), liar, { trials: 3, seed: 5, dropRate: 0 });
    for (const t of exp.runs) {
      for (const r of t.results) {
        expect(r.deliverable).toBe(false);
        expect(r.buyerSurplus).toBe(0);
      }
    }
    expect(exp.best.buyer).toBeNull();
    expect(exp.statement).toMatch(/No mechanism/);
  });

  it('is reproducible for a seed', async () => {
    const a = await compareMechanisms(world(), intent(), truth, { trials: 3, seed: 11 });
    const b = await compareMechanisms(world(), intent(), truth, { trials: 3, seed: 11 });
    expect(a.runs).toEqual(b.runs);
  });
});
