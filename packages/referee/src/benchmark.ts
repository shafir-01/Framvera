import { emptyRecord, judge, tryRecovery } from './evaluate.ts';
import { runStrategy, type RunConfig } from './strategies.ts';
import { STRATEGIES, type Deps, type Family, type RunRecord, type StrategyId } from './types.ts';

export interface BenchOptions {
  seeds: number;
  base: number;
  families: Family[];
  strategies: StrategyId[];
  budget: number;
  timeLimitMs: number;
  maxChanges: number;
  rounds: number;
  onProgress?: (done: number, total: number) => void;
}

export const DEFAULTS = {
  seeds: 100, base: 910_000, families: ['feasible', 'salvageable', 'impossible'] as Family[], strategies: STRATEGIES,
  budget: 8, timeLimitMs: 5000, maxChanges: 3, rounds: 3,
};

const FAMILY_OFFSET: Record<Family, number> = { feasible: 0, salvageable: 1_000_000, impossible: 2_000_000 };

export function heldOutSeed(base: number, family: Family, i: number): number {
  return base + FAMILY_OFFSET[family] + i;
}

export async function runBenchmark(deps: Deps, opts: BenchOptions): Promise<{ records: RunRecord[]; solver?: { name: string; version: string } }> {
  const flagshipSeed = deps.market.flagshipWorld().world.seed;
  const records: RunRecord[] = [];
  let solver: { name: string; version: string } | undefined;
  const total = opts.seeds * opts.families.length;
  let done = 0;
  for (const family of opts.families) {
    for (let i = 0; i < opts.seeds; i++) {
      const seed = heldOutSeed(opts.base, family, i);
      if (seed === flagshipSeed) throw new Error(`seed ${seed} collides with the flagship world`);
      const { world, intent, truth } = deps.market.generateWorld(seed, family);
      const cfg: RunConfig = { budget: opts.budget, timeLimitMs: opts.timeLimitMs, maxChanges: opts.maxChanges, rounds: opts.rounds, seed };
      const initial = await deps.solver.solve(world, intent, { timeLimitMs: opts.timeLimitMs });
      solver ??= { name: initial.solver.name, version: initial.solver.version };
      const rows: RunRecord[] = [];
      for (const strategy of opts.strategies) {
        const rec = emptyRecord({ seed, family, strategy, initialStatus: initial.status });
        const t0 = performance.now();
        try {
          const out = await runStrategy(strategy, deps, world, intent, truth, cfg);
          const j = judge(deps, out, truth, family);
          rec.claimed = out.claimed;
          rec.trulyFeasible = j.trulyFeasible;
          rec.falseReasons = j.falseReasons;
          rec.falseClaim = out.claimed && j.falseReasons.length > 0;
          rec.invariantViolations = j.invariantViolations;
          rec.questions = out.questions;
          rec.accepted = out.accepted;
          rec.costMinor = out.plan && out.claimed ? out.plan.total.minor : null;
          rec.solveMs = out.solveMs;
          rec.notes = out.notes;
          if (j.trulyFeasible) {
            try {
              const r = await tryRecovery(deps, out, truth);
              rec.recovery = { attempted: r.attempted, success: r.success, affected: r.affected, note: r.note };
              rec.invariantViolations.push(...r.invariants);
            } catch (e) {
              rec.recovery = { attempted: true, success: false, affected: 0, note: `recovery error: ${e instanceof Error ? e.message : String(e)}` };
            }
          }
        } catch (e) {
          rec.error = e instanceof Error ? e.message : String(e);
        }
        rec.wallMs = performance.now() - t0;
        rows.push(rec);
      }
      const oracle = rows.find((r) => r.strategy === 'oracle');
      for (const r of rows) r.oracleCostMinor = oracle?.trulyFeasible ? oracle.costMinor : null;
      records.push(...rows);
      opts.onProgress?.(++done, total);
    }
  }
  return { records, solver };
}
