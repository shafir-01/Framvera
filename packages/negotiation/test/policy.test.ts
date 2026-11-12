import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { NegotiableField, NegotiationMessage } from '@framvera/contracts';
import { createSupplierDesk, decide, privateLimit } from '../src/policy.ts';
import { numeric, supplierDirection } from '../src/util.ts';
import { concession, policies, smallWorld } from './fixture.ts';

const HOUR = 3_600_000;

function propose(id: string, to: string, c: ReturnType<typeof concession>, conditional?: string[]): NegotiationMessage {
  return {
    type: 'Propose',
    id,
    from: 'buyer',
    to,
    concession: c,
    ...(conditional ? { conditional } : {}),
    expires: '2026-11-10T07:00:00.000Z',
    at: '2026-11-09T07:00:00.000Z',
  };
}

describe('decide', () => {
  const world = smallWorld();
  const pol = policies();

  it('accepts inside the limit, counters at the limit, rejects when no movement is possible', () => {
    const ok = decide(propose('m1', 'a1', concession('k', 'o1', 'capacity', 300, 340)), pol.a1!, world);
    expect(ok.accept).toBe(true);
    expect(ok.basis).toBe('synthetic-policy');

    const counter = decide(propose('m2', 'a1', concession('k', 'o1', 'capacity', 300, 400)), pol.a1!, world);
    expect(counter.accept).toBe(false);
    expect(counter.counter?.to).toBe(360);

    const price = decide(propose('m3', 'a4', concession('k', 'o4', 'unitPrice', 3900, 3000)), pol.a4!, world);
    expect(price.accept).toBe(false);
    expect(price.counter).toBeUndefined();
  });

  it('reads hour-based window extensions against the published window end', () => {
    const end = Date.parse(world.offers[0]!.window.end);
    const within = decide(propose('m', 'a1', concession('k', 'o1', 'windowEnd', world.offers[0]!.window.end, new Date(end + 5 * HOUR).toISOString())), pol.a1!, world);
    expect(within.accept).toBe(true);
    const beyond = decide(propose('m', 'a1', concession('k', 'o1', 'windowEnd', world.offers[0]!.window.end, new Date(end + 9 * HOUR).toISOString())), pol.a1!, world);
    expect(beyond.counter?.to).toBe(new Date(end + 6 * HOUR).toISOString());
  });

  it('refuses proposals sent to the wrong supplier and buyer-side terms', () => {
    expect(decide(propose('m', 'a2', concession('k', 'o1', 'capacity', 300, 310)), pol.a2!, world).accept).toBe(false);
    const intentTerm: NegotiationMessage = {
      type: 'Propose', id: 'm', from: 'buyer', to: 'a1', expires: '2026-11-10T07:00:00.000Z', at: '2026-11-09T07:00:00.000Z',
      concession: { id: 'k', target: { kind: 'intent', field: 'deadline' }, from: 'x', to: 'y', estimate: { currency: 'SEK', minor: 0 }, rationale: '' },
    };
    expect(decide(intentTerm, pol.a1!, world).accept).toBe(false);
  });

  it('raises price floors for contingent proposals when risk tolerance is low', () => {
    const plain = decide(propose('m', 'a3', concession('k', 'o3', 'unitPrice', 5000, 4400)), pol.a3!, world);
    const contingent = decide(propose('m', 'a3', concession('k', 'o3', 'unitPrice', 5000, 4400), ['m0']), pol.a3!, world);
    expect(plain.accept).toBe(true);
    expect(contingent.accept).toBe(false);
    expect(contingent.counter?.to).toBe(Math.ceil(4400 * 1.08));
  });

  it('never accepts or counters beyond a private limit (property)', () => {
    const fields: NegotiableField[] = ['unitPrice', 'capacity', 'windowEnd', 'minQty', 'setupFee', 'windowStart'];
    fc.assert(
      fc.property(
        fc.constantFrom('o1', 'o2', 'o3', 'o4'),
        fc.constantFrom(...fields),
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (offerId, field, delta, limitRaw, risk, contingent) => {
          const offer = world.offers.find((o) => o.id === offerId)!;
          const p = { reservation: {} as Record<string, number>, riskTolerance: risk, outside: { currency: 'SEK' as const, minor: 0 } };
          let from: number | string;
          let to: number | string;
          if (field === 'windowEnd' || field === 'windowStart') {
            const base = Date.parse(field === 'windowEnd' ? offer.window.end : offer.window.start);
            from = new Date(base).toISOString();
            to = new Date(base + delta * 60_000).toISOString();
            p.reservation[field] = limitRaw % 24;
          } else {
            const base = field === 'unitPrice' ? offer.tiers[0]!.unit.minor : field === 'capacity' ? offer.capacity : field === 'setupFee' ? offer.setupFee.minor : offer.minQty + 100;
            from = base;
            to = Math.max(0, base + delta);
            p.reservation[field] = Math.max(0, base + (limitRaw - 500));
          }
          const msg = propose('m', offer.actor, concession('k', offerId, field, from, to), contingent ? ['other'] : undefined);
          const d = decide(msg, p, world);
          const limit = privateLimit(p, offer, field)!;
          const dir = supplierDirection(field);
          const again = decide(msg, p, world);
          expect(again).toEqual(d);
          if (d.accept) expect(dir * (numeric(field, to)! - limit)).toBeGreaterThanOrEqual(0);
          if (d.counter) {
            const c = numeric(field, d.counter.to)!;
            expect(dir * (c - limit)).toBeGreaterThanOrEqual(0);
            expect(dir * (numeric(field, from)! - c)).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('supplier desk', () => {
  it('returns only the decision and keeps policies out of its surface', () => {
    const world = smallWorld();
    const desk = createSupplierDesk({ policies: policies() }, world);
    const d = desk.respond(propose('m', 'a1', concession('k', 'o1', 'capacity', 300, 340)) as Parameters<typeof desk.respond>[0]);
    expect(Object.keys(desk)).toEqual(['respond']);
    expect(JSON.stringify(d)).not.toMatch(/reservation|riskTolerance|outside/);
    expect(d.reason).not.toMatch(/360|3600/);
  });
});
