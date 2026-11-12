import type { Agreement, Allocation, Concession, Currency, Disruption, Id, Iso, Money, NegotiableField, Obligation, Offer, Plan, Recovery, StageId, World } from '@framvera/contracts';
import { stageLayers } from '../lib/world.ts';

export type BarStatus = 'planned' | 'kept' | 'withdrawn' | 'superseded' | 'at-risk' | 'added' | 'amended';

export interface ScheduleProps {
  plan: Plan;
  agreement?: Agreement;
  recovery?: Recovery;
  /** The negotiated world: supplies stage names, precedence, windows and handoffs. */
  world?: World;
  /** The world as first published, to show how far each window was stretched. */
  originalWorld?: World;
  /** The buyer's deadline. */
  deadline?: Iso;
  /** The event that started the Adapt stage, if any. */
  disruption?: Disruption;
  /** Called when the user drags a window edge. The caller re-solves; the chart never changes by itself. */
  onAdjust?: (concession: Concession) => void;
}

export interface Win {
  from: number;
  to: number;
}

export interface Bar {
  key: string;
  offer: Id;
  actor: Id;
  actorName: string;
  stage: StageId;
  unit: string;
  qty: number;
  start: number;
  workEnd: number;
  finish: number;
  handoffHours: number;
  cost: Money;
  status: BarStatus;
  obligation?: Obligation;
  window?: Win;
  originalWindow?: Win;
  negotiable: NegotiableField[];
  coalition?: Id;
}

export interface Lane {
  stage: StageId;
  name: string;
  unit: string;
  bars: Bar[];
}

export interface Edge {
  from: Bar;
  to: Bar;
  /** Hours between the input being ready and the next stage starting. Negative means the order of work is broken. */
  slackHours: number;
  broken: boolean;
}

export interface Unit {
  bars: Bar[];
  coalition?: Id;
  from: number;
  to: number;
}

export interface Model {
  lanes: Lane[];
  edges: Edge[];
  currency: Currency;
  deadline?: number;
  readyAt?: number;
  marginHours?: number;
  total: Money;
  extraCost?: Money;
  slipHours?: number;
  adapting: boolean;
  hasWindows: boolean;
  hasCoalition: boolean;
  t0: number;
  t1: number;
}

const ms = (iso: Iso) => new Date(iso).getTime();

export const isLive = (b: Bar) => b.status !== 'withdrawn' && b.status !== 'superseded';

function pick(offers: Offer[], id: Id, newest: boolean): Offer | undefined {
  let best: Offer | undefined;
  for (const o of offers) {
    if (o.id !== id) continue;
    if (!best || (newest ? o.version > best.version : o.version < best.version)) best = o;
  }
  return best;
}

interface Raw {
  obligation?: Obligation;
  alloc: Pick<Allocation, 'offer' | 'actor' | 'stage' | 'qty' | 'start' | 'finish' | 'cost'>;
}

function gather(agreement: Agreement | undefined, plan: Plan, recovery: Recovery | undefined): Raw[] {
  const raws: Raw[] = [];
  if (agreement?.obligations.length) {
    for (const ob of agreement.obligations) {
      raws.push({ obligation: ob, alloc: { offer: ob.offer, actor: ob.actor, stage: ob.stage, qty: ob.qty, start: ob.start, finish: ob.due, cost: ob.amount } });
    }
  } else {
    for (const a of plan.allocations) raws.push({ alloc: a });
  }
  for (const a of recovery?.added ?? []) {
    const present = raws.some((r) => r.alloc.offer === a.offer && r.alloc.start === a.start && r.alloc.qty === a.qty && r.obligation?.state !== 'REPLACED' && r.obligation?.state !== 'CANCELLED');
    if (!present) raws.push({ alloc: a });
  }
  return raws;
}

function statusOf(raw: Raw, raws: Raw[], recovery: Recovery | undefined, disruption: Disruption | undefined): BarStatus {
  const ob = raw.obligation;
  const left = !!disruption && ((!!disruption.offer && disruption.offer === raw.alloc.offer) || (!!disruption.actor && disruption.actor === raw.alloc.actor));
  if (!ob) return recovery?.added.some((a) => a.offer === raw.alloc.offer && a.start === raw.alloc.start) ? 'added' : 'planned';
  const all = raws.flatMap((r) => (r.obligation ? [r.obligation] : []));
  const successor = all.find((o) => o.replaces === ob.id);
  if (ob.state === 'REPLACED' || ob.state === 'CANCELLED' || ob.state === 'BREACHED') {
    if (left || recovery?.cancelled.includes(ob.id) || !successor || successor.actor !== ob.actor) return 'withdrawn';
    return 'superseded';
  }
  if (left || recovery?.cancelled.includes(ob.id)) return 'withdrawn';
  if (recovery?.added.some((a) => a.offer === ob.offer && a.start === ob.start)) return 'added';
  if (ob.replaces) {
    const pred = all.find((o) => o.id === ob.replaces);
    return pred && pred.actor === ob.actor ? 'amended' : 'added';
  }
  if (ob.state === 'AT_RISK') return 'at-risk';
  if (recovery) return recovery.amended.includes(ob.id) ? 'amended' : 'kept';
  return 'planned';
}

export function buildModel(p: ScheduleProps): Model {
  const { plan, agreement, recovery, world, originalWorld, disruption } = p;
  const currency = plan.total.currency;
  const raws = gather(agreement, plan, recovery);
  const pool = [...(world?.offers ?? []), ...(originalWorld?.offers ?? [])];
  const actorName = (id: Id) => world?.actors.find((a) => a.id === id)?.name ?? id;

  const bars: Bar[] = raws.map((raw, i) => {
    const a = raw.alloc;
    const now = pick(pool, a.offer, true);
    const first = pick(pool, a.offer, false);
    const handoffHours = now?.handoffHours ?? 0;
    const finish = ms(a.finish);
    const start = ms(a.start);
    return {
      key: raw.obligation?.id ?? `alloc:${a.offer}:${i}`,
      offer: a.offer,
      actor: a.actor,
      actorName: actorName(a.actor),
      stage: a.stage,
      unit: world?.stages.find((s) => s.id === a.stage)?.unit ?? 'units',
      qty: a.qty,
      start,
      workEnd: Math.max(start, finish - handoffHours * 3_600_000),
      finish,
      handoffHours,
      cost: a.cost,
      status: statusOf(raw, raws, recovery, disruption),
      obligation: raw.obligation,
      window: now ? { from: ms(now.window.start), to: ms(now.window.end) } : undefined,
      originalWindow: first ? { from: ms(first.window.start), to: ms(first.window.end) } : undefined,
      negotiable: now?.negotiable ?? [],
      coalition: now?.derivedFrom?.coalition,
    };
  });

  const stageIds = [...new Set(bars.map((b) => b.stage))];
  const order = world ? stageLayers(world.stages).flat().map((s) => s.id) : [];
  const minStart = (id: StageId) => Math.min(...bars.filter((b) => b.stage === id).map((b) => b.start));
  stageIds.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return ia >= 0 && ib >= 0 ? ia - ib : minStart(a) - minStart(b);
  });
  const lanes: Lane[] = stageIds.map((id) => {
    const st = world?.stages.find((s) => s.id === id);
    const mine = bars.filter((b) => b.stage === id).sort((a, b) => a.start - b.start || a.finish - b.finish);
    return { stage: id, name: st?.name ?? id, unit: st?.unit ?? 'units', bars: mine };
  });

  const edges: Edge[] = [];
  for (const st of world?.stages ?? []) {
    const succ = bars.filter((b) => b.stage === st.id);
    if (!succ.length) continue;
    for (const pid of st.after) {
      const preds = bars.filter((b) => b.stage === pid);
      if (!preds.length) continue;
      const lp = preds.filter(isLive);
      const ls = succ.filter(isLive);
      const ps = lp.length ? lp : preds;
      const ss = ls.length ? ls : succ;
      const from = ps.reduce((a, b) => (b.finish > a.finish ? b : a));
      const to = ss.reduce((a, b) => (b.start < a.start ? b : a));
      const slackHours = (to.start - from.finish) / 3_600_000;
      edges.push({ from, to, slackHours, broken: slackHours < 0 || !isLive(from) || !isLive(to) });
    }
  }

  const alive = bars.filter(isLive);
  const readyAt = alive.length ? Math.max(...alive.map((b) => b.finish)) : undefined;
  const deadline = p.deadline ? ms(p.deadline) : undefined;
  const total: Money = alive.length === bars.length && !recovery ? plan.total : { currency, minor: alive.reduce((s, b) => s + b.cost.minor, 0) };

  const times = bars.flatMap((b) => [b.start, b.finish, b.window?.from, b.window?.to, b.originalWindow?.from, b.originalWindow?.to]).filter((x): x is number => typeof x === 'number');
  if (deadline !== undefined) times.push(deadline);
  const lo = times.length ? Math.min(...times) : 0;
  const hi = times.length ? Math.max(...times) : lo + 3_600_000;
  const pad = Math.max((hi - lo) * 0.02, 1_800_000);

  return {
    lanes,
    edges,
    currency,
    deadline,
    readyAt,
    marginHours: deadline !== undefined && readyAt !== undefined ? (deadline - readyAt) / 3_600_000 : undefined,
    total,
    extraCost: recovery?.extraCost,
    slipHours: recovery?.slipHours,
    adapting: !!recovery || !!disruption || bars.some((b) => b.status === 'at-risk' || b.status === 'withdrawn'),
    hasWindows: bars.some((b) => b.window),
    hasCoalition: bars.some((b) => b.coalition),
    t0: lo - pad,
    t1: hi + pad,
  };
}

/** Group a lane into layout units: coalition members share one outline and one block of rows. */
export function unitsOf(lane: Lane): Unit[] {
  const units: Unit[] = [];
  const byCo = new Map<Id, Bar[]>();
  for (const b of lane.bars) {
    if (b.coalition && isLive(b)) byCo.set(b.coalition, [...(byCo.get(b.coalition) ?? []), b]);
  }
  const grouped = new Set<Bar>();
  for (const [co, list] of byCo) {
    if (list.length < 2) continue;
    list.forEach((b) => grouped.add(b));
    units.push({ bars: list, coalition: co, from: Math.min(...list.map((b) => b.start)), to: Math.max(...list.map((b) => b.finish)) });
  }
  for (const b of lane.bars) if (!grouped.has(b)) units.push({ bars: [b], from: b.start, to: b.finish });
  return units.sort((a, b) => a.from - b.from);
}

/** Greedy row packing at unit granularity. Returns the first row of each unit and the lane's row count. */
export function packRows(units: Unit[], gapMs: number): { rows: number[]; count: number } {
  const ends: number[] = [];
  const rows = units.map((u) => {
    const need = u.bars.length;
    let r = 0;
    for (;; r++) {
      let ok = true;
      for (let k = 0; k < need; k++) if ((ends[r + k] ?? -Infinity) + gapMs > u.from) ok = false;
      if (ok) break;
    }
    for (let k = 0; k < need; k++) ends[r + k] = u.to;
    return r;
  });
  return { rows, count: Math.max(1, ends.length) };
}
