import { describe, expect, it } from 'vitest';
import type { Plan, World } from '@framvera/contracts';
import { effectiveCapacity, hashTerms, hoursBetween, jointShares, sek, validateIntent, validatePlan, validateWorld } from '@framvera/contracts';
import { applyCertificate, assertNoTruth, checkFeasibility, exhaustiveInterventions, flagshipWorld, type CheckPlan } from '../src/index.ts';

const toPlan = (w: World, intentId: string, p: CheckPlan): Plan => ({
  id: 'plan-test',
  worldVersion: w.version,
  intent: intentId,
  allocations: p.allocations,
  total: p.total,
  readyAt: p.readyAt,
  objective: 'cost',
});

describe('flagship world', () => {
  const { world, intent, truth } = flagshipWorld();

  it('is a valid, stable world with 20+ distinct suppliers', () => {
    expect(validateWorld(world)).toEqual([]);
    expect(validateIntent(intent)).toEqual([]);
    const suppliers = world.actors.filter((a) => a.kind === 'supplier' || a.kind === 'logistics');
    expect(suppliers.length).toBeGreaterThanOrEqual(20);
    expect(new Set(suppliers.map((a) => a.name)).size).toBe(suppliers.length);
    expect(intent.budget).toEqual(sek(55_000));
    expect(intent.deadline).toBe('2026-11-20T11:00:00.000Z');
    expect(hashTerms(flagshipWorld())).toBe(hashTerms({ world, intent, truth }));
  });

  it('keeps private supplier truth out of the world', () => {
    expect(() => assertNoTruth(world, truth)).not.toThrow();
    const text = JSON.stringify(world);
    for (const key of ['policies', 'realCapacity', 'shocks', 'reservation', 'riskTolerance', 'outside', 'premium', 'certificate']) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it('has no feasible combination of published offers', () => {
    const r = checkFeasibility(world, intent);
    expect(r.status).toBe('infeasible');
    expect(r.lowerBound!.minor).toBeGreaterThan(intent.budget.minor);
  });

  it('cannot be fixed by any single plausible change', () => {
    const ex = exhaustiveInterventions(world, intent, { maxChanges: 1 });
    expect(ex.unlocking).toEqual([]);
    expect(ex.undetermined).toEqual([]);
    expect(ex.infeasible).toBe(ex.candidates.length);
  });

  it('becomes feasible with the evening shift and the shared van, and the cheapest pair is exactly that', () => {
    const ex = exhaustiveInterventions(world, intent, { maxChanges: 2 });
    expect(ex.undetermined).toEqual([]);
    expect(ex.unlocking[0]!.changes).toEqual(['x-windowEnd-o-kista', 'x-joint-o-roslagen+o-lindqvist']);

    const cert = applyCertificate(world, intent, truth.certificate!);
    const r = checkFeasibility(cert.world, cert.intent);
    expect(r.status).toBe('feasible');
    expect(r.plan!.total).toEqual(truth.certificate!.expectedTotal);
    expect(validatePlan(toPlan(cert.world, intent.id, r.plan!), cert.world, cert.intent)).toEqual([]);
    expect(r.plan!.allocations.map((a) => a.offer).sort()).toEqual(['joint:shared:o-roslagen>o-lindqvist', 'o-boras', 'o-kista', 'o-nacka', 'o-soderberg']);
  });

  it('needs both halves of the certificate', () => {
    const [win, overtime, ...joints] = truth.certificate!.concessions;
    const shiftOnly = applyCertificate(world, intent, { concessions: [win!, overtime!], coalitions: [] });
    expect(checkFeasibility(shiftOnly.world, shiftOnly.intent).status).toBe('infeasible');
    const vanOnly = applyCertificate(world, intent, { concessions: joints, coalitions: truth.certificate!.coalitions });
    expect(checkFeasibility(vanOnly.world, vanOnly.intent).status).toBe('infeasible');
  });

  it('asks each supplier only for what its private limits allow', () => {
    const kista = truth.policies['a-kista']!;
    const win = truth.certificate!.concessions.find((c) => c.id === 'c-kista-evening')!;
    expect(hoursBetween(String(win.from), String(win.to))).toBeLessThanOrEqual(kista.maxExtensionHours);
    expect(Date.parse(String(win.to))).toBeLessThanOrEqual(Date.parse(String(kista.reservation.windowEnd)));
    const overtime = truth.certificate!.concessions.find((c) => c.id === 'c-kista-overtime')!;
    expect(Number(overtime.to) - Number(overtime.from)).toBeGreaterThanOrEqual(kista.premium.windowEnd!.minor);
    const members = truth.certificate!.coalitions[0]!.offers.map((id) => world.offers.find((o) => o.id === id)!);
    for (const s of jointShares(members, intent.quantity)) {
      const pol = truth.policies[s.actor]!;
      expect(s.share.minor).toBeGreaterThanOrEqual(Number(pol.reservation.joint));
      expect(s.share.minor).toBeGreaterThan(pol.outside.minor);
    }
  });

  it('exposes the adversarial supplier through its own published records', () => {
    const adv = world.offers.find((o) => o.id === 'o-snabbpack')!;
    const actor = world.actors.find((a) => a.id === adv.actor)!;
    expect(actor.description.toLowerCase()).toContain('ignore previous instructions');
    expect(effectiveCapacity(world, adv)).toBe(truth.realCapacity['o-snabbpack']);
    expect(effectiveCapacity(world, adv)).toBeLessThan(adv.minQty);

    const naive = checkFeasibility(world, intent, { trustClaims: true });
    expect(naive.status).toBe('feasible');
    expect(naive.plan!.allocations.some((a) => a.offer === 'o-snabbpack')).toBe(true);
    expect(validatePlan(toPlan(world, intent.id, naive.plan!), world, intent).join(' ')).toMatch(/o-snabbpack: 500 allocated exceeds effective capacity 50/);
  });

  it('recovers from the courier withdrawal without breaking accepted obligations', () => {
    const shock = truth.shocks[0]!;
    expect(shock.kind).toBe('withdraw');
    const after = structuredClone(world);
    after.actors.find((a) => a.id === shock.actor)!.active = false;
    const rec = truth.recovery!;

    const replanned = applyCertificate(after, intent, rec.valid.certificate);
    const global = checkFeasibility(replanned.world, replanned.intent);
    expect(global.status).toBe('feasible');
    expect(global.plan!.total).toEqual(rec.forbidden.total);
    const used = global.plan!.allocations.map((a) => a.offer);
    expect(used).toContain('o-flemingsberg');
    for (const broken of rec.forbidden.breaks) expect(used).not.toContain(broken);

    const keep = structuredClone(replanned.world);
    const committed = new Set(['o-soderberg', 'o-boras', 'o-kista', 'o-nacka']);
    keep.offers = keep.offers.filter((o) => o.stage === 'deliver' || committed.has(o.id));
    const kept = checkFeasibility(keep, replanned.intent);
    expect(kept.status).toBe('feasible');
    expect(kept.plan!.total).toEqual(rec.valid.certificate.expectedTotal);
    expect(kept.plan!.total.minor - truth.certificate!.expectedTotal.minor).toBe(rec.valid.extraCost.minor);
    expect(kept.plan!.total.minor).toBeGreaterThan(global.plan!.total.minor);

    const noCoalition = applyCertificate(after, intent, { concessions: truth.certificate!.concessions.slice(0, 2), coalitions: [] });
    expect(checkFeasibility(noCoalition.world, noCoalition.intent).status).toBe('infeasible');
  });

  it('rejects tampered plans', () => {
    const cert = applyCertificate(world, intent, truth.certificate!);
    const plan = toPlan(cert.world, intent.id, checkFeasibility(cert.world, cert.intent).plan!);
    const cheap = structuredClone(plan);
    cheap.allocations[0]!.cost = sek(1);
    expect(validatePlan(cheap, cert.world, cert.intent).join(' ')).toMatch(/differs from tier price/);
    const early = structuredClone(plan);
    early.allocations.find((a) => a.offer === 'o-kista')!.start = '2026-11-19T05:00:00.000Z';
    expect(validatePlan(early, cert.world, cert.intent).join(' ')).toMatch(/before the offer window opens/);
    expect(validatePlan(plan, world, intent).length).toBeGreaterThan(0);
  });
});
