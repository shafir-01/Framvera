import type { Allocation, Intent, Iso, Money, Offer, Stage, StageId, World } from '@framvera/contracts';
import { effectiveCapacity, isUsable, money, offerCost, sinkStages, stageNeed, toMs, topoOrder } from '@framvera/contracts';

/**
 * Exact market checker, independent of the MIP solver.
 *
 * Two dynamic programmes over offer subsets, price tiers and stage ready times:
 * - restrict: quantities in multiples of `unit`, ready times on a `stepHours` grid.
 *   Every plan it returns is constructible and passes validatePlan.
 * - relax: rounds every quantity and time bound in the market's favour, so its
 *   minimum cost is a lower bound on any real plan under the same semantics.
 * Feasible when restrict fits the budget; infeasible when relax cannot.
 */
export interface CheckOptions {
  /** Plan with claimed capacity and ignore booking records (how a naive buyer would read the market). */
  trustClaims?: boolean;
  stepHours?: number;
  unit?: number;
}

export interface CheckPlan {
  allocations: Allocation[];
  total: Money;
  readyAt: Iso;
}

export interface CheckResult {
  status: 'feasible' | 'infeasible' | 'undetermined';
  /** Cheapest constructible plan that meets the deadline, even when it exceeds the budget. */
  plan?: CheckPlan;
  /** No plan that meets the deadline can cost less than this; null when no plan can meet the deadline. */
  lowerBound: Money | null;
}

type Mode = 'restrict' | 'relax';
const HOUR = 3_600_000;

interface OfferModel {
  offer: Offer;
  cap: number;
  lo: number;
  costs: Float64Array;
  ws: number;
  we: number;
  h: number;
  r: number;
}

interface StageModel {
  stage: Stage;
  needU: number;
  offers: OfferModel[];
  maxReady: number;
  memo: Map<string, { cost: number; qty: number[] }>;
}

interface Pick {
  stage: StageId;
  e: number;
  l: number;
}

interface Point {
  t: number;
  cost: number;
  picks: Pick[];
}

function relaxedCost(o: Offer, from: number, to: number): number {
  if (from > to) return Infinity;
  let best = offerCost(o, from).minor;
  for (const t of o.tiers) if (t.minQty > from && t.minQty <= to) best = Math.min(best, offerCost(o, t.minQty).minor);
  return best;
}

function buildStage(world: World, intent: Intent, stage: Stage, mode: Mode, opts: Required<Omit<CheckOptions, 'trustClaims'>> & CheckOptions): StageModel {
  const u = opts.unit;
  const need = stageNeed(stage, intent);
  const offers: OfferModel[] = [];
  for (const o of world.offers) {
    if (o.stage !== stage.id || !isUsable(world, o)) continue;
    const cap = opts.trustClaims ? o.capacity : effectiveCapacity(world, o);
    if (cap < Math.max(o.minQty, 1)) continue;
    const capU = mode === 'restrict' ? Math.floor(cap / u) : Math.ceil(cap / u);
    const lo = Math.max(1, Math.ceil(o.minQty / u));
    if (lo > capU) continue;
    const costs = new Float64Array(capU + 1).fill(Infinity);
    for (let x = lo; x <= capU; x++) {
      costs[x] = mode === 'restrict' ? offerCost(o, x * u).minor : relaxedCost(o, Math.max(o.minQty, 1, x * u - u + 1), Math.min(x * u, cap));
    }
    offers.push({ offer: o, cap, lo, costs, ws: toMs(o.window.start) / HOUR, we: toMs(o.window.end) / HOUR, h: o.handoffHours, r: o.ratePerHour });
  }
  return {
    stage,
    needU: Math.ceil(need / u),
    offers,
    maxReady: Math.max(-Infinity, ...offers.map((o) => o.we + o.h)),
    memo: new Map(),
  };
}

function evalStage(sm: StageModel, E: number, L: number, mode: Mode, u: number): { cost: number; qty: number[] } {
  const hi = sm.offers.map((o) => {
    const avail = Math.min(o.we, L - o.h) - Math.max(E, o.ws);
    if (avail <= 1e-12) return 0;
    const q = Math.min(o.cap, Math.floor(o.r * avail + (mode === 'restrict' ? 1e-7 : 1e-6)));
    const x = mode === 'restrict' ? Math.floor(q / u) : Math.ceil(q / u);
    return Math.min(x, o.costs.length - 1);
  });
  const key = hi.join(',');
  const hit = sm.memo.get(key);
  if (hit) return hit;
  const N = sm.needU;
  let dp = new Float64Array(N + 1).fill(Infinity);
  dp[0] = 0;
  const choice: Int32Array[] = [];
  const prev: Int32Array[] = [];
  sm.offers.forEach((o, i) => {
    const h = hi[i]!;
    const ch = new Int32Array(N + 1).fill(0);
    const pv = new Int32Array(N + 1).fill(-1);
    choice.push(ch);
    prev.push(pv);
    if (h < o.lo) return;
    const suf = new Float64Array(h + 2).fill(Infinity);
    const sufArg = new Int32Array(h + 2).fill(-1);
    for (let x = h; x >= o.lo; x--) {
      const c = o.costs[x]!;
      if (c < suf[x + 1]!) {
        suf[x] = c;
        sufArg[x] = x;
      } else {
        suf[x] = suf[x + 1]!;
        sufArg[x] = sufArg[x + 1]!;
      }
    }
    const nd = dp.slice();
    for (let s = 0; s <= N; s++) {
      const base = dp[s]!;
      if (base === Infinity) continue;
      const top = Math.min(h, N - s - 1);
      for (let x = o.lo; x <= top; x++) {
        const v = base + o.costs[x]!;
        if (v < nd[s + x]!) {
          nd[s + x] = v;
          ch[s + x] = x;
          pv[s + x] = s;
        }
      }
      const a = Math.max(o.lo, N - s);
      if (a <= h && suf[a]! < Infinity) {
        const v = base + suf[a]!;
        if (v < nd[N]!) {
          nd[N] = v;
          ch[N] = sufArg[a]!;
          pv[N] = s;
        }
      }
    }
    dp = nd;
  });
  const qty = sm.offers.map(() => 0);
  let s = N;
  if (dp[N]! < Infinity) {
    for (let i = sm.offers.length - 1; i >= 0 && s > 0; i--) {
      if (prev[i]![s]! >= 0) {
        qty[i] = choice[i]![s]! * u;
        s = prev[i]![s]!;
      }
    }
  }
  const res = { cost: dp[N]!, qty };
  sm.memo.set(key, res);
  return res;
}

function prune(points: Point[]): Point[] {
  points.sort((a, b) => a.t - b.t || a.cost - b.cost);
  const out: Point[] = [];
  let best = Infinity;
  for (const p of points) {
    if (p.cost < best) {
      out.push(p);
      best = p.cost;
    }
  }
  return out;
}

function combine(fronts: Point[][]): Point[] {
  let acc: Point[] = [{ t: -1, cost: 0, picks: [] }];
  for (const f of fronts) {
    const next: Point[] = [];
    for (const a of acc) for (const b of f) next.push({ t: Math.max(a.t, b.t), cost: a.cost + b.cost, picks: a.picks.concat(b.picks) });
    acc = prune(next);
  }
  return acc;
}

interface Search {
  cost: number;
  picks: Pick[];
  T0: number;
  step: number;
  models: Map<StageId, StageModel>;
}

function search(world: World, intent: Intent, mode: Mode, opts: Required<Omit<CheckOptions, 'trustClaims'>> & CheckOptions): Search {
  const order = topoOrder(world.stages);
  if (!order) throw new Error('Stage graph has a cycle');
  const step = opts.stepHours;
  const u = opts.unit;
  const models = new Map(order.map((s) => [s.id, buildStage(world, intent, s, mode, opts)]));
  const starts = [...models.values()].flatMap((m) => m.offers.map((o) => o.ws));
  const empty: Search = { cost: Infinity, picks: [], T0: 0, step, models };
  if (starts.length === 0) return empty;
  const T0 = Math.floor(Math.min(...starts));
  const rawD = (toMs(intent.deadline) / HOUR - T0) / step;
  const D = mode === 'restrict' ? Math.floor(rawD + 1e-9) : Math.ceil(rawD - 1e-9);
  if (D < 0) return { ...empty, T0 };
  const succ = new Map<StageId, number>(order.map((s) => [s.id, 0]));
  for (const s of order) for (const p of s.after) succ.set(p, (succ.get(p) ?? 0) + 1);
  const sinks = sinkStages(world).map((s) => s.id);

  const stageFront = (sm: StageModel, combined: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of combined) {
      const E = p.t < 0 ? -Infinity : T0 + p.t * step - (mode === 'relax' ? step : 0);
      let last = Infinity;
      for (let l = Math.max(p.t, 0); l <= D; l++) {
        const L = T0 + l * step;
        const r = evalStage(sm, E, L, mode, u);
        if (r.cost < last) {
          last = r.cost;
          out.push({ t: l, cost: p.cost + r.cost, picks: [...p.picks, { stage: sm.stage.id, e: p.t, l }] });
        }
        if (L >= sm.maxReady) break;
      }
    }
    return prune(out);
  };

  const run = (fixed: Map<StageId, Point>): { cost: number; picks: Pick[] } => {
    const fronts = new Map<StageId, Point[]>();
    for (const s of order) {
      const f = fixed.get(s.id);
      if (f) {
        fronts.set(s.id, [{ t: f.t, cost: 0, picks: [] }]);
        continue;
      }
      const combined = combine(s.after.map((p) => fronts.get(p)!));
      const front = stageFront(models.get(s.id)!, combined);
      if ((succ.get(s.id) ?? 0) > 1) {
        let best = { cost: Infinity, picks: [] as Pick[] };
        for (const p of front) {
          const r = run(new Map(fixed).set(s.id, p));
          if (r.cost + p.cost < best.cost) best = { cost: r.cost + p.cost, picks: p.picks.concat(r.picks) };
        }
        return best;
      }
      fronts.set(s.id, front);
    }
    const final = combine(sinks.map((id) => fronts.get(id)!));
    let best = { cost: Infinity, picks: [] as Pick[] };
    for (const p of final) if (p.t <= D && p.cost < best.cost) best = { cost: p.cost, picks: p.picks };
    return best;
  };

  const best = run(new Map());
  return { ...best, T0, step, models };
}

function toPlan(world: World, intent: Intent, s: Search, u: number): CheckPlan {
  const allocations: Allocation[] = [];
  let total = 0;
  const ready = new Map<StageId, number>();
  for (const pick of s.picks) {
    const sm = s.models.get(pick.stage)!;
    const E = pick.e < 0 ? -Infinity : s.T0 + pick.e * s.step;
    const r = evalStage(sm, E, s.T0 + pick.l * s.step, 'restrict', u);
    sm.offers.forEach((o, i) => {
      const qty = r.qty[i]!;
      if (qty <= 0) return;
      const start = Math.max(E, o.ws);
      const finish = start + qty / o.r + o.h;
      const cost = offerCost(o.offer, qty);
      total += cost.minor;
      ready.set(pick.stage, Math.max(ready.get(pick.stage) ?? -Infinity, finish));
      allocations.push({
        offer: o.offer.id,
        actor: o.offer.actor,
        stage: pick.stage,
        qty,
        start: new Date(Math.round(start * HOUR)).toISOString(),
        finish: new Date(Math.round(finish * HOUR)).toISOString(),
        cost,
      });
    });
  }
  const readyAt = Math.max(...sinkStages(world).map((st) => ready.get(st.id) ?? -Infinity));
  return { allocations, total: money(world.currency, total), readyAt: new Date(Math.round(readyAt * HOUR)).toISOString() };
}

export function checkFeasibility(world: World, intent: Intent, options: CheckOptions = {}): CheckResult {
  const opts = { stepHours: 0.25, unit: 10, ...options };
  const restrict = search(world, intent, 'restrict', opts);
  const relax = search(world, intent, 'relax', opts);
  const budget = intent.budget.minor;
  const plan = restrict.cost < Infinity ? toPlan(world, intent, restrict, opts.unit) : undefined;
  const status = restrict.cost <= budget ? 'feasible' : relax.cost > budget ? 'infeasible' : 'undetermined';
  return { status, plan, lowerBound: relax.cost < Infinity ? money(world.currency, relax.cost) : null };
}
