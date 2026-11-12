import { describe, expect, it } from 'vitest';
import { cells, headline, summaryMarkdown, type Meta } from '../src/aggregate.ts';
import { DEFAULTS, heldOutSeed, runBenchmark } from '../src/benchmark.ts';
import { createBoundary } from '../src/boundary.ts';
import { buildDirectPlan } from '../src/direct.ts';
import { judge } from '../src/evaluate.ts';
import { quantile, rng, wilson } from '../src/stats.ts';
import { fakeDeps, fakeGenerate } from './fakes.ts';

const opts = { ...DEFAULTS, seeds: 6 };
const meta: Meta = { generatedAt: 'now', node: 'x', args: { budget: 8 }, heldOutSeeds: { feasible: { first: 1, last: 2 }, salvageable: { first: 1, last: 2 }, impossible: { first: 1, last: 2 } }, boundary: 'b' };

describe('stats', () => {
  it('wilson interval brackets the point estimate and handles 0/0', () => {
    const [lo, hi] = wilson(8, 10) as [number, number];
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 10)?.[0]).toBe(0);
  });
  it('quantile and rng are deterministic', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(rng(5)()).toBe(rng(5)());
  });
});

describe('direct procurement', () => {
  it('buys from the cheapest feasible offer', () => {
    const { world, intent } = fakeGenerate(1, 'feasible');
    const p = buildDirectPlan(world, intent);
    expect(p?.allocations[0]?.offer).toBe('oa');
    expect(p?.total.minor).toBe(10_000);
  });
  it('returns null when a stage cannot be sourced', () => {
    const { world, intent } = fakeGenerate(1, 'impossible');
    expect(buildDirectPlan(world, intent)).toBeNull();
  });
});

describe('boundary', () => {
  it('counts questions and answers only from held policies', () => {
    const deps = fakeDeps();
    const { world, truth } = fakeGenerate(1, 'salvageable');
    const b = createBoundary(deps, truth, world);
    const msg = deps.negotiation.selectQuestions(world, fakeGenerate(1, 'salvageable').intent, [], 1);
    expect(msg).toEqual([]);
    const m = { type: 'Propose', id: 'x', from: 'buyer', to: 'ghost', concession: {} as never, expires: '', at: '' } as const;
    expect(b.ask(m).accept).toBe(false);
    expect(b.asked).toBe(1);
    expect(b.hindsight(m).accept).toBe(false);
    expect(b.asked).toBe(1);
  });
});

describe('benchmark', () => {
  it('separates the strategies by their real capabilities', async () => {
    const { records } = await runBenchmark(fakeDeps(), opts);
    const c = (f: string, s: string) => cells(records).find((x) => x.family === f && x.strategy === s)!;
    expect(c('salvageable', 'optimizer').feasible.k).toBe(0);
    expect(c('salvageable', 'framvera').feasible.k).toBe(6);
    expect(c('salvageable', 'oracle').feasible.k).toBe(6);
    expect(c('feasible', 'optimizer').feasible.k).toBe(6);
    expect(c('salvageable', 'framvera').falseClaims.k).toBe(0);
    expect(c('salvageable', 'framvera').questionsMean).toBeGreaterThan(0);
    expect(c('salvageable', 'oracle').questionsTotal).toBe(0);
    expect(c('salvageable', 'framvera').recovery.success.k).toBe(c('salvageable', 'framvera').recovery.attempted);
  });

  it('never counts a success in the impossible family', async () => {
    const { records } = await runBenchmark(fakeDeps(), opts);
    const imp = records.filter((r) => r.family === 'impossible');
    expect(imp.every((r) => !r.trulyFeasible)).toBe(true);
    expect(imp.every((r) => !r.claimed)).toBe(true);
  });

  it('flags every claimed success in the impossible family as false', async () => {
    const { records } = await runBenchmark(fakeDeps({ lie: true }), { ...opts, families: ['impossible'], strategies: ['optimizer'] });
    expect(records).toHaveLength(6);
    expect(records.every((r) => r.claimed && r.falseClaim)).toBe(true);
    expect(records[0]?.falseReasons.join()).toContain('impossible');
  });

  it('catches a plan the verifier rejects', () => {
    const deps = fakeDeps();
    const { world, intent, truth } = fakeGenerate(1, 'salvageable');
    const plan = { id: 'p', worldVersion: 1, intent: 'i', allocations: [{ offer: 'oa', actor: 'a', stage: 's', qty: 100, start: '', finish: '', cost: { currency: 'SEK' as const, minor: 1 } }], total: { currency: 'SEK' as const, minor: 1 }, readyAt: '', objective: '' };
    const j = judge(deps, { claimed: true, plan, world, intent, questions: 0, accepted: 0, decisions: [], solveMs: 0, notes: [] }, truth, 'salvageable');
    expect(j.trulyFeasible).toBe(false);
    expect(j.invariantViolations.length).toBeGreaterThan(0);
  });

  it('uses seeds disjoint across families and rejects the flagship seed', async () => {
    expect(heldOutSeed(1, 'salvageable', 0)).not.toBe(heldOutSeed(1, 'impossible', 0));
    const deps = fakeDeps();
    deps.market.flagshipWorld = () => fakeGenerate(heldOutSeed(opts.base, 'feasible', 0), 'feasible');
    await expect(runBenchmark(deps, { ...opts, seeds: 1 })).rejects.toThrow(/flagship/);
  });

  it('reports every number from raw rows', async () => {
    const { records } = await runBenchmark(fakeDeps(), opts);
    const md = summaryMarkdown(records, meta);
    const sal = cells(records).find((x) => x.family === 'salvageable' && x.strategy === 'framvera')!;
    expect(md).toContain(`${sal.feasible.k}/${sal.feasible.n}`);
    expect(md).toContain('Unfavourable and notable results');
    const h = headline(records, meta);
    expect(h.claim?.framveraFeasible).toEqual([sal.feasible.k, sal.feasible.n]);
    expect(records.every((r) => r.hindsight === (r.strategy === 'oracle'))).toBe(true);
  });
});
