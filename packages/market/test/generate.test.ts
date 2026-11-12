import { describe, expect, it } from 'vitest';
import { addHours, hashTerms, toMs, validateIntent, validateWorld } from '@framvera/contracts';
import { applyCertificate, assertNoTruth, checkFeasibility, circularExchangeWorld, exhibitionWorld, generateWorld, mostRelaxed, type Family } from '../src/index.ts';

const FAMILIES: Family[] = ['feasible', 'salvageable', 'impossible'];
const SEEDS = [1, 2, 3, 4, 5, 6];

describe('generateWorld', () => {
  it('is deterministic per seed and family', () => {
    for (const family of FAMILIES) {
      for (const seed of [3, 11]) expect(hashTerms(generateWorld(seed, family))).toBe(hashTerms(generateWorld(seed, family)));
    }
  });

  it('changes economic structure with the seed, not just names', () => {
    const signatures = SEEDS.map((seed) => {
      const { world, intent } = generateWorld(seed, 'feasible');
      return [world.stages.map((s) => `${s.id}<${s.after.join('+')}`).join(','), world.offers.length, intent.quantity].join('|');
    });
    expect(new Set(signatures).size).toBe(SEEDS.length);
    const shapes = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const { world } = generateWorld(seed, 'feasible');
      if (world.stages.some((s) => s.after.length >= 2)) shapes.add('join');
      if (world.stages.some((s) => world.stages.filter((t) => t.after.includes(s.id)).length >= 2)) shapes.add('fork');
      if (world.stages.every((s) => s.after.length <= 1)) shapes.add('chain');
    }
    expect([...shapes].sort()).toEqual(['chain', 'fork', 'join']);
  });

  for (const family of FAMILIES) {
    it(`produces ${family} worlds whose label the checker confirms`, () => {
      for (const seed of SEEDS) {
        const { world, intent, truth } = generateWorld(seed, family);
        expect(validateWorld(world)).toEqual([]);
        expect(validateIntent(intent)).toEqual([]);
        expect(world.family).toBe(family);
        expect(world.stages.length).toBeGreaterThanOrEqual(3);
        expect(world.stages.length).toBeLessThanOrEqual(6);
        const suppliers = world.actors.filter((a) => a.kind !== 'buyer').length;
        expect(suppliers).toBeGreaterThanOrEqual(8);
        expect(suppliers).toBeLessThanOrEqual(40);
        expect(() => assertNoTruth(world, truth)).not.toThrow();

        const published = checkFeasibility(world, intent).status;
        if (family === 'feasible') expect(published).toBe('feasible');
        if (family === 'salvageable') {
          expect(published).toBe('infeasible');
          const cert = applyCertificate(world, intent, truth.certificate!);
          const r = checkFeasibility(cert.world, cert.intent);
          expect(r.status).toBe('feasible');
          expect(r.plan!.total).toEqual(truth.certificate!.expectedTotal);
          for (const c of truth.certificate!.concessions) {
            if (c.target.kind !== 'offer') continue;
            const target = c.target;
            const offer = world.offers.find((o) => o.id === target.offer)!;
            const pol = truth.policies[offer.actor]!;
            if (target.field === 'windowEnd') expect(toMs(String(c.to))).toBeLessThanOrEqual(toMs(String(pol.reservation.windowEnd)));
            if (target.field === 'unitPrice') expect(Number(c.to)).toBeGreaterThanOrEqual(Number(pol.reservation.unitPrice));
            if (target.field !== 'setupFee') expect(offer.negotiable).toContain(target.field);
          }
        }
        if (family === 'impossible') {
          expect(published).toBe('infeasible');
          expect(checkFeasibility(mostRelaxed(world, intent, truth), intent).status).toBe('infeasible');
        }
      }
    });
  }

  it('hides adversarial truth behind public claims', () => {
    let seen = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { world, truth } = generateWorld(seed, 'salvageable');
      for (const id of truth.adversarial) {
        seen++;
        const offer = world.offers.find((o) => o.id === id)!;
        expect(truth.realCapacity[id]).toBeLessThan(offer.minQty);
        expect(world.claims.some((c) => c.subject === `booked:${id}` && c.tier === 'corroborated')).toBe(true);
        expect(JSON.stringify(world)).not.toContain('"realCapacity"');
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('schedules shocks inside the market week', () => {
    const { world, truth } = generateWorld(4, 'salvageable');
    expect(truth.shocks.length).toBeGreaterThan(0);
    for (const s of truth.shocks) {
      expect(toMs(s.at)).toBeGreaterThan(toMs(world.createdAt));
      expect(toMs(s.at)).toBeLessThan(toMs(addHours(world.createdAt, 7 * 24)));
    }
  });

  it('offers exhibition build and circular exchange scenarios on the same schema', () => {
    for (const bundle of [exhibitionWorld(), circularExchangeWorld()]) {
      expect(validateWorld(bundle.world)).toEqual([]);
      expect(checkFeasibility(bundle.world, bundle.intent).status).toBe('infeasible');
      const cert = applyCertificate(bundle.world, bundle.intent, bundle.truth.certificate!);
      expect(checkFeasibility(cert.world, cert.intent).status).toBe('feasible');
    }
    expect(exhibitionWorld().world.name).toMatch(/Stockholmsmässan/);
    expect(circularExchangeWorld().world.stages.map((s) => s.id)).toContain('refinish');
  });
});
