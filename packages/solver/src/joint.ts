import type { Coalition, Money, Offer, Plan, World } from '@framvera/contracts';
import { composeJoint, jointMembers, jointShares } from '@framvera/contracts';

/**
 * Joint offers follow the shared contracts semantics (composeJoint): the larger member's capacity
 * run inside the window of the member available latest, at that member's rate and handoff, with
 * every member's setup fee paid and the highest first-tier unit price.
 * Id: joint:shared:<capacity offer>><operator offer>.
 */
export interface CoalitionShape {
  id: string;
  members: string[];
}

export function parseCoalition(id: string): CoalitionShape | null {
  const members = jointMembers(id);
  return members && members.length >= 2 ? { id, members } : null;
}

/** The composite offer for a joint id, or null when its members cannot form it as named. */
export function deriveOffer(world: World, id: string, concessions: string[] = []): Offer | null {
  const shape = parseCoalition(id);
  if (!shape) return null;
  const byId = new Map(world.offers.map((o) => [o.id, o]));
  const members = shape.members.map((m) => byId.get(m));
  if (members.some((m) => !m)) return null;
  try {
    const joint = composeJoint(members as Offer[], id, world.createdAt);
    if (joint.id !== id) return null;
    return { ...joint, derivedFrom: { concessions, coalition: id } };
  } catch {
    return null;
  }
}

/** The pairing composeJoint would name for two offers, or null when it adds nothing over the larger one. */
export function sharedId(a: Offer, b: Offer): string | null {
  const vehicle = b.capacity > a.capacity ? b : a;
  const crew = Date.parse(b.window.end) > Date.parse(a.window.end) ? b : a;
  return vehicle === crew ? null : `joint:shared:${vehicle.id}>${crew.id}`;
}

/**
 * The coalition record for a joint offer at a given quantity: what each member contributes and the
 * default payment split from the shared contracts (each member keeps its setup fee, per-unit revenue
 * shared by first-tier unit prices). Outside options default to no sale in this request unless a
 * plan without the coalition is given.
 */
export function describeCoalition(world: World, id: string, qty: number, outside?: Plan): Coalition | null {
  const shape = parseCoalition(id);
  const byId = new Map(world.offers.map((o) => [o.id, o]));
  const members = shape?.members.map((m) => byId.get(m));
  if (!shape || !members || members.some((m) => !m)) return null;
  const ms = members as Offer[];
  const joint = byId.get(id) ?? deriveOffer(world, id);
  if (!joint) return null;
  const shares = jointShares(ms, qty);
  const unit = world.stages.find((s) => s.id === joint.stage)?.unit ?? 'units';
  const earned = new Map<string, number>();
  for (const a of outside?.allocations ?? []) earned.set(a.actor, (earned.get(a.actor) ?? 0) + a.cost.minor);
  const currency = joint.setupFee.currency;
  const money = (minor: number): Money => ({ currency, minor });
  const vehicle = ms.reduce((best, m) => (m.capacity > best.capacity ? m : best));
  return {
    id,
    members: ms.map((m) => m.actor),
    output: { stage: joint.stage, qty },
    inputs: ms.map((m) => ({ offer: m.id, qty })),
    split: shares.map((s) => ({
      actor: s.actor,
      share: s.share,
      reason:
        s.offer === vehicle.id
          ? `Provides the capacity for ${qty} ${unit}: its setup fee plus a per-unit share.`
          : `Runs the job in its own window: its setup fee plus a per-unit share.`,
    })),
    rationality: shares.map((s) => {
      const out = earned.get(s.actor) ?? 0;
      return { actor: s.actor, outside: money(out), ok: s.share.minor >= out };
    }),
  };
}

/** Adds the joint offer to a copy of the world and marks its members. */
export function applyCoalition(world: World, coalition: Coalition | string, concessions: string[] = []): World {
  const id = typeof coalition === 'string' ? coalition : coalition.id;
  const shape = parseCoalition(id);
  if (!shape) throw new Error(`unknown joint offer ${id}`);
  const next = structuredClone(world);
  if (next.offers.some((o) => o.id === id)) return next;
  const derived = deriveOffer(next, id, concessions);
  if (!derived) throw new Error(`joint offer ${id} cannot be formed from the published offers`);
  for (const o of next.offers) {
    if (shape.members.includes(o.id)) o.derivedFrom = { concessions: o.derivedFrom?.concessions ?? [], coalition: id };
  }
  next.offers.push(derived);
  next.version = world.version + 1;
  return next;
}
