import type { Allocation, Id, Money, Obligation, Offer, Stage, StageId, World } from '@framvera/contracts';
import { jointShares } from '@framvera/contracts';
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

/** Each member's part of a joint job under the shared contracts split, or null for an ordinary offer or when a member offer is not in the world. */
export function jointParts(world: World, offerId: string, qty: number): { actor: Id; share: Money }[] | null {
  const members = coalitionMembers(offerId);
  if (!members) return null;
  const offers = members.map((m) => world.offers.find((o) => o.id === m));
  if (offers.some((o) => !o)) return null;
  return jointShares(offers as Offer[], qty).map((s) => ({ actor: s.actor, share: s.share }));
}

/** One obligation per member for a joint job, each with its exact share; ordinary obligations pass through. */
export function splitJoint<T extends { actor: Id; offer: string; qty: number; amount: Money }>(o: T, world?: World): T[] {
  if (!world) return [o];
  const parts = jointParts(world, o.offer, o.qty);
  if (!parts || parts.reduce((s, p) => s + p.share.minor, 0) !== o.amount.minor) return [o];
  return parts.map((p) => ({ ...o, actor: p.actor, amount: p.share }));
}

const jobKey = (o: { offer: string; start: string; due: string }) => `${o.offer}|${o.start}|${o.due}`;

/** The members of a joint job deliver the same units together, so quantities count the job once. */
export function uniqueJobs<T extends { offer: string; start: string; due: string }>(obligations: readonly T[]): T[] {
  const seen = new Set<string>();
  return obligations.filter((o) => {
    if (!coalitionMembers(o.offer)) return true;
    const k = jobKey(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Folds a joint job's member obligations back into one, for planning; `groups` maps the kept id to every member id. */
export function mergeJoint(obligations: readonly Obligation[], world: World): { obligations: Obligation[]; groups: Map<Id, Id[]> } {
  const groups = new Map<Id, Id[]>();
  const head = new Map<string, Obligation>();
  const out: Obligation[] = [];
  for (const o of obligations) {
    if (!coalitionMembers(o.offer)) {
      out.push(o);
      continue;
    }
    const k = `${jobKey(o)}|${o.state}`;
    const first = head.get(k);
    if (!first) {
      const merged = { ...o, actor: world.offers.find((x) => x.id === o.offer)?.actor ?? o.actor };
      head.set(k, merged);
      groups.set(o.id, [o.id]);
      out.push(merged);
      continue;
    }
    first.amount = { ...first.amount, minor: first.amount.minor + o.amount.minor };
    groups.get(first.id)!.push(o.id);
  }
  for (const [id, ids] of groups) if (ids.length === 1) groups.delete(id);
  return { obligations: out, groups };
}

/** Offers that cannot be used together: a joint offer and each of its members. */
export function exclusivePairs(offerIds: Iterable<string>): [string, string][] {
  const ids = new Set(offerIds);
  const out: [string, string][] = [];
  for (const id of ids) for (const m of coalitionMembers(id) ?? []) if (ids.has(m)) out.push([id, m]);
  return out;
}
