import { describe, expect, it } from 'vitest';
import { validatePlan } from '@framvera/contracts';
import { applyCertificate, checkFeasibility, flagshipWorld } from '@framvera/market';
import { applyConcessions, findInterventions, solve, verifyPlan } from '../src/index.ts';
import { statusWith } from './helpers.ts';

const { world, intent, truth } = flagshipWorld();
const certificate = truth.certificate!;

describe('flagship market', () => {
  it('is infeasible as published, with a proven minimal core that cites the budget', async () => {
    const r = await solve(world, intent);
    expect(r.status).toBe('infeasible');
    expect(checkFeasibility(world, intent).status).toBe('infeasible');
    const core = r.core!;
    expect(core.proven).toBe(true);
    expect(core.minimal).toBe(true);
    const ids = new Set(core.constraints.map((c) => c.id));
    expect(ids).toContain('budget');
    expect(await statusWith(world, intent, ids)).toBe('infeasible');
    for (const id of ids) expect(await statusWith(world, intent, new Set([...ids].filter((x) => x !== id))), id).toBe('optimal');
  }, 60000);

  it('becomes feasible at exactly 52 600 kr after the evening shift and the shared van', async () => {
    const after = applyCertificate(world, intent, certificate);
    const r = await solve(after.world, after.intent);
    expect(r.status).toBe('optimal');
    expect(r.plan!.total.minor).toBe(5_260_000);
    expect(r.plan!.total.minor).toBe(checkFeasibility(after.world, after.intent).plan!.total.minor);
    expect(validatePlan(r.plan!, after.world, after.intent)).toEqual([]);
    expect(verifyPlan(r.plan!, after.world, after.intent).ok).toBe(true);
    expect(r.plan!.allocations.some((a) => a.offer === 'joint:shared:o-roslagen>o-lindqvist')).toBe(true);
  });

  it('reaches the same plan when the accepted terms are applied with applyConcessions', async () => {
    const after = applyConcessions(world, intent, certificate.concessions);
    expect(after.world.offers.some((o) => o.id === 'joint:shared:o-roslagen>o-lindqvist')).toBe(true);
    const r = await solve(after.world, after.intent, { explain: false });
    expect(r.plan!.total.minor).toBe(5_260_000);
    expect(validatePlan(r.plan!, after.world, after.intent)).toEqual([]);
  });

  it('finds the evening shift and the shared van as the fewest changes', async () => {
    const ivs = await findInterventions(world, intent);
    const first = ivs[0]!;
    expect(first.method).toBe('coalition');
    const targets = first.concessions.map((c) => (c.target.kind === 'offer' ? `${c.target.offer}:${c.target.field}` : c.target.field)).sort();
    expect(targets).toEqual(['o-kista:windowEnd', 'o-lindqvist:joint', 'o-roslagen:joint']);
    const shift = first.concessions.find((c) => c.target.kind === 'offer' && c.target.field === 'windowEnd')!;
    expect(shift.to).toBe('2026-11-19T17:00:00.000Z');
    expect(first.coalition!.id).toBe('joint:shared:o-roslagen>o-lindqvist');
    const split = first.coalition!.split.reduce((a, s) => a + s.share.minor, 0);
    const after = applyConcessions(world, intent, first.concessions);
    const r = await solve(after.world, after.intent, { explain: false });
    const joint = r.plan!.allocations.find((a) => a.offer === first.coalition!.id)!;
    expect(split).toBe(joint.cost.minor);
  }, 60000);

  it('solves the published and the agreed market quickly', async () => {
    let t = performance.now();
    await solve(world, intent, { explain: false });
    const published = performance.now() - t;
    const after = applyCertificate(world, intent, certificate);
    t = performance.now();
    await solve(after.world, after.intent);
    const agreed = performance.now() - t;
    expect(published).toBeLessThan(2000);
    expect(agreed).toBeLessThan(2000);
  });
});

describe('flagship recovery after Lindqvist withdraws', async () => {
  const agreed = applyConcessions(world, intent, certificate.concessions);
  const plan = (await solve(agreed.world, agreed.intent, { explain: false })).plan!;
  const disrupted = structuredClone(agreed.world);
  disrupted.actors = disrupted.actors.map((a) => (a.id === 'a-lindqvist' ? { ...a, active: false } : a));
  const kept = plan.allocations.filter((a) => a.offer !== 'joint:shared:o-roslagen>o-lindqvist');

  it('proves no repair exists on current terms while keeping commitments', async () => {
    const r = await solve(disrupted, agreed.intent, { fixed: kept, objective: 'repair', baseline: plan.allocations });
    expect(r.status).toBe('infeasible');
    expect(r.core!.summary).toMatch(/keeping the accepted commitments/);
  });

  it('proposes the Roslagen and Mälardalen van without touching kept commitments', async () => {
    const ivs = await findInterventions(disrupted, agreed.intent, { fixed: kept });
    expect(ivs[0]!.coalition!.id).toBe('joint:shared:o-roslagen>o-malardalen');
    expect(ivs[0]!.concessions.every((c) => c.target.kind === 'offer' && ['o-roslagen', 'o-malardalen'].includes(c.target.offer))).toBe(true);
  });

  it('repairs at 54 200 kr keeping every accepted allocation, where a free re-plan would drop Nacka', async () => {
    const backup = truth.recovery!.valid.certificate.concessions.filter((c) => c.target.kind === 'offer' && c.target.field === 'joint');
    const next = applyConcessions(disrupted, agreed.intent, backup);
    const r = await solve(next.world, next.intent, { fixed: kept, objective: 'repair', baseline: plan.allocations });
    expect(r.status).toBe('optimal');
    expect(r.plan!.total.minor).toBe(5_420_000);
    for (const k of kept) expect(r.plan!.allocations).toContainEqual(k);
    expect(verifyPlan(r.plan!, next.world, next.intent, { fixed: kept }).ok).toBe(true);
    expect(validatePlan(r.plan!, next.world, next.intent)).toEqual([]);
    const free = await solve(next.world, next.intent, { explain: false });
    expect(free.plan!.total.minor).toBe(5_320_000);
    expect(free.plan!.allocations.some((a) => a.offer === 'o-nacka')).toBe(false);
  });
});
