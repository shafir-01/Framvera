import type { Actor, Allocation, Claim, Coalition, Id, Intent, Offer, Stage, StageId, World } from '@framvera/contracts';

export interface Candidate {
  actor: Actor;
  offer: Offer;
  /** Capacity pool this offer draws from, when another offer claims the same underlying capacity. */
  pool?: Id;
}

export interface Pool {
  id: Id;
  /** Units the shared resource can deliver in total, however many offers draw on it. */
  limit: number;
  offers: Id[];
}

export type ConflictKind = 'shared-capacity' | 'below-minimum';

export interface Conflict {
  kind: ConflictKind;
  offers: Id[];
  text: string;
}

export interface Lane {
  actor: Id;
  offer: Id;
  /** Units this member can supply once shared capacity is divided between members. */
  allotted: number;
  claimed: number;
  pool?: Id;
}

export interface Draft {
  stage: Stage;
  demand: number;
  lanes: Lane[];
  covered: number;
  covers: boolean;
  conflicts: Conflict[];
  /** Members with no offer for this stage. */
  unmatched: Id[];
  coalition?: Coalition;
}

export function latest(offers: Offer[]): Offer[] {
  const best = new Map<Id, Offer>();
  for (const o of offers) {
    const cur = best.get(o.id);
    if (!cur || o.version > cur.version) best.set(o.id, o);
  }
  return [...best.values()];
}

export function stageDemand(stage: Stage, intent: Intent): number {
  return Math.ceil(intent.quantity * stage.perOutcome - 1e-9);
}

export function unitPrice(offer: Offer, qty: number): number {
  const tiers = [...offer.tiers].sort((a, b) => a.minQty - b.minQty);
  let p = tiers[0]?.unit.minor ?? 0;
  for (const t of tiers) if (qty >= t.minQty) p = t.unit.minor;
  return p;
}

/** Offers that list the same claim id draw on one underlying resource. */
export function pools(world: World, offers: Offer[]): Pool[] {
  const claimById = new Map<Id, Claim>(world.claims.map((c) => [c.id, c]));
  const users = new Map<Id, Offer[]>();
  for (const o of offers) for (const c of o.claims) users.set(c, [...(users.get(c) ?? []), o]);
  const out: Pool[] = [];
  for (const [id, list] of users) {
    if (list.length < 2) continue;
    const claim = claimById.get(id);
    const limit = typeof claim?.value === 'number' ? claim.value : Math.max(...list.map((o) => o.capacity));
    out.push({ id, limit, offers: list.map((o) => o.id) });
  }
  return out;
}

export function candidatesFor(world: World, stage: StageId): Candidate[] {
  const actors = new Map(world.actors.map((a) => [a.id, a]));
  const offers = latest(world.offers).filter((o) => o.stage === stage);
  const shared = pools(world, offers);
  const out: Candidate[] = [];
  for (const o of offers) {
    const actor = actors.get(o.actor);
    if (!actor || !actor.active || actor.kind === 'buyer') continue;
    const pool = shared.find((p) => p.offers.includes(o.id));
    out.push({ actor, offer: o, ...(pool ? { pool: pool.id } : {}) });
  }
  return out.sort((a, b) => unitPrice(a.offer, 1) - unitPrice(b.offer, 1) || a.actor.name.localeCompare(b.actor.name));
}

/** One offer per member: the cheapest per unit at the stage's demand. */
export function pickOffer(world: World, stage: StageId, actor: Id, demand: number): Offer | undefined {
  return latest(world.offers)
    .filter((o) => o.stage === stage && o.actor === actor)
    .sort((a, b) => unitPrice(a, demand) - unitPrice(b, demand))[0];
}

/**
 * Build the candidate bundle for one stage. Shared capacity is divided between its users cheapest first,
 * so the same units are never counted for two members.
 */
export function draft(world: World, intent: Intent, stageId: StageId, members: Id[], id = 'co_forge'): Draft | undefined {
  const stage = world.stages.find((s) => s.id === stageId);
  if (!stage) return undefined;
  const demand = stageDemand(stage, intent);
  const unmatched: Id[] = [];
  const picked: Offer[] = [];
  for (const m of members) {
    const o = pickOffer(world, stageId, m, demand);
    if (o) picked.push(o);
    else unmatched.push(m);
  }
  const stageOffers = latest(world.offers).filter((o) => o.stage === stageId);
  const shared = pools(world, stageOffers).filter((p) => picked.some((x) => p.offers.includes(x.id)));
  const sorted = [...picked].sort((a, b) => unitPrice(a, demand) - unitPrice(b, demand));
  const left = new Map<Id, number>(shared.map((p) => [p.id, p.limit]));
  const conflicts: Conflict[] = [];
  const name = (actor: Id) => world.actors.find((a) => a.id === actor)?.name ?? actor;
  const lanes: Lane[] = [];
  for (const o of sorted) {
    const pool = shared.find((p) => p.offers.includes(o.id));
    let allotted = o.capacity;
    if (pool) {
      allotted = Math.min(allotted, left.get(pool.id) ?? 0);
      left.set(pool.id, (left.get(pool.id) ?? 0) - allotted);
    }
    lanes.push({ actor: o.actor, offer: o.id, allotted, claimed: o.capacity, ...(pool ? { pool: pool.id } : {}) });
  }
  for (const p of shared) {
    const users = picked.filter((o) => p.offers.includes(o.id));
    if (users.length < 2) continue;
    const claimedSum = users.reduce((a, o) => a + o.capacity, 0);
    if (claimedSum > p.limit) {
      conflicts.push({
        kind: 'shared-capacity',
        offers: users.map((o) => o.id),
        text: `${users.map((o) => name(o.actor)).join(' and ')} share one resource of ${p.limit} ${stage.unit}. Together they claim ${claimedSum}, so only ${p.limit} count.`,
      });
    }
  }
  for (const l of lanes) {
    const o = picked.find((x) => x.id === l.offer)!;
    if (l.allotted > 0 && l.allotted < o.minQty) {
      conflicts.push({ kind: 'below-minimum', offers: [o.id], text: `${name(o.actor)} needs at least ${o.minQty} ${stage.unit} per order but only ${l.allotted} are left for it.` });
    }
  }
  const covered = lanes.reduce((a, l) => a + l.allotted, 0);
  const covers = covered >= demand && demand > 0;
  const active = lanes.filter((l) => l.allotted > 0);
  const coalition: Coalition | undefined =
    active.length > 0
      ? {
          id,
          members: active.map((l) => l.actor),
          output: { stage: stageId, qty: demand },
          inputs: active.map((l) => ({ offer: l.offer, qty: l.allotted })),
          split: [],
          rationality: [],
        }
      : undefined;
  return { stage, demand, lanes, covered, covers, conflicts, unmatched, ...(coalition ? { coalition } : {}) };
}

/** The world as the plan sees it when this bundle is the only supply for the stage. */
export function restrict(world: World, d: Draft): World {
  const cap = new Map(d.lanes.map((l) => [l.offer, l.allotted]));
  const offers = world.offers
    .filter((o) => o.stage !== d.stage.id || cap.has(o.id))
    .map((o) => (cap.has(o.id) ? { ...o, capacity: Math.min(o.capacity, cap.get(o.id)!) } : o));
  return { ...world, offers };
}

export function stageAllocations(plan: { allocations: Allocation[] }, stage: StageId): Allocation[] {
  return plan.allocations.filter((a) => a.stage === stage && a.qty > 0);
}

/** The bundle restated from a solved plan, so the split is over what is actually bought. */
export function coalitionFromPlan(base: Coalition, allocs: Allocation[]): Coalition {
  const byOffer = new Map<Id, number>();
  for (const a of allocs) byOffer.set(a.offer, (byOffer.get(a.offer) ?? 0) + a.qty);
  const actorOf = new Map(allocs.map((a) => [a.offer, a.actor]));
  const inputs = [...byOffer].map(([offer, qty]) => ({ offer, qty }));
  const members = [...new Set(inputs.map((i) => actorOf.get(i.offer)!))];
  return { ...base, members, inputs, output: { ...base.output, qty: inputs.reduce((a, i) => a + i.qty, 0) } };
}
