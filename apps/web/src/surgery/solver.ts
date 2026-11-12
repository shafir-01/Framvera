import type { Concession, InfeasibleCore, Intent, Intervention, SolveReport, Verification, World } from '@framvera/contracts';
import type { ExplainOptions, InterventionOptions, SolveOptions } from '@framvera/solver';
import type { Feasibility, WorkerRequest, WorkerResponse, WorkerResult } from './solver.worker.ts';

export type { Feasibility, WorkerResult };
export type WorkerJob = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

interface Job {
  slot: string | null;
  req: WorkerJob;
  resolve: (r: WorkerResult | null) => void;
  reject: (e: Error) => void;
}

export const makeWorker = () => new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module', name: 'framvera-solver' });

/**
 * One solver worker running one job at a time. Jobs given a slot replace queued jobs in the same slot
 * (they resolve to null), so a moving slider never builds a backlog. Jobs without a slot always run.
 */
export class Lane {
  private worker: Worker | null = null;
  private running: (Job & { id: number }) | null = null;
  private queue: Job[] = [];
  private seq = 0;
  private dead: Error | null = null;

  constructor(private make: () => Worker = makeWorker) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.make();
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const job = this.running;
      if (!job || job.id !== e.data.id) return;
      this.running = null;
      if (e.data.ok) job.resolve(e.data.result);
      else job.reject(new Error(e.data.error));
      this.pump();
    };
    w.onerror = (e) => {
      e.preventDefault();
      this.fail(new Error(e.message || 'The solver stopped unexpectedly.'));
    };
    w.onmessageerror = () => this.fail(new Error('The solver sent an unreadable answer.'));
    this.worker = w;
    return w;
  }

  run(slot: string | null, req: WorkerJob): Promise<WorkerResult | null> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      if (slot !== null) {
        this.queue = this.queue.filter((j) => {
          if (j.slot !== slot) return true;
          j.resolve(null);
          return false;
        });
      }
      this.queue.push({ slot, req, resolve, reject });
      this.pump();
    });
  }

  /** Drop queued jobs whose slot starts with `prefix`. A job already running finishes; its caller ignores it. */
  cancel(prefix: string) {
    this.queue = this.queue.filter((j) => {
      if (j.slot === null || !j.slot.startsWith(prefix)) return true;
      j.resolve(null);
      return false;
    });
  }

  private pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift()!;
    const id = ++this.seq;
    this.running = { ...job, id };
    this.ensure().postMessage({ ...job.req, id });
  }

  private fail(err: Error) {
    this.dead = err;
    this.running?.reject(err);
    this.running = null;
    for (const j of this.queue) j.reject(err);
    this.queue = [];
    this.worker?.terminate();
    this.worker = null;
  }

  /** Stop whatever is running by discarding the worker; its caller gets null. Queued jobs start on a fresh worker. */
  kill() {
    if (!this.running) return;
    this.running.resolve(null);
    this.running = null;
    this.worker?.terminate();
    this.worker = null;
    this.pump();
  }

  /** A lane that failed can be revived; the next job starts a fresh worker. */
  revive() {
    this.dead = null;
  }

  terminate() {
    this.fail(new Error('The solver was closed.'));
  }
}

let shared: Lane | null = null;
const lane = () => {
  shared ??= new Lane();
  shared.revive();
  return shared;
};

async function call<O extends WorkerResult['op']>(req: WorkerJob & { op: O }): Promise<Extract<WorkerResult, { op: O }>> {
  const r = await lane().run(null, req);
  if (!r || r.op !== req.op) throw new Error('The solver did not answer.');
  return r as Extract<WorkerResult, { op: O }>;
}

/** `solve` from @framvera/solver, run by HiGHS in a Web Worker on this device. Inputs are copied, never changed. */
export async function solveInBrowser(world: World, intent: Intent, opts?: SolveOptions & { concessions?: Concession[] }): Promise<SolveReport> {
  const { concessions, ...rest } = opts ?? {};
  return (await call({ op: 'solve', world, intent, concessions, opts: rest })).report;
}

/** Solve plus the independent arithmetic re-check of the plan, both in the worker. */
export async function solveAndVerifyInBrowser(
  world: World,
  intent: Intent,
  opts?: SolveOptions & { concessions?: Concession[] },
): Promise<{ report: SolveReport; verification?: Verification; ms: number }> {
  const { concessions, ...rest } = opts ?? {};
  const r = await call({ op: 'solve', world, intent, concessions, opts: rest });
  return { report: r.report, verification: r.verification, ms: r.ms };
}

/** `explainInfeasible` from @framvera/solver in the worker: a deletion-filter core over constraint groups. */
export async function explainInBrowser(world: World, intent: Intent, opts?: ExplainOptions & { concessions?: Concession[] }): Promise<InfeasibleCore> {
  const { concessions, ...rest } = opts ?? {};
  return (await call({ op: 'core', world, intent, concessions, opts: rest })).core;
}

/** `findInterventions` from @framvera/solver in the worker. */
export async function findInterventionsInBrowser(
  world: World,
  intent: Intent,
  opts?: InterventionOptions & { concessions?: Concession[] },
): Promise<Intervention[]> {
  const { concessions, ...rest } = opts ?? {};
  return (await call({ op: 'interventions', world, intent, concessions, opts: rest })).interventions;
}

/** Feasibility only, decided by HiGHS on the solver's compiled model with no objective. */
export async function feasibleInBrowser(world: World, intent: Intent, concessions?: Concession[], timeLimitMs?: number): Promise<Feasibility> {
  return (await call({ op: 'feasible', world, intent, concessions, timeLimitMs })).feasibility;
}
