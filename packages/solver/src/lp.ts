export type Sense = '<=' | '>=' | '=';
export type VarType = 'C' | 'I' | 'B';

export interface Term {
  v: string;
  c: number;
}

export interface Row {
  name: string;
  terms: Term[];
  sense: Sense;
  rhs: number;
  group: string | null;
}

export interface VarDef {
  name: string;
  lb: number;
  ub: number;
  type: VarType;
}

export class Model {
  vars = new Map<string, VarDef>();
  rows: Row[] = [];
  objective: Term[] = [];

  addVar(name: string, lb: number, ub: number, type: VarType = 'C'): string {
    if (this.vars.has(name)) throw new Error(`duplicate variable ${name}`);
    this.vars.set(name, { name, lb, ub, type });
    return name;
  }

  setBounds(name: string, lb: number, ub: number): void {
    const v = this.vars.get(name);
    if (!v) throw new Error(`unknown variable ${name}`);
    v.lb = lb;
    v.ub = ub;
  }

  addRow(group: string | null, terms: Term[], sense: Sense, rhs: number): void {
    const merged = new Map<string, number>();
    for (const t of terms) {
      if (!this.vars.has(t.v)) throw new Error(`unknown variable ${t.v}`);
      merged.set(t.v, (merged.get(t.v) ?? 0) + t.c);
    }
    const clean = [...merged].filter(([, c]) => c !== 0).map(([v, c]) => ({ v, c }));
    this.rows.push({ name: `r${this.rows.length}`, terms: clean, sense, rhs, group });
  }

  clone(): Model {
    const m = new Model();
    for (const [k, v] of this.vars) m.vars.set(k, { ...v });
    m.rows = this.rows.map((r) => ({ ...r, terms: r.terms.slice() }));
    m.objective = this.objective.slice();
    return m;
  }

  groups(): string[] {
    const seen = new Set<string>();
    for (const r of this.rows) if (r.group) seen.add(r.group);
    return [...seen];
  }

  toLP(): string {
    const out: string[] = ['Minimize'];
    out.push(` obj: ${expr(this.objective) || '0 ' + this.firstVar()}`);
    out.push('Subject To');
    for (const r of this.rows) {
      if (r.terms.length === 0) {
        if (!trivial(r)) out.push(` ${r.name}: 0 ${this.firstVar()} ${r.sense} ${num(r.rhs)}`);
        continue;
      }
      out.push(` ${r.name}: ${expr(r.terms)} ${r.sense} ${num(r.rhs)}`);
    }
    out.push('Bounds');
    const generals: string[] = [];
    const binaries: string[] = [];
    for (const v of this.vars.values()) {
      out.push(` ${num(v.lb)} <= ${v.name} <= ${num(v.ub)}`);
      if (v.type === 'I') generals.push(v.name);
      if (v.type === 'B') binaries.push(v.name);
    }
    if (generals.length) out.push('Generals', ' ' + generals.join(' '));
    if (binaries.length) out.push('Binaries', ' ' + binaries.join(' '));
    out.push('End');
    return out.join('\n');
  }

  private firstVar(): string {
    const first = this.vars.keys().next();
    if (first.done) throw new Error('model has no variables');
    return first.value;
  }
}

function trivial(r: Row): boolean {
  if (r.sense === '<=') return 0 <= r.rhs + 1e-9;
  if (r.sense === '>=') return 0 >= r.rhs - 1e-9;
  return Math.abs(r.rhs) < 1e-9;
}

export function num(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`non-finite coefficient ${x}`);
  if (Number.isInteger(x)) return String(x);
  return Number(x.toPrecision(12)).toString();
}

function expr(terms: Term[]): string {
  let s = '';
  for (const t of terms) {
    const c = Number(t.c.toPrecision(12));
    if (c === 0) continue;
    const sign = c < 0 ? '-' : '+';
    const mag = Math.abs(c);
    const body = mag === 1 ? t.v : `${num(mag)} ${t.v}`;
    s += s ? ` ${sign} ${body}` : c < 0 ? `- ${body}` : body;
  }
  return s;
}

export type RunStatus = 'optimal' | 'infeasible' | 'timeout-with-solution' | 'timeout' | 'error';

export interface RunResult {
  status: RunStatus;
  raw: string;
  objective: number;
  values: Record<string, number>;
  ms: number;
}

type Highs = { solve: (lp: string, opts?: Record<string, unknown>) => any };
let instance: Promise<Highs> | null = null;

async function load(): Promise<Highs> {
  if (!instance) instance = import('highs').then((m) => (m.default as unknown as () => Promise<Highs>)());
  return instance;
}

export const SOLVER_NAME = 'HiGHS';
export const SOLVER_VERSION = '1.15 (highs-js 1.15.4, WebAssembly)';

export interface RunOptions {
  timeLimitMs?: number;
  absGap?: number;
}

interface Raw {
  raw: string;
  objective: number;
  values: Record<string, number>;
  ms: number;
}

function options(opts: RunOptions, presolve = true) {
  return {
    output_flag: false,
    time_limit: Math.max(0.05, (opts.timeLimitMs ?? 10000) / 1000),
    mip_rel_gap: 0,
    mip_abs_gap: opts.absGap ?? 1e-6,
    ...(presolve ? {} : { presolve: 'off' }),
  };
}

function classify(r: Raw): RunResult {
  let status: RunStatus;
  const hasPrimal = Object.keys(r.values).length > 0 && Number.isFinite(r.objective);
  if (r.raw === 'Optimal') status = 'optimal';
  else if (r.raw === 'Infeasible') status = 'infeasible';
  else if (r.raw === 'Time limit reached') status = hasPrimal ? 'timeout-with-solution' : 'timeout';
  else status = 'error';
  return { status, ...r };
}

async function solveLocal(lp: string, opts: RunOptions, presolve = true): Promise<Raw> {
  const t0 = performance.now();
  let res: any;
  try {
    res = (await load()).solve(lp, options(opts, presolve));
  } catch {
    instance = null;
    try {
      res = (await load()).solve(lp, options(opts, presolve));
    } catch (e) {
      return { raw: `error: ${String(e)}`, objective: NaN, values: {}, ms: performance.now() - t0 };
    }
  }
  const values: Record<string, number> = {};
  for (const [k, c] of Object.entries<any>(res.Columns ?? {})) if (typeof c.Primal === 'number') values[k] = c.Primal;
  return { raw: res.Status, objective: res.ObjectiveValue, values, ms: performance.now() - t0 };
}

/** Every model here has bounded variables, so an unresolved status is retried without presolve. */
async function settle(lp: string, opts: RunOptions, first: Raw): Promise<RunResult> {
  if (first.raw === 'Primal infeasible or unbounded') return classify(await solveLocal(lp, opts, false));
  return classify(first);
}

export async function run(model: Model, opts: RunOptions = {}): Promise<RunResult> {
  const lp = model.toLP();
  return settle(lp, opts, await solveLocal(lp, opts));
}

interface PoolWorker {
  worker: import('node:worker_threads').Worker;
}

let pool: Promise<PoolWorker[] | null> | null = null;

async function getPool(): Promise<PoolWorker[] | null> {
  if (!pool) {
    pool = (async () => {
      try {
        const { Worker } = await import('node:worker_threads');
        const os = await import('node:os');
        const size = Math.max(1, Math.min(6, os.cpus().length - 2));
        const url = new URL('./highs-worker.mjs', import.meta.url);
        return Array.from({ length: size }, () => {
          const worker = new Worker(url);
          worker.unref();
          return { worker };
        });
      } catch {
        return null;
      }
    })();
  }
  return pool;
}

let nextId = 0;
function onWorker(w: PoolWorker, lp: string, opts: RunOptions): Promise<Raw> {
  const id = nextId++;
  return new Promise((resolve) => {
    const onMessage = (msg: any) => {
      if (msg.id !== id) return;
      w.worker.off('message', onMessage);
      w.worker.off('error', onError);
      resolve(msg.error ? { raw: `error: ${msg.error}`, objective: NaN, values: {}, ms: msg.ms } : msg);
    };
    const onError = (e: unknown) => {
      w.worker.off('message', onMessage);
      resolve({ raw: `error: ${String(e)}`, objective: NaN, values: {}, ms: 0 });
    };
    w.worker.on('message', onMessage);
    w.worker.once('error', onError);
    w.worker.postMessage({ id, lp, options: options(opts) });
  });
}

/** Solves independent models side by side on a small worker pool, in this thread when workers are unavailable. */
export async function runMany(models: Model[], opts: RunOptions = {}): Promise<RunResult[]> {
  const workers = models.length > 1 ? await getPool() : null;
  if (!workers) return Promise.all(models.map((m) => run(m, opts)));
  const lps = models.map((m) => m.toLP());
  const out: RunResult[] = new Array(models.length);
  let next = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < lps.length) {
        const k = next++;
        const first = await onWorker(w, lps[k]!, opts);
        out[k] = first.raw.startsWith('error') ? await run(models[k]!, opts) : await settle(lps[k]!, opts, first);
      }
    }),
  );
  return out;
}
