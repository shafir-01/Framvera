export type Sense = '<=' | '>=' | '=';
export interface Term {
  v: string;
  c: number;
}

type Kind = 'C' | 'I' | 'B';

/** A small mixed-integer model written to CPLEX LP text and solved by HiGHS. */
export class Mip {
  private vars = new Map<string, { lb: number; ub: number; kind: Kind }>();
  private rows: { terms: Term[]; sense: Sense; rhs: number }[] = [];
  objective: Term[] = [];
  direction: 'min' | 'max' = 'min';

  bin(name: string): string {
    return this.add(name, 0, 1, 'B');
  }

  num(name: string, lb: number, ub: number, integer = false): string {
    return this.add(name, lb, ub, integer ? 'I' : 'C');
  }

  row(terms: Term[], sense: Sense, rhs: number): void {
    for (const t of terms) if (!this.vars.has(t.v)) throw new Error(`unknown variable ${t.v}`);
    this.rows.push({ terms: terms.filter((t) => t.c !== 0), sense, rhs });
  }

  get size(): { vars: number; rows: number } {
    return { vars: this.vars.size, rows: this.rows.length };
  }

  toLP(): string {
    const first = this.vars.keys().next().value;
    if (first === undefined) throw new Error('model has no variables');
    const out = [this.direction === 'min' ? 'Minimize' : 'Maximize', ` obj: ${expr(this.objective) || `0 ${first}`}`, 'Subject To'];
    this.rows.forEach((r, i) => {
      const body = expr(r.terms);
      if (body) out.push(` c${i}: ${body} ${r.sense} ${num(r.rhs)}`);
      else if (!holds(0, r.sense, r.rhs)) out.push(` c${i}: 0 ${first} ${r.sense} ${num(r.rhs)}`);
    });
    out.push('Bounds');
    const ints: string[] = [];
    const bins: string[] = [];
    for (const [name, v] of this.vars) {
      out.push(` ${num(v.lb)} <= ${name} <= ${num(v.ub)}`);
      if (v.kind === 'I') ints.push(name);
      if (v.kind === 'B') bins.push(name);
    }
    if (ints.length) out.push('Generals', ` ${ints.join(' ')}`);
    if (bins.length) out.push('Binaries', ` ${bins.join(' ')}`);
    out.push('End');
    return out.join('\n');
  }

  private add(name: string, lb: number, ub: number, kind: Kind): string {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad variable name ${name}`);
    if (this.vars.has(name)) throw new Error(`duplicate variable ${name}`);
    this.vars.set(name, { lb, ub, kind });
    return name;
  }
}

function holds(lhs: number, sense: Sense, rhs: number): boolean {
  if (sense === '<=') return lhs <= rhs + 1e-9;
  if (sense === '>=') return lhs >= rhs - 1e-9;
  return Math.abs(lhs - rhs) < 1e-9;
}

function num(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`non-finite coefficient ${x}`);
  return Number.isInteger(x) ? String(x) : Number(x.toPrecision(15)).toString();
}

function expr(terms: Term[]): string {
  let s = '';
  for (const t of terms) {
    if (t.c === 0) continue;
    const mag = Math.abs(t.c);
    const body = mag === 1 ? t.v : `${num(mag)} ${t.v}`;
    s += s ? ` ${t.c < 0 ? '-' : '+'} ${body}` : t.c < 0 ? `- ${body}` : body;
  }
  return s;
}

export type MipStatus = 'optimal' | 'infeasible' | 'timeout' | 'error';

export interface MipResult {
  status: MipStatus;
  objective: number;
  values: Record<string, number>;
  ms: number;
  /** True when the time limit hit with an incumbent: the solution is feasible but not proven optimal. */
  incumbentOnly: boolean;
}

type Highs = { solve: (lp: string, opts?: Record<string, unknown>) => any };
let instance: Promise<Highs> | null = null;
const load = (): Promise<Highs> =>
  (instance ??= import('highs').then((m) => (m.default as unknown as () => Promise<Highs>)()));

export const SOLVER = { name: 'HiGHS', version: 'highs-js 1.15 (WebAssembly)' } as const;

export async function solveMip(model: Mip, timeLimitMs = 10_000): Promise<MipResult> {
  const lp = model.toLP();
  const options = { output_flag: false, time_limit: Math.max(0.05, timeLimitMs / 1000), mip_rel_gap: 0, mip_abs_gap: 1e-6 };
  const t0 = performance.now();
  let res: any;
  try {
    res = (await load()).solve(lp, options);
  } catch {
    instance = null;
    try {
      res = (await load()).solve(lp, options);
    } catch {
      return { status: 'error', objective: NaN, values: {}, ms: performance.now() - t0, incumbentOnly: false };
    }
  }
  const values: Record<string, number> = {};
  for (const [k, c] of Object.entries<any>(res.Columns ?? {})) if (typeof c.Primal === 'number') values[k] = c.Primal;
  const ms = performance.now() - t0;
  const has = Object.keys(values).length > 0 && Number.isFinite(res.ObjectiveValue);
  if (res.Status === 'Optimal') return { status: 'optimal', objective: res.ObjectiveValue, values, ms, incumbentOnly: false };
  if (res.Status === 'Infeasible') return { status: 'infeasible', objective: NaN, values: {}, ms, incumbentOnly: false };
  if (res.Status === 'Time limit reached' && has) return { status: 'timeout', objective: res.ObjectiveValue, values, ms, incumbentOnly: true };
  return { status: res.Status === 'Time limit reached' ? 'timeout' : 'error', objective: NaN, values: {}, ms, incumbentOnly: false };
}

export const on = (values: Record<string, number>, v: string): boolean => (values[v] ?? 0) > 0.5;
