/// <reference lib="webworker" />
import type { Concession, InfeasibleCore, Intent, Intervention, SolveReport, Verification, World } from '@framvera/contracts';
import { compile, explainInfeasible, findInterventions, solve, toLP, verifyPlan } from '@framvera/solver';
import { applyWhatIf } from './levers.ts';
import type { ExplainOptions, InterventionOptions, SolveOptions } from '@framvera/solver';
import loadHighs from 'highs';
import wasmUrl from 'highs/runtime?url';

export type Feasibility = 'feasible' | 'infeasible' | 'unknown';

interface Base {
  id: number;
  world: World;
  intent: Intent;
  /** Applied to copies of world and intent before solving; the inputs are never changed. */
  concessions?: Concession[];
}

export type WorkerRequest =
  | (Base & { op: 'feasible'; timeLimitMs?: number })
  | (Base & { op: 'solve'; opts?: SolveOptions })
  | (Base & { op: 'core'; opts?: ExplainOptions })
  | (Base & { op: 'interventions'; opts?: InterventionOptions });

export type WorkerResult =
  | { op: 'feasible'; feasibility: Feasibility; ms: number }
  | { op: 'solve'; report: SolveReport; verification?: Verification; ms: number }
  | { op: 'core'; core: InfeasibleCore; ms: number }
  | { op: 'interventions'; interventions: Intervention[]; ms: number };

export type WorkerResponse = { id: number; ok: true; result: WorkerResult } | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

// The solver package asks for highs.wasm next to its own module. A dev server that pre-bundles
// dependencies moves that module, so every request for the file goes to the copy the bundler emitted.
const realFetch = scope.fetch.bind(scope);
scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return realFetch(/highs[^/]*\.wasm(\?|$)/.test(url) ? wasmUrl : input, init);
}) as typeof fetch;

type Highs = { solve: (lp: string, opts?: Record<string, unknown>) => { Status: string } };
let highs: Promise<Highs> | null = null;
const getHighs = () =>
  (highs ??= (loadHighs as unknown as (o: object) => Promise<Highs>)({ locateFile: () => wasmUrl }).catch((e: unknown) => {
    highs = null;
    throw e;
  }));

/** Feasibility only: the solver's own compiled model with the objective removed, decided by HiGHS. */
async function feasibility(world: World, intent: Intent, timeLimitMs: number): Promise<Feasibility> {
  const c = compile(world, intent);
  c.model.objective = [];
  const r = (await getHighs()).solve(toLP(c), { output_flag: false, time_limit: timeLimitMs / 1000 });
  return r.Status === 'Optimal' ? 'feasible' : r.Status === 'Infeasible' ? 'infeasible' : 'unknown';
}

async function handle(req: WorkerRequest): Promise<WorkerResult> {
  const t0 = performance.now();
  const { world, intent } = req.concessions?.length ? applyWhatIf(req.world, req.intent, req.concessions) : req;
  const ms = () => Math.round((performance.now() - t0) * 10) / 10;
  switch (req.op) {
    case 'feasible':
      return { op: 'feasible', feasibility: await feasibility(world, intent, req.timeLimitMs ?? 2000), ms: ms() };
    case 'solve': {
      const report = await solve(world, intent, req.opts);
      const verification = report.plan ? verifyPlan(report.plan, world, intent, { fixed: req.opts?.fixed }) : undefined;
      return { op: 'solve', report, verification, ms: ms() };
    }
    case 'core':
      return { op: 'core', core: await explainInfeasible(world, intent, req.opts), ms: ms() };
    case 'interventions':
      return { op: 'interventions', interventions: await findInterventions(world, intent, req.opts), ms: ms() };
  }
}

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    scope.postMessage({ id: req.id, ok: true, result: await handle(req) } satisfies WorkerResponse);
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
