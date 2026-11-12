import { mean, meanCI, quantile, wilson, type Interval } from './stats.ts';
import type { Family, RunRecord, StrategyId } from './types.ts';

export interface Rate { k: number; n: number; ci: Interval | null }

export interface Cell {
  family: Family;
  strategy: StrategyId;
  hindsight: boolean;
  n: number;
  errors: number;
  claimed: Rate;
  /** Verified feasible among all worlds of the family. */
  feasible: Rate;
  /** Verified feasible among worlds where the published market is infeasible. */
  infeasibleToFeasible: Rate;
  falseClaims: Rate;
  questionsMean: number | null;
  questionsTotal: number;
  acceptance: Rate;
  costVsOracle: { mean: number; ci: Interval; n: number } | null;
  invariantViolations: { total: number; worlds: number };
  recovery: { attempted: number; success: Rate };
  solveMs: { mean: number | null; p95: number | null };
}

const rate = (k: number, n: number): Rate => ({ k, n, ci: wilson(k, n) });

export function cell(records: RunRecord[], family: Family, strategy: StrategyId): Cell {
  const rs = records.filter((r) => r.family === family && r.strategy === strategy);
  const infeasible = rs.filter((r) => r.initialStatus === 'infeasible');
  const claimed = rs.filter((r) => r.claimed);
  const asked = rs.reduce((a, r) => a + r.questions, 0);
  const ratios = rs
    .filter((r) => r.trulyFeasible && r.costMinor !== null && r.oracleCostMinor)
    .map((r) => (r.costMinor as number) / (r.oracleCostMinor as number));
  const rec = rs.filter((r) => r.recovery?.attempted);
  return {
    family, strategy, hindsight: strategy === 'oracle', n: rs.length,
    errors: rs.filter((r) => r.error).length,
    claimed: rate(claimed.length, rs.length),
    feasible: rate(rs.filter((r) => r.trulyFeasible).length, rs.length),
    infeasibleToFeasible: rate(infeasible.filter((r) => r.trulyFeasible).length, infeasible.length),
    falseClaims: rate(rs.filter((r) => r.falseClaim).length, claimed.length),
    questionsMean: mean(rs.map((r) => r.questions)),
    questionsTotal: asked,
    acceptance: rate(rs.reduce((a, r) => a + r.accepted, 0), asked),
    costVsOracle: meanCI(ratios),
    invariantViolations: {
      total: rs.reduce((a, r) => a + r.invariantViolations.length, 0),
      worlds: rs.filter((r) => r.invariantViolations.length > 0).length,
    },
    recovery: { attempted: rec.length, success: rate(rec.filter((r) => r.recovery?.success).length, rec.length) },
    solveMs: { mean: mean(rs.map((r) => r.solveMs)), p95: quantile(rs.map((r) => r.solveMs), 0.95) },
  };
}

export function cells(records: RunRecord[]): Cell[] {
  const fams = [...new Set(records.map((r) => r.family))];
  const strats = [...new Set(records.map((r) => r.strategy))];
  return fams.flatMap((f) => strats.map((s) => cell(records, f, s)));
}

export function falseReasonCounts(records: RunRecord[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of records) {
    if (!r.falseClaim) continue;
    const bucket = (out[r.strategy] ??= {});
    for (const reason of new Set(r.falseReasons.map((x) => x.replace(/ on .*$/, '').replace(/: .*$/, '')))) {
      bucket[reason] = (bucket[reason] ?? 0) + 1;
    }
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const fmtRate = (r: Rate) => (r.n === 0 ? 'n/a (0/0)' : `${r.k}/${r.n} (${pct(r.k / r.n)}, 95% CI ${pct((r.ci as Interval)[0])} to ${pct((r.ci as Interval)[1])})`);
const fmtNum = (x: number | null, d = 1) => (x === null ? 'n/a' : x.toFixed(d));
const fmtCost = (c: Cell['costVsOracle']) => (c ? `${c.mean.toFixed(3)}x (CI ${c.ci[0].toFixed(3)} to ${c.ci[1].toFixed(3)}, n=${c.n})` : 'n/a');

const LABEL: Record<StrategyId, string> = {
  direct: 'Direct procurement',
  optimizer: 'Conventional optimizer',
  'uniform-heuristic': 'Uniform heuristic negotiation',
  'random-relaxations': 'Random relaxations',
  framvera: 'Framvera (full)',
  'framvera-no-coalitions': 'Ablation: no coalitions',
  'framvera-no-voi': 'Ablation: no value-of-information',
  'framvera-no-claim-checks': 'Ablation: no claim checks',
  oracle: 'Oracle (hindsight, upper bound)',
  'agent-harness': 'Generic tool-using model baseline',
};
export const label = (s: StrategyId) => LABEL[s];

export interface Meta {
  generatedAt: string;
  node: string;
  args: Record<string, unknown>;
  solver?: { name: string; version: string };
  heldOutSeeds: Record<string, { first: number; last: number }>;
  boundary: string;
}

export function findings(cs: Cell[]): string[] {
  const out: string[] = [];
  const get = (f: Family, s: StrategyId) => cs.find((c) => c.family === f && c.strategy === s);
  const fv = (f: Family) => get(f, 'framvera');
  for (const c of cs) {
    if (c.errors) out.push(`${label(c.strategy)} raised errors in ${c.errors}/${c.n} ${c.family} worlds; those worlds count as failures.`);
    if (c.family === 'impossible' && c.claimed.k > 0) out.push(`${label(c.strategy)} claimed success in ${c.claimed.k}/${c.claimed.n} impossible worlds; every one is a false claim.`);
    else if (c.falseClaims.k > 0 && c.strategy !== 'oracle') out.push(`${label(c.strategy)} made ${c.falseClaims.k}/${c.falseClaims.n} false feasibility claims in ${c.family} worlds.`);
    if (c.invariantViolations.total > 0) out.push(`${label(c.strategy)} produced ${c.invariantViolations.total} invariant violations across ${c.invariantViolations.worlds} ${c.family} worlds.`);
  }
  for (const f of ['salvageable', 'feasible'] as Family[]) {
    const full = fv(f);
    if (!full || full.n === 0) continue;
    for (const c of cs.filter((x) => x.family === f && x.strategy !== 'framvera' && x.strategy !== 'oracle')) {
      const fr = full.feasible.k / full.n;
      const cr = c.feasible.k / Math.max(1, c.n);
      if (c.strategy.startsWith('framvera-') && cr >= fr) out.push(`${label(c.strategy)} matched or beat the full system on ${f} worlds (${c.feasible.k}/${c.n} vs ${full.feasible.k}/${full.n}): this component adds no measured feasibility there.`);
      else if (!c.strategy.startsWith('framvera-') && cr >= fr) out.push(`${label(c.strategy)} matched or beat the full system on ${f} worlds (${c.feasible.k}/${c.n} vs ${full.feasible.k}/${full.n}).`);
    }
    const orc = get(f, 'oracle');
    if (orc && orc.feasible.k > full.feasible.k) out.push(`On ${f} worlds the full system reached ${full.feasible.k}/${full.n} against ${orc.feasible.k}/${orc.n} for the hindsight oracle; the gap is ${orc.feasible.k - full.feasible.k} worlds.`);
    if (full.costVsOracle && full.costVsOracle.mean > 1.0) out.push(`On ${f} worlds the full system's verified plans cost ${full.costVsOracle.mean.toFixed(3)}x the oracle's on average (n=${full.costVsOracle.n}).`);
    if (full.recovery.attempted > 0 && full.recovery.success.k < full.recovery.attempted) out.push(`Recovery on ${f} worlds succeeded in ${full.recovery.success.k}/${full.recovery.attempted} attempts; the rest had no permissible recovery.`);
  }
  return out;
}

export function summaryMarkdown(records: RunRecord[], meta: Meta): string {
  const cs = cells(records);
  const fams = [...new Set(records.map((r) => r.family))];
  const L: string[] = [];
  L.push('# Framvera evaluation summary', '');
  L.push(`Generated ${meta.generatedAt} on Node ${meta.node}. Solver: ${meta.solver ? `${meta.solver.name} ${meta.solver.version}` : 'unknown'}. Every figure below is computed from \`evaluation/results.json\` (one row per world and strategy).`, '');
  L.push('## Method', '');
  L.push(`- Held-out seeds, disjoint from the flagship world: ${fams.map((f) => `${f} ${meta.heldOutSeeds[f]?.first} to ${meta.heldOutSeeds[f]?.last}`).join('; ')}.`);
  L.push('- Families: feasible (a published combination works), salvageable (infeasible as published, a negotiable change exists), impossible (no permitted change helps). Strategies never see the family label.');
  L.push(`- Supplier answers come only from private policies held by the referee. ${meta.boundary}`);
  L.push('- A success counts only if the final plan passes the independent verifier on the final world and intent, stays inside the budget, and respects the hidden real capacities. A claim that fails any of these is a false claim. Any claimed success in an impossible world is a false claim.');
  L.push(`- Question budget for random relaxations and the Framvera variants: ${String(meta.args.budget)}. The uniform heuristic asks every offer for a 10% discount and a 12 hour extension, so it uses as many questions as it needs.`);
  L.push('- The oracle uses the same intervention generator with knowledge of the private policies, so it is an upper bound for that candidate set, not a global optimum.');
  const ah = meta.args.agentHarness as Record<string, number | string> | undefined;
  if (ah) {
    L.push(`- Generic tool-using model baseline (${String(ah.model)}): same sanitized world and intent, a task prompt, and four tools: list offers, get offer, ask a supplier one free-form question (answered only by the private policies through the referee boundary, parsed into a typed concession or not sent), and propose a plan (checked by the same independent verifier). It has the same ${String(ah.supplierQuestionBudget)}-question budget as Framvera, at most ${String(ah.maxTurnsPerEpisode)} model calls per world, and no access to the solver, infeasibility core, inverse feasibility search or value-of-information ranking. It was run on ${String(ah.worldsPerFamily)} worlds per family (${String(ah.scoredWorlds)} scored, ${String(ah.droppedForBudget)} dropped for budget) using ${String(ah.modelCalls)} of ${String(ah.callBudget)} permitted model calls, so its denominators are smaller than the other rows. A model given the same engine as a tool could match much of it; this row measures the engine's marginal value against an agent that must reason alone.`);
  }
  L.push('- Intervals are Wilson 95% for proportions and normal 95% for mean cost ratios. Recovery is attempted only on verified plans where a withheld shock touches the plan.', '');
  for (const f of fams) {
    L.push(`## ${f[0]?.toUpperCase()}${f.slice(1)} worlds`, '');
    L.push('| Strategy | Verified feasible | Infeasible to feasible | False claims | Questions (mean) | Acceptance | Cost vs oracle | Invariant violations | Recovery | Solver ms (mean / p95) |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const c of cs.filter((x) => x.family === f)) {
      L.push([
        label(c.strategy), fmtRate(c.feasible), fmtRate(c.infeasibleToFeasible), fmtRate(c.falseClaims),
        fmtNum(c.questionsMean), fmtRate(c.acceptance), fmtCost(c.costVsOracle),
        `${c.invariantViolations.total} (${c.invariantViolations.worlds}/${c.n} worlds)`,
        c.recovery.attempted ? `${c.recovery.success.k}/${c.recovery.attempted}` : 'n/a (0/0)',
        `${fmtNum(c.solveMs.mean)} / ${fmtNum(c.solveMs.p95)}`,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    L.push('');
  }
  L.push('## Unfavourable and notable results', '');
  const fs = findings(cs);
  L.push(...(fs.length ? fs.map((x) => `- ${x}`) : ['- None detected by the automatic checks. Read the tables above before drawing conclusions.']), '');
  const reasons = falseReasonCounts(records);
  L.push('## False claim reasons', '');
  const rk = Object.keys(reasons);
  if (!rk.length) L.push('No false claims were recorded.');
  else for (const s of rk) L.push(`- ${label(s as StrategyId)}: ${Object.entries(reasons[s] as Record<string, number>).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  L.push('', '## Limits of this evaluation', '');
  L.push('- Worlds come from one generator; results show behaviour on that distribution, not on real markets.');
  L.push('- Supplier policies are synthetic. Acceptance rates describe the generator, not real suppliers.');
  L.push('- The direct procurement baseline schedules by its own earliest-start rule; a stricter or looser convention would change its numbers.');
  L.push('- The referee and the strategies run in one process; the boundary is a code-level separation.');
  return L.join('\n') + '\n';
}

export function headline(records: RunRecord[], meta: Meta) {
  const cs = cells(records);
  const compact = (c: Cell) => ({
    strategy: c.strategy, label: label(c.strategy), hindsight: c.hindsight,
    feasible: [c.feasible.k, c.feasible.n], feasibleCi: c.feasible.ci,
    infeasibleToFeasible: [c.infeasibleToFeasible.k, c.infeasibleToFeasible.n],
    falseClaims: [c.falseClaims.k, c.falseClaims.n],
    questionsMean: c.questionsMean, acceptance: [c.acceptance.k, c.acceptance.n],
    costVsOracle: c.costVsOracle ? { mean: c.costVsOracle.mean, n: c.costVsOracle.n } : null,
    invariantViolations: c.invariantViolations.total,
    recovery: [c.recovery.success.k, c.recovery.attempted], solveMsMean: c.solveMs.mean,
  });
  const families: Record<string, ReturnType<typeof compact>[]> = {};
  for (const f of new Set(records.map((r) => r.family))) families[f] = cs.filter((c) => c.family === f).map(compact);
  const sal = cs.filter((c) => c.family === 'salvageable' && c.strategy !== 'oracle' && !c.strategy.startsWith('framvera-'));
  const full = cs.find((c) => c.family === 'salvageable' && c.strategy === 'framvera');
  const bestBaseline = sal.filter((c) => c.strategy !== 'framvera').sort((a, b) => b.feasible.k - a.feasible.k)[0];
  const impossible = cs.filter((c) => c.family === 'impossible' && !c.hindsight);
  return {
    generatedAt: meta.generatedAt,
    heldOutSeeds: meta.heldOutSeeds,
    claim: full && bestBaseline ? {
      framveraFeasible: [full.feasible.k, full.feasible.n],
      bestBaseline: { strategy: bestBaseline.strategy, feasible: [bestBaseline.feasible.k, bestBaseline.feasible.n] },
    } : null,
    falseClaimsFramvera: cs.filter((c) => c.strategy === 'framvera').map((c) => ({ family: c.family, falseClaims: [c.falseClaims.k, c.falseClaims.n] })),
    impossibleClaims: impossible.map((c) => ({ strategy: c.strategy, claimed: [c.claimed.k, c.claimed.n] })),
    families,
  };
}
