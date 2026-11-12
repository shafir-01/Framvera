import type { Allocation, Intent, Plan, SolveReport, SolveStatus, World } from '@framvera/contracts';
import { compile, priceAt, terminalStages, topo, type CompileOptions, type Compiled } from './compile.ts';
import { run, SOLVER_NAME, SOLVER_VERSION, type RunResult, type Term } from './lp.ts';
import { HOUR_MS, iso } from './text.ts';
import { verifyPlan } from './verify.ts';
import { explainWith } from './explain.ts';

export interface SolveOptions {
  /** Allocations that must stay exactly as they are (accepted commitments). */
  fixed?: Allocation[];
  /** Previous plan to stay close to under the repair objective. Defaults to `fixed`. */
  baseline?: Allocation[];
  objective?: 'cost' | 'repair';
  /** 'effective' (default): claimed capacity minus capacity recorded as already booked. 'claimed': face value. */
  capacity?: 'effective' | 'claimed';
  timeLimitMs?: number;
  /** Compute an infeasible core when no plan exists. Default true. */
  explain?: boolean;
}

export interface Stage {
  objective: Term[];
  absGap: number;
}

export interface LexResult {
  status: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error';
  values: Record<string, number>;
  objectives: number[];
  ms: number;
}

/** Lexicographic optimisation: each stage is optimised with earlier stages held at their optimum. */
export async function lexSolve(c: Compiled, stages: Stage[], timeLimitMs: number): Promise<LexResult> {
  const model = c.model.clone();
  const t0 = performance.now();
  let values: Record<string, number> = {};
  const objectives: number[] = [];
  let status: LexResult['status'] = 'optimal';
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]!;
    model.objective = st.objective;
    const left = Math.max(200, timeLimitMs - (performance.now() - t0));
    const r: RunResult = await run(model, { timeLimitMs: left, absGap: st.absGap });
    if (r.status === 'infeasible' || r.status === 'error' || r.status === 'timeout') {
      if (i === 0) return { status: r.status, values: {}, objectives, ms: performance.now() - t0 };
      break;
    }
    if (r.status === 'timeout-with-solution') status = 'feasible';
    values = r.values;
    const val = st.objective.reduce((acc, t) => acc + t.c * (r.values[t.v] ?? 0), 0);
    objectives.push(val);
    if (r.status !== 'optimal') break;
    if (i < stages.length - 1) model.addRow(null, st.objective, '<=', val + Math.max(st.absGap, 1e-6) + 1e-7 * Math.abs(val));
  }
  return { status, values, objectives, ms: performance.now() - t0 };
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** Turns solver quantities into a plan with an earliest-start schedule and exact prices. */
export function extractPlan(c: Compiled, values: Record<string, number>, objective: string): Plan {
  const { world, intent } = c;
  const qty = new Map<string, number>();
  for (const co of c.offers) {
    if (!co.usable) continue;
    const q = Math.round(values[co.q] ?? 0);
    if (q > 0) qty.set(co.offer.id, q);
  }
  return buildPlan(world, intent, qty, c.offers.flatMap((o) => (o.fixed ? [o.fixed] : [])), objective);
}

export function buildPlan(
  world: World,
  intent: Intent,
  qty: Map<string, number>,
  fixed: Allocation[],
  objective: string,
): Plan {
  const fixedBy = new Map(fixed.map((f) => [f.offer, f]));
  const offerBy = new Map(world.offers.map((o) => [o.id, o]));
  const order = topo(world);
  const stageReady = new Map<string, number>();
  const allocations: Allocation[] = [];
  for (const st of order) {
    let ready = -Infinity;
    for (const o of world.offers) {
      if (o.stage !== st.id) continue;
      const q = qty.get(o.id);
      if (!q) continue;
      const f = fixedBy.get(o.id);
      let alloc: Allocation;
      if (f) {
        alloc = { ...f, cost: { ...f.cost } };
      } else {
        const preds = st.after.map((p) => stageReady.get(p) ?? -Infinity);
        const start = Math.max(Date.parse(o.window.start), ...preds);
        const work = Math.ceil((q / o.ratePerHour) * HOUR_MS);
        const finish = start + work + Math.round(o.handoffHours * HOUR_MS);
        alloc = {
          offer: o.id,
          actor: o.actor,
          stage: o.stage,
          qty: q,
          start: iso(start),
          finish: iso(finish),
          cost: { currency: intent.budget.currency, minor: priceAt(offerBy.get(o.id)!, q) },
        };
      }
      allocations.push(alloc);
      ready = Math.max(ready, Date.parse(alloc.finish));
    }
    if (ready > -Infinity) stageReady.set(st.id, ready);
  }
  const terminals = terminalStages(world);
  const finals = allocations.filter((a) => terminals.has(a.stage));
  const readyMs = Math.max(...(finals.length ? finals : allocations).map((a) => Date.parse(a.finish)));
  const total = allocations.reduce((acc, a) => acc + a.cost.minor, 0);
  const body = allocations.map((a) => `${a.offer}:${a.qty}:${a.start}`).join('|');
  return {
    id: `plan-${fnv(`${world.id}:${world.version}:${intent.id}:${body}`)}`,
    worldVersion: world.version,
    intent: intent.id,
    allocations,
    total: { currency: intent.budget.currency, minor: total },
    readyAt: Number.isFinite(readyMs) ? iso(readyMs) : intent.deadline,
    objective,
  };
}

const OBJECTIVE_TEXT = {
  cost: 'Lowest total cost, then earliest ready time.',
  repair: 'Fewest changed allocations, then lowest extra cost, then least delay.',
};

export async function solve(world: World, intent: Intent, opts: SolveOptions = {}): Promise<SolveReport> {
  const t0 = performance.now();
  const objective = opts.objective ?? 'cost';
  const timeLimitMs = opts.timeLimitMs ?? 10000;
  const solver = (gap?: number) => ({
    name: SOLVER_NAME,
    version: SOLVER_VERSION,
    ms: Math.round((performance.now() - t0) * 10) / 10,
    ...(gap === undefined ? {} : { gap }),
  });
  const base: CompileOptions = { fixed: opts.fixed, capacity: opts.capacity };
  let c: Compiled;
  try {
    c = compile(world, intent, { ...base, baseline: objective === 'repair' ? (opts.baseline ?? opts.fixed ?? []) : undefined });
  } catch {
    return { status: 'error', solver: solver() };
  }
  const endTerm = [{ v: c.end, c: 1 }];
  const stages =
    objective === 'repair'
      ? [
          { objective: c.changeTerms, absGap: 0.5 },
          { objective: c.costTerms, absGap: 0.5 },
          { objective: endTerm, absGap: 1e-4 },
        ]
      : [
          { objective: c.costTerms, absGap: 0.5 },
          { objective: endTerm, absGap: 1e-4 },
        ];
  const r = await lexSolve(c, stages, timeLimitMs);
  if (r.status === 'infeasible') {
    if (opts.explain === false) return { status: 'infeasible', solver: solver() };
    const core = await explainWith((disabled) => compile(world, intent, { ...base, disabled }), Math.max(2000, timeLimitMs));
    return { status: 'infeasible', solver: solver(), core };
  }
  if (r.status !== 'optimal' && r.status !== 'feasible') return { status: r.status as SolveStatus, solver: solver() };
  const plan = extractPlan(c, r.values, OBJECTIVE_TEXT[objective]);
  const check = verifyPlan(plan, world, intent, { fixed: opts.fixed, capacity: opts.capacity });
  if (!check.ok) return { status: 'error', solver: solver() };
  return { status: r.status, solver: solver(r.status === 'optimal' ? 0 : undefined), plan };
}
