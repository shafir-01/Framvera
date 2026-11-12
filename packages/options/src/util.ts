import type { Allocation, Obligation, Stage, StageId, World } from '@framvera/contracts';

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
/** Timing comparisons tolerate the verifier's one-second rounding allowance. */
export const TOLERANCE_MS = 1000;

export const ms = (t: string): number => {
  const v = Date.parse(t);
  if (Number.isNaN(v)) throw new Error(`Invalid timestamp: ${t}`);
  return v;
};
export const iso = (t: number): string => new Date(Math.round(t)).toISOString();
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Working time for qty units at a rate, rounded up to whole minutes. */
export function workMs(ratePerHour: number, qty: number): number {
  return Math.ceil((qty / ratePerHour) * 60) * MINUTE;
}

/** Deterministic 32-bit generator (mulberry32). The same seed always gives the same stream. */
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

export function pick<T>(xs: readonly T[], u: number): T {
  return xs[Math.min(xs.length - 1, Math.floor(u * xs.length))]!;
}

export function toAllocation(o: Obligation): Allocation {
  return { offer: o.offer, actor: o.actor, stage: o.stage, qty: o.qty, start: o.start, finish: o.due, cost: o.amount };
}

export function stageIndex(world: World): Map<StageId, number> {
  const order: Stage[] = [];
  const byId = new Map(world.stages.map((s) => [s.id, s]));
  const seen = new Set<StageId>();
  const visit = (s: Stage) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    for (const p of s.after) {
      const ps = byId.get(p);
      if (ps) visit(ps);
    }
    order.push(s);
  };
  for (const s of world.stages) visit(s);
  return new Map(order.map((s, i) => [s.id, i]));
}

export function successors(world: World, stage: StageId): StageId[] {
  return world.stages.filter((s) => s.after.includes(stage)).map((s) => s.id);
}

export function downstream(world: World, stage: StageId): Set<StageId> {
  const out = new Set<StageId>();
  let frontier = [stage];
  while (frontier.length) {
    const next: StageId[] = [];
    for (const s of world.stages) if (!out.has(s.id) && s.after.some((a) => frontier.includes(a))) (out.add(s.id), next.push(s.id));
    frontier = next;
  }
  return out;
}

export function terminalStages(world: World): Set<StageId> {
  const feeding = new Set(world.stages.flatMap((s) => s.after));
  return new Set(world.stages.filter((s) => !feeding.has(s.id)).map((s) => s.id));
}

export function fmtKr(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = abs % 100;
  return `${sign}${whole}${cents ? ',' + String(cents).padStart(2, '0') : ''} kr`;
}
