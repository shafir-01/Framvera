import type { Actor, ConstraintRef, Id, Offer, Stage, StageId, World } from '@framvera/contracts';

export interface WorldIndex {
  world: World;
  actor: (id: Id | undefined) => Actor | undefined;
  actorName: (id: Id | undefined) => string;
  offer: (id: Id | undefined) => Offer | undefined;
  stage: (id: StageId | undefined) => Stage | undefined;
  offersByStage: Map<StageId, Offer[]>;
  layers: Stage[][];
}

export function indexWorld(world: World): WorldIndex {
  const actors = new Map(world.actors.map((a) => [a.id, a]));
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const stages = new Map(world.stages.map((s) => [s.id, s]));
  const offersByStage = new Map<StageId, Offer[]>();
  for (const s of world.stages) offersByStage.set(s.id, []);
  for (const o of latestOffers(world.offers)) offersByStage.get(o.stage)?.push(o);
  return {
    world,
    actor: (id) => (id ? actors.get(id) : undefined),
    actorName: (id) => (id ? (actors.get(id)?.name ?? id) : '–'),
    offer: (id) => (id ? offers.get(id) : undefined),
    stage: (id) => (id ? stages.get(id) : undefined),
    offersByStage,
    layers: stageLayers(world.stages),
  };
}

/** Keep only the highest version of each offer id. */
export function latestOffers(offers: Offer[]): Offer[] {
  const best = new Map<Id, Offer>();
  for (const o of offers) {
    const cur = best.get(o.id);
    if (!cur || o.version > cur.version) best.set(o.id, o);
  }
  return [...best.values()];
}

/** Longest-path layering of the stage graph, derived from each stage's `after` list. */
export function stageLayers(stages: Stage[]): Stage[][] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const depth = new Map<StageId, number>();
  const visiting = new Set<StageId>();
  const d = (s: Stage): number => {
    const known = depth.get(s.id);
    if (known !== undefined) return known;
    if (visiting.has(s.id)) return 0;
    visiting.add(s.id);
    const preds = s.after.map((id) => byId.get(id)).filter((x): x is Stage => !!x);
    const v = preds.length ? Math.max(...preds.map(d)) + 1 : 0;
    visiting.delete(s.id);
    depth.set(s.id, v);
    return v;
  };
  stages.forEach(d);
  const layers: Stage[][] = [];
  for (const s of stages) {
    const i = depth.get(s.id) ?? 0;
    (layers[i] ??= []).push(s);
  }
  return layers.filter(Boolean);
}

/** Which stages a constraint touches, or 'global' for whole-order limits like deadline and budget. */
export function constraintStages(c: ConstraintRef, ix: WorldIndex): StageId[] | 'global' {
  if (!c.subject) return 'global';
  if (ix.stage(c.subject)) return [c.subject];
  const o = ix.offer(c.subject);
  if (o) return [o.stage];
  const fromActor = ix.world.offers.filter((x) => x.actor === c.subject).map((x) => x.stage);
  if (fromActor.length) return [...new Set(fromActor)];
  return 'global';
}

export const KIND_LABEL: Record<string, string> = {
  demand: 'Quantity',
  capacity: 'Capacity',
  'min-qty': 'Minimum order',
  window: 'Time window',
  precedence: 'Order of work',
  deadline: 'Deadline',
  budget: 'Budget',
  'exclusive-resource': 'Shared capacity',
  validity: 'Validity',
};

/** Offer ids behind an allocation: a joint offer id names its member offers. */
export function offerParts(id: Id): Id[] {
  if (!id.startsWith('joint:')) return [id];
  return id
    .slice('joint:'.length)
    .replace(/^(shared|batch):/, '')
    .split(/[>+]/)
    .filter(Boolean);
}

export function bestUnitPrice(o: Offer, qty: number): number {
  let price = o.tiers[0]?.unit.minor ?? 0;
  for (const t of o.tiers) if (qty >= t.minQty) price = t.unit.minor;
  return price;
}
