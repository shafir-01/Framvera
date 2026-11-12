import type { Allocation, Id, Money, Obligation, Offer, Stage, StageId, World } from '@framvera/contracts';
import { HOUR, MINUTE, ms, money } from './util.ts';

/** Price per unit at a quantity: the highest tier whose minQty the quantity reaches. */
export function unitPrice(offer: Offer, qty: number): Money {
  let price = offer.tiers[0]?.unit ?? offer.setupFee;
  for (const t of offer.tiers) if (qty >= t.minQty) price = t.unit;
  return price;
}

export function allocationCost(offer: Offer, qty: number): Money {
  return money(offer.setupFee.currency, offer.setupFee.minor + unitPrice(offer, qty).minor * qty);
}

/** Production time in ms, rounded up to whole minutes. */
export function workMs(offer: Offer, qty: number): number {
  if (qty <= 0) return 0;
  return Math.ceil((qty / offer.ratePerHour) * (HOUR / MINUTE)) * MINUTE;
}

export interface Slot {
  start: number;
  workEnd: number;
  finish: number;
}

/** Earliest slot for qty on offer starting no earlier than `earliest`, or null if the window cannot hold it. */
export function earliestSlot(offer: Offer, qty: number, earliest: number): Slot | null {
  const start = Math.max(ms(offer.window.start), earliest);
  const workEnd = start + workMs(offer, qty);
  if (workEnd > ms(offer.window.end)) return null;
  return { start, workEnd, finish: workEnd + offer.handoffHours * HOUR };
}

export function topoStages(stages: Stage[]): Stage[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const out: Stage[] = [];
  const seen = new Set<StageId>();
  const visit = (s: Stage, path: Set<StageId>): void => {
    if (seen.has(s.id)) return;
    if (path.has(s.id)) throw new Error(`Stage cycle at ${s.id}`);
    path.add(s.id);
    for (const p of s.after) {
      const ps = byId.get(p);
      if (ps) visit(ps, path);
    }
    path.delete(s.id);
    seen.add(s.id);
    out.push(s);
  };
  for (const s of stages) visit(s, new Set());
  return out;
}

/** Stage ids that transitively depend on the given stage. */
export function downstreamStages(stages: Stage[], from: StageId): Set<StageId> {
  const out = new Set<StageId>();
  let frontier = [from];
  while (frontier.length) {
    const next: StageId[] = [];
    for (const s of stages) {
      if (out.has(s.id)) continue;
      if (s.after.some((a) => frontier.includes(a))) {
        out.add(s.id);
        next.push(s.id);
      }
    }
    frontier = next;
  }
  return out;
}

export function finalStages(stages: Stage[]): Stage[] {
  const feeders = new Set(stages.flatMap((s) => s.after));
  return stages.filter((s) => !feeders.has(s.id));
}

export function required(world: World, stage: Stage, quantity: number): number {
  return Math.ceil(quantity * stage.perOutcome - 1e-9);
}

export const offerMap = (world: World): Map<Id, Offer> => new Map(world.offers.map((o) => [o.id, o]));

export function toAllocation(o: Obligation): Allocation {
  return { offer: o.offer, actor: o.actor, stage: o.stage, qty: o.qty, start: o.start, finish: o.due, cost: o.amount };
}

export const sameTerms = (a: Allocation, o: Obligation): boolean =>
  a.offer === o.offer &&
  a.stage === o.stage &&
  a.qty === o.qty &&
  ms(a.start) === ms(o.start) &&
  ms(a.finish) === ms(o.due) &&
  a.cost.minor === o.amount.minor &&
  a.cost.currency === o.amount.currency;

export function readyAt(world: World, allocs: Allocation[]): number {
  const finals = new Set(finalStages(world.stages).map((s) => s.id));
  let t = -Infinity;
  for (const a of allocs) if (finals.has(a.stage)) t = Math.max(t, ms(a.finish));
  return t;
}

/** Member offers of a joint offer id ("joint:shared:a>b" or "joint:batch:a+b"), or null for an ordinary offer. */
export function coalitionMembers(offerId: string): string[] | null {
  if (offerId.startsWith('joint:shared:')) {
    const parts = offerId.slice('joint:shared:'.length).split('>');
    return parts.length === 2 && parts.every(Boolean) ? parts : null;
  }
  if (offerId.startsWith('joint:batch:')) {
    const parts = offerId.slice('joint:batch:'.length).split('+').filter(Boolean);
    return parts.length >= 2 ? parts : null;
  }
  return null;
}

/** Offers that cannot be used together: a joint offer and each of its members. */
export function exclusivePairs(offerIds: Iterable<string>): [string, string][] {
  const ids = new Set(offerIds);
  const out: [string, string][] = [];
  for (const id of ids) for (const m of coalitionMembers(id) ?? []) if (ids.has(m)) out.push([id, m]);
  return out;
}
