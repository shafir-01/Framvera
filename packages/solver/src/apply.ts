import type { Concession, Intent, Offer, World } from '@framvera/contracts';
import { composeJoint } from '@framvera/contracts';
import { parseCoalition } from './joint.ts';

const asNumber = (v: number | string, what: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} needs a number, got ${v}`);
  return n;
};
const asIso = (v: number | string, what: string): string => {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`${what} needs a time, got ${v}`);
  return new Date(ms).toISOString();
};

/**
 * Applies accepted concessions to copies of the world and intent; inputs are never mutated.
 * Accepted terms may include a supplier's own counter on any field. 'joint' concessions that share a
 * target form one joint offer (shared contracts composition) once every member has agreed.
 */
export function applyConcessions(world: World, intent: Intent, concessions: Concession[]): { world: World; intent: Intent } {
  const next: World = structuredClone(world);
  const nextIntent: Intent = structuredClone(intent);
  const touched = new Map<string, { offer: Offer; ids: string[]; coalition?: string }>();
  for (const c of concessions) {
    if (c.target.kind === 'intent') {
      if (c.target.field === 'deadline') {
        const to = asIso(c.to, 'deadline');
        const extra = (Date.parse(to) - Date.parse(intent.deadline)) / 3_600_000;
        if (extra > (intent.negotiable.deadlineHours ?? 0) + 1e-9) throw new Error(`concession ${c.id} moves the deadline ${extra} hours, beyond what the buyer allowed`);
        nextIntent.deadline = to;
      } else {
        const to = Math.round(asNumber(c.to, 'budget'));
        if (to - intent.budget.minor > (intent.negotiable.budgetMinor ?? 0)) throw new Error(`concession ${c.id} raises the budget beyond what the buyer allowed`);
        nextIntent.budget = { ...nextIntent.budget, minor: to };
      }
      continue;
    }
    const target = c.target;
    const o = next.offers.find((x) => x.id === target.offer);
    if (!o) throw new Error(`concession ${c.id} targets unknown offer ${target.offer}`);
    const entry = touched.get(o.id) ?? { offer: o, ids: [] };
    entry.ids.push(c.id);
    switch (target.field) {
      case 'capacity':
        o.capacity = Math.round(asNumber(c.to, 'capacity'));
        break;
      case 'minQty':
        o.minQty = Math.max(0, Math.round(asNumber(c.to, 'minQty')));
        break;
      case 'setupFee':
        o.setupFee = { ...o.setupFee, minor: Math.max(0, Math.round(asNumber(c.to, 'setupFee'))) };
        break;
      case 'unitPrice': {
        // The supplier agreed to one unit price; every quantity is sold at exactly that price.
        const agreed = Math.max(0, Math.round(asNumber(c.to, 'unitPrice')));
        const currency = o.tiers[0]?.unit.currency ?? o.setupFee.currency;
        o.tiers = [{ minQty: 0, unit: { currency, minor: agreed } }];
        break;
      }
      case 'windowStart':
        o.window = { ...o.window, start: asIso(c.to, 'windowStart') };
        break;
      case 'windowEnd':
        o.window = { ...o.window, end: asIso(c.to, 'windowEnd') };
        break;
      case 'joint':
        if (!o.negotiable.includes('joint')) throw new Error(`concession ${c.id}: ${o.id} is not open to joint work`);
        entry.coalition = String(c.to);
        break;
    }
    touched.set(o.id, entry);
  }
  for (const { offer, ids, coalition } of touched.values()) {
    offer.version += 1;
    const linked = coalition ?? offer.derivedFrom?.coalition;
    offer.derivedFrom = { concessions: [...(offer.derivedFrom?.concessions ?? []), ...ids], ...(linked ? { coalition: linked } : {}) };
  }

  const groups = new Map<string, { members: string[]; ids: string[] }>();
  for (const c of concessions) {
    if (c.target.kind !== 'offer' || c.target.field !== 'joint') continue;
    const key = String(c.to);
    const g = groups.get(key) ?? { members: [], ids: [] };
    if (!g.members.includes(c.target.offer)) g.members.push(c.target.offer);
    g.ids.push(c.id);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const shape = parseCoalition(key);
    const members = shape ? shape.members : g.members;
    if (members.length < 2 || !members.every((m) => g.members.includes(m))) continue;
    const offers = members.map((m) => next.offers.find((o) => o.id === m)!);
    const joint = composeJoint(offers, key, next.createdAt);
    if (next.offers.some((o) => o.id === joint.id)) continue;
    const memberIds = new Set(members);
    const ids = concessions.filter((c) => c.target.kind === 'offer' && memberIds.has(c.target.offer)).map((c) => c.id);
    next.offers.push({ ...joint, derivedFrom: { concessions: ids, coalition: key } });
  }
  next.version = world.version + 1;
  return { world: next, intent: nextIntent };
}
