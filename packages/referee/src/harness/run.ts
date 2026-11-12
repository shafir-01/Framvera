import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headline, summaryMarkdown, type Meta } from '../aggregate.ts';
import { DEFAULTS, heldOutSeed, runBenchmark } from '../benchmark.ts';
import { loadDeps } from '../deps.ts';
import type { Family, RunRecord, StrategyId } from '../types.ts';
import { HARNESS_DEFAULTS, harnessMeter, setHarnessOptions } from './index.ts';
import { MODEL_ID } from './meter.ts';

/**
 * Runs the model baseline on a small held-out slice and merges its rows into the referee output.
 * Usage: node --env-file=.env --import tsx packages/referee/src/harness/run.ts --seeds 12
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const seeds = Number(get('seeds') ?? 12);
  const base = Number(get('base') ?? DEFAULTS.base);
  const families = (get('families')?.split(',') ?? DEFAULTS.families) as Family[];
  const maxTurns = Number(get('max-turns') ?? HARNESS_DEFAULTS.maxTurns);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const out = resolve(get('out') ?? resolve(root, 'evaluation'));
  const file = resolve(out, 'results.json');

  setHarnessOptions({ maxTurns });
  const meter = harnessMeter();
  const worlds = seeds * families.length;
  if (worlds * maxTurns > meter.remaining) {
    console.error(`worst case ${worlds * maxTurns} calls exceeds the ${meter.remaining} remaining; episodes past the budget are dropped, not scored`);
  }

  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { meta: Meta; records: RunRecord[] }) : null;
  const strategies: StrategyId[] = existing ? ['agent-harness', 'oracle'] : ['agent-harness', 'framvera', 'oracle', 'optimizer', 'direct'];
  const deps = await loadDeps();
  const before = meter.state.calls;
  const { records, solver } = await runBenchmark(deps, {
    ...DEFAULTS, seeds, base, families, strategies, onProgress: (d, t) => console.error(`worlds ${d}/${t}, model calls ${meter.state.calls}`),
  });

  const dropped = records.filter((r) => r.strategy === 'agent-harness' && /budget of \d+ reached/.test(r.error ?? ''));
  const agentRows = records.filter((r) => r.strategy === 'agent-harness' && !dropped.includes(r));
  const keep = existing ? agentRows : records.filter((r) => !dropped.includes(r) && !(r.strategy !== 'agent-harness' && dropped.some((d) => d.seed === r.seed && d.family === r.family)));
  const merged = [...(existing?.records.filter((r) => r.strategy !== 'agent-harness') ?? []), ...keep];
  const spend = meter.state;
  const agentHarness = {
    model: MODEL_ID, worldsPerFamily: seeds, maxTurnsPerEpisode: maxTurns, supplierQuestionBudget: DEFAULTS.budget,
    modelCalls: spend.calls, callBudget: spend.budgetCalls, inputTokens: spend.inputTokens, outputTokens: spend.outputTokens,
    scoredWorlds: agentRows.length, droppedForBudget: dropped.length,
  };
  const heldOutSeeds: Meta['heldOutSeeds'] = existing?.meta.heldOutSeeds ?? {};
  if (!existing) for (const f of families) heldOutSeeds[f] = { first: heldOutSeed(base, f, 0), last: heldOutSeed(base, f, Math.max(0, seeds - 1)) };
  const meta: Meta = existing
    ? { ...existing.meta, args: { ...existing.meta.args, agentHarness } }
    : {
        generatedAt: new Date().toISOString(), node: process.version, solver, heldOutSeeds,
        args: { seeds, base, families, strategies, budget: DEFAULTS.budget, timeLimitMs: DEFAULTS.timeLimitMs, maxChanges: DEFAULTS.maxChanges, rounds: DEFAULTS.rounds, agentHarness },
        boundary: 'Strategies receive only the published world, the intent and an ask function; policies, real capacities and shocks stay inside the referee closure. It is a code-level boundary within one process.',
      };
  mkdirSync(out, { recursive: true });
  writeFileSync(file, JSON.stringify({ meta, records: merged }, null, 2));
  writeFileSync(resolve(out, 'SUMMARY.md'), summaryMarkdown(merged, meta));
  writeFileSync(resolve(out, 'headline.json'), JSON.stringify(headline(merged, meta), null, 2));
  console.error(`agent rows ${agentRows.length}, dropped ${dropped.length}, calls this run ${spend.calls - before}, total ${spend.calls}/${spend.budgetCalls}, est usd ${spend.usdEstimate}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
