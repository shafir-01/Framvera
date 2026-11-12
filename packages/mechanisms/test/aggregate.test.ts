import { describe, expect, it } from 'vitest';
import { aggregateDemand, verifyAggregation, type BuyerOrder } from '../src/index.ts';
import { at, intent, kr, world } from './fixtures.ts';

const order = (buyer: string, quantity: number, over: Partial<BuyerOrder['intent']> = {}, pool = true): BuyerOrder => ({
  buyer,
  intent: intent({ id: `i-${buyer}`, quantity, budget: kr(15000), authority: { mayNegotiate: false, mayReserve: false, mayPreparePayments: false, maxSpend: kr(15000) }, ...over }),
  consent: { pool },
});

describe('aggregateDemand', () => {
  it('pools two consenting buyers across a price tier and splits the saving proportionally', async () => {
    const w = world();
    const orders = [order('b1', 150), order('b2', 150, { deadline: at(3, 20) })];
    const r = await aggregateDemand(w, orders);
    expect(r.status).toBe('pooled');
    expect(r.pools).toHaveLength(1);
    const p = r.pools[0]!;
    expect(p.intent.quantity).toBe(300);
    expect(p.intent.deadline).toBe(at(3, 20));
    expect(p.members.reduce((a, x) => a + x.share.minor, 0)).toBe(p.plan.total.minor);
    for (const x of p.members) {
      expect(x.alone).not.toBeNull();
      expect(x.share.minor).toBeLessThan(x.alone!.minor);
      expect(x.share.minor).toBeLessThanOrEqual(x.budget.minor);
    }
    expect(p.tiersCrossed.map((c) => c.offer)).toContain('o-pa');
    expect(r.totalSaving.minor).toBeGreaterThan(0);
    expect(r.verification.ok).toBe(true);
  });

  it('never pools a buyer without consent', async () => {
    const w = world();
    const orders = [order('b1', 150), order('b2', 150, {}, false)];
    const r = await aggregateDemand(w, orders);
    expect(r.pools).toEqual([]);
    expect(r.refused.map((x) => x.buyer)).toEqual(['b2']);
    expect(r.alone.map((x) => x.buyer).sort()).toEqual(['b1', 'b2']);
    expect(r.verification.ok).toBe(true);
  });

  it('keeps different destinations apart', async () => {
    const r = await aggregateDemand(world(), [order('b1', 150), order('b2', 150, { deliverTo: 'Göteborg' })]);
    expect(r.pools).toEqual([]);
    expect(r.verification.ok).toBe(true);
  });

  it('lets a buyer too small to order alone join a pool, paying at most its budget', async () => {
    const w = world();
    const orders = [order('b1', 250), order('small', 60, { budget: kr(3000), authority: { mayNegotiate: false, mayReserve: false, mayPreparePayments: false, maxSpend: kr(3000) } })];
    const r = await aggregateDemand(w, orders);
    const small = r.alone.find((a) => a.buyer === 'small');
    expect(small).toBeUndefined();
    expect(r.pools).toHaveLength(1);
    const m = r.pools[0]!.members.find((x) => x.buyer === 'small')!;
    expect(m.alone).toBeNull();
    expect(m.reference.minor).toBe(300000);
    expect(m.share.minor).toBeLessThanOrEqual(300000);
    expect(r.verification.ok).toBe(true);
  });

  it('checks every subgroup of a three-buyer pool for a cheaper deal on its own', async () => {
    const w = world();
    const orders = [order('b1', 100), order('b2', 100), order('b3', 100)];
    const r = await aggregateDemand(w, orders);
    expect(r.verification.ok).toBe(true);
    const big = r.pools.find((p) => p.members.length === 3);
    if (big) {
      expect(big.stability.checked + big.stability.unchecked).toBe(3);
      expect(big.stability.stable === false).toBe(big.stability.blocking.length > 0);
      for (const b of big.stability.blocking) expect(b.cost.minor).toBeLessThan(b.payNow.minor);
    }
    const pair = await aggregateDemand(w, orders.slice(0, 2));
    expect(pair.pools[0]!.stability).toMatchObject({ checked: 0, unchecked: 0, stable: true });
    const forged = structuredClone(pair);
    forged.pools[0]!.stability.blocking.push({ members: ['b1', 'b2'], cost: kr(999999), payNow: kr(1) });
    expect(verifyAggregation(forged, w, orders.slice(0, 2)).checks.find((c) => c.id === 'stability')!.ok).toBe(false);
  });

  it('flags a tampered split and a pooled non-consenting buyer', async () => {
    const w = world();
    const orders = [order('b1', 150), order('b2', 150)];
    const r = await aggregateDemand(w, orders);
    const bad = structuredClone(r);
    bad.pools[0]!.members[0]!.share.minor += 1;
    expect(verifyAggregation(bad, w, orders).ok).toBe(false);
    const noConsent = orders.map((o, i) => (i === 1 ? { ...o, consent: { pool: false } } : o));
    const v = verifyAggregation(r, w, noConsent);
    expect(v.checks.find((c) => c.id === 'consent')!.ok).toBe(false);
  });
});
