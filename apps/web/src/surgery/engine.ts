import type { Concession, Intent, World } from '@framvera/contracts';
import { Lane, type WorkerResult } from './solver.ts';

type ResultOf<O extends WorkerResult['op']> = Extract<WorkerResult, { op: O }>;

/**
 * Three solver workers on this device: `live` answers the slider the user is moving, `scan` maps the
 * feasibility frontier, and `blocker` finds what still blocks a plan, so background work never delays a live answer.
 */
export class Engine {
  private live = new Lane();
  private scan = new Lane();
  private blocker = new Lane();

  constructor(
    private world: World,
    private intent: Intent,
  ) {}

  async feasible(slot: string, concessions: Concession[], background = false): Promise<ResultOf<'feasible'> | null> {
    const lane = background ? this.scan : this.live;
    return (await lane.run(slot, { op: 'feasible', world: this.world, intent: this.intent, concessions })) as ResultOf<'feasible'> | null;
  }

  async solve(slot: string, concessions: Concession[], timeLimitMs?: number): Promise<ResultOf<'solve'> | null> {
    return (await this.live.run(slot, { op: 'solve', world: this.world, intent: this.intent, concessions, opts: { explain: false, timeLimitMs } })) as ResultOf<'solve'> | null;
  }

  /** What blocks a set of changes. Each new request stops the previous one, which can take seconds on large worlds. */
  async core(concessions: Concession[], timeLimitMs = 30000): Promise<ResultOf<'core'> | null> {
    this.blocker.cancel('core');
    this.blocker.kill();
    return (await this.blocker.run('core', { op: 'core', world: this.world, intent: this.intent, concessions, opts: { timeLimitMs } })) as ResultOf<'core'> | null;
  }

  stopCore() {
    this.blocker.cancel('core');
    this.blocker.kill();
  }

  cancelScan(prefix: string) {
    this.scan.cancel(prefix);
  }

  close() {
    this.live.terminate();
    this.scan.terminate();
    this.blocker.terminate();
  }
}

export interface FrontierPoint {
  delta: number;
  feasibility: 'feasible' | 'infeasible' | 'unknown';
}

export interface Frontier {
  key: string;
  points: FrontierPoint[];
  /** Smallest lever position on its grain that makes a plan possible, given the other changes. */
  threshold?: number;
  /** True when even the largest position on the slider leaves the order impossible. */
  none?: boolean;
  done: boolean;
}

/**
 * Feasibility along one lever with every other change held fixed. Each lever only relaxes a constraint,
 * so feasibility is monotone along it; a bisection on the lever's grain between the last impossible and
 * the first possible sample therefore finds the exact smallest position that works.
 */
export async function scanFrontier(
  engine: Engine,
  key: string,
  max: number,
  grain: number,
  at: (delta: number) => Concession[],
  onUpdate: (f: Frontier) => void,
  alive: () => boolean,
  samples = 13,
): Promise<void> {
  const slot = `scan:${key}`;
  const snap = (v: number) => Math.min(max, Math.round(v / grain) * grain);
  const deltas = [...new Set(Array.from({ length: samples }, (_, i) => snap((max * i) / (samples - 1))))];
  const points: FrontierPoint[] = [];
  const emit = (extra: Partial<Frontier> = {}) => onUpdate({ key, points: points.slice().sort((a, b) => a.delta - b.delta), done: false, ...extra });
  const check = async (d: number) => {
    const r = await engine.feasible(slot, at(d), true);
    if (!r || !alive()) return null;
    return r.feasibility;
  };
  for (const d of deltas) {
    const f = await check(d);
    if (f === null) return;
    points.push({ delta: d, feasibility: f });
    emit();
  }
  const sorted = points.slice().sort((a, b) => a.delta - b.delta);
  const first = sorted.findIndex((p) => p.feasibility === 'feasible');
  if (first === -1) return emit({ none: sorted.every((p) => p.feasibility === 'infeasible'), done: true });
  if (first === 0) return emit({ threshold: 0, done: true });
  const below = sorted[first - 1]!;
  if (below.feasibility !== 'infeasible') return emit({ done: true });
  let lo = below.delta;
  let hi = sorted[first]!.delta;
  while (hi - lo > grain) {
    const mid = snap(lo + Math.floor((hi - lo) / 2 / grain) * grain);
    if (mid <= lo || mid >= hi) break;
    const f = await check(mid);
    if (f === null) return;
    if (f === 'unknown') return emit({ done: true });
    points.push({ delta: mid, feasibility: f });
    if (f === 'feasible') hi = mid;
    else lo = mid;
  }
  emit({ threshold: hi, done: true });
}
