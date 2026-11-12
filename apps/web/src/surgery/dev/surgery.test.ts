import { describe, expect, it } from 'vitest';
import type { InfeasibleCore, Intent, Intervention, World } from '@framvera/contracts';
import { applyConcessions, solve } from '@framvera/solver';
import { flagshipWorld } from '@framvera/market';
import { allLevers, applyWhatIf, deltaFor, expressible, jointLevers, leversFor, leverValue, suppliersAsked, tightest, toConcessions, type Lever } from '../levers.ts';
import { makeBranch } from '../branch.ts';
import data from './flagship.json';

const fixture = { world: data.world as unknown as World, intent: data.intent as unknown as Intent, core: data.core as unknown as InfeasibleCore, interventions: data.interventions as unknown as Intervention[] };

const feasible = async (world: World, intent: Intent, levers: Record<string, number>, map: Map<string, Lever>) => {
  const cs = Object.entries(levers).flatMap(([k, d]) => toConcessions(map.get(k)!, d, world, intent));
  const a = applyConcessions(world, intent, cs);
  const r = await solve(a.world, a.intent, { explain: false, timeLimitMs: 10000 });
  return r.status;
};

describe('levers', () => {
  const { world, intent } = flagshipWorld();
  const levers = allLevers(world, intent, jointLevers(fixture.interventions, world));
  const map = new Map(levers.map((l) => [l.key, l]));

  it('only offers fields a supplier marked negotiable, and every concession applies to the right field', () => {
    for (const l of levers) {
      if (l.own || l.joint) continue;
      const offer = world.offers.find((o) => o.id === l.offer)!;
      expect(offer.negotiable).toContain(l.field);
      const [c] = toConcessions(l, l.grain * 3, world, intent);
      const a = applyConcessions(world, intent, [c!]);
      const after = a.world.offers.find((o) => o.id === l.offer)!;
      if (l.field === 'windowEnd') expect(Date.parse(after.window.end) - Date.parse(offer.window.end)).toBe(3 * 60_000);
      if (l.field === 'windowStart') expect(Date.parse(offer.window.start) - Date.parse(after.window.start)).toBe(3 * 60_000);
      if (l.field === 'capacity') expect(after.capacity).toBe(offer.capacity + 3);
      if (l.field === 'unitPrice') expect(after.tiers[0]!.unit.minor).toBe(offer.tiers[0]!.unit.minor - 30);
      expect(world.offers.find((o) => o.id === l.offer)).toEqual(offer);
    }
  });

  it('labels the user own terms as intent concessions that ask no supplier', () => {
    const budget = map.get('intent:budget')!;
    const cs = toConcessions(budget, 300_000, world, intent);
    expect(budget.own).toBe(true);
    expect(cs[0]!.target).toEqual({ kind: 'intent', field: 'budget' });
    expect(cs[0]!.to).toBe(intent.budget.minor + 300_000);
    expect(suppliersAsked(cs, world)).toEqual([]);
    expect(applyWhatIf(world, intent, cs).intent.budget.minor).toBe(intent.budget.minor + 300_000);
    expect(leverValue(map.get('intent:deadline')!, 90)).toBe(new Date(Date.parse(intent.deadline) + 90 * 60_000).toISOString());
  });

  it('places every planner intervention exactly onto the sliders and back', () => {
    for (const iv of fixture.interventions) {
      const placed = expressible(iv, levers);
      expect(placed).not.toBeNull();
      const rebuilt = placed!.flatMap((p) => toConcessions(map.get(p.key)!, p.delta, world, intent));
      const a = applyConcessions(world, intent, rebuilt);
      const b = applyConcessions(world, intent, iv.concessions);
      expect(a.world.offers.map((o) => [o.id, o.capacity, o.window, o.tiers])).toEqual(b.world.offers.map((o) => [o.id, o.capacity, o.window, o.tiers]));
      for (const c of iv.concessions) expect(deltaFor(c, levers)).not.toBeNull();
    }
  });

  it('gives each blocking constraint only levers that touch it', () => {
    for (const ref of fixture.core.constraints) {
      for (const l of leversFor(ref, world, intent, jointLevers(fixture.interventions, world))) {
        if (l.own) expect(['deadline', 'budget']).toContain(ref.kind);
        else if (!l.joint && (ref.kind === 'capacity' || ref.kind === 'window' || ref.kind === 'min-qty')) expect(l.offer).toBe(ref.subject);
      }
    }
  });
});

describe('real solver behind the sliders', () => {
  const { world, intent } = fixture;
  const levers = allLevers(world, intent, jointLevers(fixture.interventions, world));
  const map = new Map(levers.map((l) => [l.key, l]));

  it('the flagship is impossible as published and a planner suggestion placed on the sliders makes it possible', async () => {
    expect(await feasible(world, intent, {}, map)).toBe('infeasible');
    const placed = expressible(fixture.interventions[0]!, levers)!;
    expect(await feasible(world, intent, Object.fromEntries(placed.map((p) => [p.key, p.delta])), map)).toMatch(/optimal|feasible/);
  });

  it('feasibility is monotone along a lever, so the frontier threshold search is exact', async () => {
    const placed = expressible(fixture.interventions[0]!, levers)!;
    const window = placed.find((p) => map.get(p.key)!.field === 'windowEnd')!;
    const others = Object.fromEntries(placed.filter((p) => p !== window).map((p) => [p.key, p.delta]));
    const l = map.get(window.key)!;
    const statuses: string[] = [];
    for (let d = 0; d <= l.max; d += Math.round(l.max / 12)) statuses.push(await feasible(world, intent, { ...others, [l.key]: d }, map));
    const firstOk = statuses.findIndex((s) => s !== 'infeasible');
    expect(firstOk).toBeGreaterThan(0);
    expect(statuses.slice(firstOk).every((s) => s === 'optimal' || s === 'feasible')).toBe(true);
    let lo = 0;
    let hi = l.max;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await feasible(world, intent, { ...others, [l.key]: mid }, map)) === 'infeasible') lo = mid;
      else hi = mid;
    }
    expect(await feasible(world, intent, { ...others, [l.key]: hi }, map)).not.toBe('infeasible');
    expect(await feasible(world, intent, { ...others, [l.key]: hi - 1 }, map)).toBe('infeasible');
  });

  it('tightest limits are exact arithmetic on the plan', async () => {
    const placed = expressible(fixture.interventions[0]!, levers)!;
    const cs = placed.flatMap((p) => toConcessions(map.get(p.key)!, p.delta, world, intent));
    const a = applyConcessions(world, intent, cs);
    const r = await solve(a.world, a.intent, { explain: false });
    const t = tightest(r.plan!, a.world, a.intent);
    const budget = t.find((x) => x.id === 'budget')!;
    expect(budget.room).toBeCloseTo((a.intent.budget.minor - r.plan!.total.minor) / a.intent.budget.minor, 10);
    for (let i = 1; i < t.length; i++) expect(t[i]!.room).toBeGreaterThanOrEqual(t[i - 1]!.room);
  });
});

describe('branches', () => {
  it('are frozen copies, never agreements, and do not alias the market', () => {
    const { world, intent } = fixture;
    const cs = fixture.interventions[0]!.concessions;
    const b = makeBranch({ label: 'A', world, intent: intent.id, concessions: cs, deltas: { x: 1 }, status: 'possible', optimal: true });
    expect(b.agreed).toBe(false);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.concessions[0])).toBe(true);
    expect(b.concessions[0]).not.toBe(cs[0]);
    expect(Object.isFrozen(cs[0])).toBe(false);
    expect(b.suppliersAsked.length).toBe(new Set(cs.filter((c) => c.target.kind === 'offer').map((c) => world.offers.find((o) => o.id === (c.target as { offer: string }).offer)!.actor)).size);
  });
});
