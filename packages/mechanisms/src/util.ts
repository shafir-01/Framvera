import type { Allocation, Currency, Intent, Money, Offer, Stage, Verification, World } from '@framvera/contracts';

export const HOUR = 3_600_000;
export const TIME_TOLERANCE_MS = 1000;

export const m = (currency: Currency, minor: number): Money => ({ currency, minor });

/** Split an integer amount by non-negative weights so the parts sum exactly to the whole (largest remainder). */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new RangeError(`total must be a safe integer, got ${total}`);
  if (weights.length === 0) return [];
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  const use = sumW > 0 ? w : weights.map(() => 1);
  const den = sumW > 0 ? sumW : weights.length;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = use.map((x) => (abs * x) / den);
  const base = raw.map(Math.floor);
  let rest = abs - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    base[i]! += 1;
    rest--;
  }
  return base.map((b) => (b === 0 ? 0 : sign * b));
}

export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface MeanCI {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

export function meanCI(xs: number[]): MeanCI | null {
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { mean, lo: mean, hi: mean, n: xs.length };
  const v = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
  const h = 1.96 * Math.sqrt(v / xs.length);
  return { mean, lo: mean - h, hi: mean + h, n: xs.length };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
export const t = (s: string): number => Date.parse(s);

export function stageDemand(stage: Stage, intent: Intent): number {
  return Math.ceil(intent.quantity * stage.perOutcome - 1e-9);
}

export function tierUnit(offer: Offer, qty: number): number {
  const tiers = offer.tiers.slice().sort((a, b) => a.minQty - b.minQty);
  let unit = tiers[0]?.unit.minor ?? 0;
  for (const tier of tiers) if (qty >= tier.minQty) unit = tier.unit.minor;
  return unit;
}

/** Published price for qty units: all-units tier price plus the setup fee. */
export function publishedPrice(offer: Offer, qty: number): number {
  return tierUnit(offer, qty) * qty + offer.setupFee.minor;
}

export function terminalStages(world: World): Set<string> {
  const preds = new Set(world.stages.flatMap((s) => s.after));
  return new Set(world.stages.filter((s) => !preds.has(s.id)).map((s) => s.id));
}

export function topo(world: World): Stage[] {
  const byId = new Map(world.stages.map((s) => [s.id, s]));
  const done = new Set<string>();
  const out: Stage[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (done.has(id)) return;
    if (path.has(id)) throw new Error(`stage cycle at ${id}`);
    const s = byId.get(id);
    if (!s) throw new Error(`unknown stage ${id}`);
    path.add(id);
    for (const p of s.after) visit(p, path);
    path.delete(id);
    done.add(id);
    out.push(s);
  };
  for (const s of world.stages) visit(s.id, new Set());
  return out;
}

export interface Schedule {
  ok: boolean;
  times: Map<string, { start: number; finish: number }>;
  readyAt: number;
  problems: string[];
}

/**
 * Earliest-start schedule for fixed quantities per offer. Each stage starts once every allocation of the
 * stages it follows has finished (including handoff). Starting later only delays every finish, so when this
 * schedule misses a window or the deadline, no schedule for these quantities exists.
 */
export function earliestSchedule(world: World, intent: Intent, qty: Map<string, number>): Schedule {
  const now = t(intent.provenance.observedAt);
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const ready = new Map<string, number>();
  const times = new Map<string, { start: number; finish: number }>();
  const problems: string[] = [];
  for (const st of topo(world)) {
    let stageReady = -Infinity;
    for (const [id, q] of qty) {
      const o = offers.get(id);
      if (!o || o.stage !== st.id || q <= 0) continue;
      const start = Math.max(t(o.window.start), now, ...st.after.map((p) => ready.get(p) ?? -Infinity));
      const workEnd = start + Math.ceil((q / o.ratePerHour) * HOUR);
      const finish = workEnd + Math.round(o.handoffHours * HOUR);
      if (workEnd > t(o.window.end) + TIME_TOLERANCE_MS) problems.push(`window:${o.id}`);
      times.set(id, { start, finish });
      stageReady = Math.max(stageReady, finish);
    }
    if (stageReady > -Infinity) ready.set(st.id, stageReady);
  }
  const finals = [...terminalStages(world)].map((s) => ready.get(s) ?? -Infinity);
  const readyAt = Math.max(...finals);
  if (readyAt > t(intent.deadline) + TIME_TOLERANCE_MS) problems.push('deadline');
  return { ok: problems.length === 0, times, readyAt, problems };
}

/** Collects named checks the way the solver's plan verifier reports them. */
export class Checks {
  readonly list: Verification['checks'] = [];
  add(id: string, problems: string[], okText: string): void {
    this.list.push({ id, ok: problems.length === 0, text: problems.length ? problems.slice(0, 3).join(' ') : okText });
  }
  result(): Verification {
    return { ok: this.list.every((c) => c.ok), checks: this.list };
  }
}

/**
 * Independent schedule check of allocations against published offer terms: windows, working hours,
 * no work before the request, precedence between stages and the deadline.
 */
export function scheduleProblems(world: World, intent: Intent, allocs: Allocation[], readyAt: string): string[] {
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const stages = new Map(world.stages.map((s) => [s.id, s]));
  const now = t(intent.provenance.observedAt);
  const out: string[] = [];
  for (const a of allocs) {
    const o = offers.get(a.offer);
    if (!o) {
      out.push(`Offer ${a.offer} does not exist.`);
      continue;
    }
    const start = t(a.start);
    const workEnd = t(a.finish) - o.handoffHours * HOUR;
    if (start < t(o.window.start) - TIME_TOLERANCE_MS || workEnd > t(o.window.end) + TIME_TOLERANCE_MS) out.push(`${a.offer} works outside its window.`);
    if (workEnd - start < (a.qty / o.ratePerHour) * HOUR - TIME_TOLERANCE_MS) out.push(`${a.offer} has too few working hours for ${a.qty} units.`);
    if (start < now - TIME_TOLERANCE_MS) out.push(`${a.offer} starts before the request was made.`);
    for (const p of stages.get(a.stage)?.after ?? []) {
      for (const b of allocs) if (b.stage === p && t(b.finish) > start + TIME_TOLERANCE_MS) out.push(`${a.offer} starts before ${b.offer} output arrives.`);
    }
  }
  const finals = allocs.filter((a) => terminalStages(world).has(a.stage));
  const last = finals.length ? Math.max(...finals.map((a) => t(a.finish))) : NaN;
  if (Number.isFinite(last) && last > t(intent.deadline) + TIME_TOLERANCE_MS) out.push('The final output arrives after the deadline.');
  if (Number.isFinite(last) && Math.abs(last - t(readyAt)) > TIME_TOLERANCE_MS) out.push('The stated ready time does not match the schedule.');
  return out;
}
