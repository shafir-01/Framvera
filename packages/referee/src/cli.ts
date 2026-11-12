import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headline, summaryMarkdown, type Meta } from './aggregate.ts';
import { DEFAULTS, heldOutSeed, runBenchmark, type BenchOptions } from './benchmark.ts';
import { loadDeps } from './deps.ts';
import { STRATEGIES, type Family, type StrategyId } from './types.ts';

function parseArgs(argv: string[]): BenchOptions & { out: string } {
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (k: string, d: number) => { const v = get(k); if (v === undefined) return d; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a non-negative number`); return n; };
  const fams = get('families')?.split(',') as Family[] | undefined;
  const strs = get('strategies')?.split(',') as StrategyId[] | undefined;
  for (const s of strs ?? []) if (!STRATEGIES.includes(s)) throw new Error(`unknown strategy ${s}`);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return {
    seeds: num('seeds', DEFAULTS.seeds), base: num('base', DEFAULTS.base), families: fams ?? DEFAULTS.families,
    strategies: strs ?? DEFAULTS.strategies, budget: num('budget', DEFAULTS.budget), timeLimitMs: num('time-limit', DEFAULTS.timeLimitMs),
    maxChanges: num('max-changes', DEFAULTS.maxChanges), rounds: num('rounds', DEFAULTS.rounds),
    out: resolve(get('out') ?? resolve(root, 'evaluation')),
    onProgress: (d, t) => { if (d % 10 === 0 || d === t) console.error(`worlds ${d}/${t}`); },
  };
}

async function main(): Promise<void> {
  const { out, ...opts } = parseArgs(process.argv.slice(2));
  const deps = await loadDeps();
  const { records, solver } = await runBenchmark(deps, opts);
  const heldOutSeeds: Meta['heldOutSeeds'] = {};
  for (const f of opts.families) heldOutSeeds[f] = { first: heldOutSeed(opts.base, f, 0), last: heldOutSeed(opts.base, f, Math.max(0, opts.seeds - 1)) };
  const meta: Meta = {
    generatedAt: new Date().toISOString(), node: process.version, solver, heldOutSeeds,
    args: { seeds: opts.seeds, base: opts.base, families: opts.families, strategies: opts.strategies, budget: opts.budget, timeLimitMs: opts.timeLimitMs, maxChanges: opts.maxChanges, rounds: opts.rounds },
    boundary: 'Strategies receive only the published world, the intent and an ask function; policies, real capacities and shocks stay inside the referee closure. It is a code-level boundary within one process.',
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'results.json'), JSON.stringify({ meta, records }, null, 2));
  writeFileSync(resolve(out, 'SUMMARY.md'), summaryMarkdown(records, meta));
  writeFileSync(resolve(out, 'headline.json'), JSON.stringify(headline(records, meta), null, 2));
  console.error(`wrote ${records.length} rows to ${out}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
