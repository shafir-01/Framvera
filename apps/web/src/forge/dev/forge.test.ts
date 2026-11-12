import { describe, expect, it } from 'vitest';
import { solve, verifyPlan } from '@framvera/solver';
import { splitCoalition } from '../../../../../packages/negotiation/src/coalition.ts';
import { analyze, memberViews, type ForgeEngine } from '../analyze.ts';
import { draft } from '../model.ts';
import { intent, outside, world } from './fixture.ts';

const engine: ForgeEngine = {
  solve: (w, i, o) => solve(w, i, o as never),
  verify: (p, w, i) => verifyPlan(p, w, i),
  split: splitCoalition as never,
};
const fmt = (m: { minor: number }) => `${m.minor / 100} kr`;

describe('draft', () => {
  it('flags a shared van counted twice and caps it at its real size', () => {
    const d = draft(world, intent, 'delivery', ['a_arsta', 'a_varta'])!;
    expect(d.conflicts.map((c) => c.kind)).toEqual(['shared-capacity']);
    expect(d.covered).toBe(500);
    expect(d.covers).toBe(true);
    expect(d.lanes.reduce((a, l) => a + l.allotted, 0)).toBeLessThanOrEqual(500);
  });
  it('does not cover with one half-van', () => {
    const d = draft(world, intent, 'delivery', ['a_arsta'])!;
    expect(d.covers).toBe(false);
    expect(d.conflicts).toHaveLength(0);
  });
  it('counts independent capacity in full', () => {
    const d = draft(world, intent, 'delivery', ['a_arsta', 'a_norrtull'])!;
    expect(d.covered).toBe(520);
    expect(d.conflicts).toHaveLength(0);
  });
  it('does not let a pooled pair of 260 plus 260 cover when the van holds 400', () => {
    const d = draft(world, intent, 'delivery', ['a_solna', 'a_bromma'])!;
    expect(d.covered).toBe(400);
    expect(d.covers).toBe(false);
  });
});

describe('analyze with the real solver', () => {
  it('prices a covering coalition and splits it exactly', async () => {
    const a = (await analyze(engine, world, intent, 'delivery', ['a_arsta', 'a_norrtull'], { outside }))!;
    expect(a.report?.status).toMatch(/optimal|feasible/);
    expect(a.verification?.ok).toBe(true);
    expect(a.split).toBeDefined();
    const total = a.split!.split.reduce((s, x) => s + x.share.minor, 0);
    expect(total).toBe(a.split!.analysis.payment.minor);
    expect(a.split!.analysis.method).toBe('shapley-exact');
    const views = memberViews(a, fmt, (id) => id);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) expect(v.line).not.toMatch(/agreed/);
  });
  it('reports idle members that add nothing', async () => {
    const a = (await analyze(engine, world, intent, 'delivery', ['a_arsta', 'a_hagsatra', 'a_norrtull'], { outside }))!;
    expect(a.report?.plan).toBeDefined();
    const all = [...a.used, ...a.idle].sort();
    expect(all).toEqual(['a_arsta', 'a_hagsatra', 'a_norrtull']);
  });
  it('stops before solving when the stage is not covered', async () => {
    const a = (await analyze(engine, world, intent, 'delivery', ['a_arsta']))!;
    expect(a.report).toBeUndefined();
  });
});
