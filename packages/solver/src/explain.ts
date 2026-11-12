import type { Allocation, ConstraintRef, InfeasibleCore, Intent, World } from '@framvera/contracts';
import { compile, type Compiled } from './compile.ts';
import { run, runMany, type RunResult } from './lp.ts';
import { fmtMoney, fmtTime } from './text.ts';

export interface ExplainOptions {
  fixed?: Allocation[];
  capacity?: 'effective' | 'claimed';
  timeLimitMs?: number;
}

/** Groups earlier in this order are dropped first when several explanations exist, so later kinds are cited. */
const ORDER: Record<ConstraintRef['kind'], number> = {
  window: 0,
  'min-qty': 1,
  capacity: 2,
  'exclusive-resource': 3,
  validity: 4,
  precedence: 5,
  demand: 6,
  budget: 7,
  deadline: 8,
};

type Feas = 'feasible' | 'infeasible' | 'unknown';

/** The order itself and the order of production steps are held fixed; they are never offered as the thing to relax. */
export const STRUCTURAL: ReadonlySet<ConstraintRef['kind']> = new Set(['demand', 'precedence']);

/**
 * Deletion filter over constraint groups. Demand and step order stay fixed throughout. The result
 * is minimal with respect to the remaining groups: dropping any single member makes the problem
 * feasible. It is not claimed to be the smallest such set.
 */
export async function explainWith(build: (disabled: ReadonlySet<string>) => Compiled, timeLimitMs = 20000): Promise<InfeasibleCore> {
  const c = build(new Set());
  const t0 = performance.now();
  const perTest = Math.max(500, Math.min(3000, timeLimitMs / 4));
  const disabled = new Set<string>();
  const modelFor = (extra: string[]) => {
    const model = build(new Set([...disabled, ...extra])).model;
    model.objective = [];
    return model;
  };
  const feas = (r: RunResult): Feas =>
    r.status === 'infeasible' ? 'infeasible' : r.status === 'optimal' || r.status === 'timeout-with-solution' ? 'feasible' : 'unknown';
  const test = async (extra: string[]): Promise<Feas> => {
    if (performance.now() - t0 > timeLimitMs) return 'unknown';
    return feas(await run(modelFor(extra), { timeLimitMs: perTest }));
  };

  const first = await test([]);
  if (first !== 'infeasible') {
    return {
      constraints: [],
      method: 'deletion-filter',
      minimal: false,
      proven: false,
      summary: first === 'feasible' ? 'A plan exists under the current offers.' : 'The solver could not decide within the time limit.',
    };
  }

  const groups = [...c.refs.keys()].filter((g) => !STRUCTURAL.has(c.refs.get(g)!.kind)).sort((a, b) => ORDER[c.refs.get(a)!.kind] - ORDER[c.refs.get(b)!.kind]);
  let minimal = true;

  // A group whose removal alone restores feasibility stays necessary in every subset, so these
  // single-group tests run side by side and their verdicts hold for the rest of the search.
  const single = await runMany(groups.map((g) => modelFor([g])), { timeLimitMs: perTest });
  const necessary = new Set(groups.filter((_, i) => feas(single[i]!) === 'feasible'));
  if (single.some((r) => feas(r) === 'unknown')) minimal = false;

  // Removing a longer prefix of the remaining list can only make a plan easier to find, so the longest
  // prefix that keeps the problem infeasible is located with parallel probes. The group right after it
  // is necessary for the set that remains.
  let remaining = groups.filter((g) => !necessary.has(g));
  const probes = 6;
  while (remaining.length) {
    if (performance.now() - t0 > timeLimitMs) {
      minimal = false;
      break;
    }
    let lo = 0;
    let hi = remaining.length + 1;
    let first = true;
    while (hi - lo > 1) {
      const spread = [...new Set(Array.from({ length: probes }, (_, i) => lo + Math.round(((i + 1) * (hi - lo)) / (probes + 1))))];
      const points = [...new Set(first ? [...spread.slice(0, probes - 1), remaining.length] : spread)].filter((L) => L > lo && L < hi);
      first = false;
      const results = await runMany(points.map((L) => modelFor(remaining.slice(0, L))), { timeLimitMs: perTest });
      let newLo = lo;
      let newHi = hi;
      points.forEach((L, i) => {
        const f = feas(results[i]!);
        if (f === 'unknown') minimal = false;
        if (f === 'infeasible') newLo = Math.max(newLo, L);
      });
      points.forEach((L, i) => {
        if (L > newLo && feas(results[i]!) !== 'infeasible') newHi = Math.min(newHi, L);
      });
      lo = newLo;
      hi = newHi;
    }
    for (const g of remaining.slice(0, lo)) disabled.add(g);
    if (lo >= remaining.length) break;
    necessary.add(remaining[lo]!);
    remaining = remaining.slice(lo + 1);
  }

  const core = groups.filter((g) => !disabled.has(g)).map((g) => c.refs.get(g)!);
  return { constraints: core, method: 'deletion-filter', minimal, proven: true, summary: summarize(core, c.intent, minimal, !!c.offers.some((o) => o.fixed)) };
}

function summarize(core: ConstraintRef[], intent: Intent, minimal: boolean, withFixed: boolean): string {
  const parts: string[] = [];
  if (core.some((r) => r.kind === 'deadline')) parts.push(`ready by ${fmtTime(intent.deadline)}`);
  if (core.some((r) => r.kind === 'budget')) parts.push(`within ${fmtMoney(intent.budget)}`);
  const kept = withFixed ? ' while keeping the accepted commitments' : '';
  const head = parts.length
    ? `No combination of the published offers is ${parts.join(' and ')}${kept}.`
    : `No combination of the published offers meets the request${kept}.`;
  const n = core.length;
  const scope = `For the full order, with the production steps in their required order, these ${n} conditions cannot all hold at once`;
  const tail = minimal ? ` ${scope}. Relaxing any single one of them would make a plan possible.` : ` ${scope}.`;
  return head + tail;
}

export async function explainInfeasible(world: World, intent: Intent, opts: ExplainOptions = {}): Promise<InfeasibleCore> {
  return explainWith((disabled) => compile(world, intent, { fixed: opts.fixed, capacity: opts.capacity, disabled }), opts.timeLimitMs ?? 20000);
}
