import type { Concession, Intent, World } from '@framvera/contracts';
import { addHours, composeJoint, money } from '@framvera/contracts';
import type { Certificate } from './truth.ts';

/**
 * Apply a certificate's concessions and coalitions to copies of the world and intent.
 * Coalition member offers are consumed by the joint offer and removed.
 */
export function applyCertificate(world: World, intent: Intent, cert: Pick<Certificate, 'concessions' | 'coalitions'>): { world: World; intent: Intent } {
  const w = structuredClone(world);
  const i = structuredClone(intent);
  for (const c of cert.concessions) applyConcession(w, i, c);
  for (const coal of cert.coalitions) {
    const members = coal.offers.map((id) => {
      const o = w.offers.find((x) => x.id === id);
      if (!o) throw new Error(`Coalition ${coal.id}: unknown offer ${id}`);
      return o;
    });
    const joint = composeJoint(members, coal.id, w.createdAt);
    joint.derivedFrom = { concessions: cert.concessions.filter((c) => c.target.kind === 'offer' && coal.offers.includes(c.target.offer)).map((c) => c.id), coalition: coal.id };
    w.offers = w.offers.filter((o) => !coal.offers.includes(o.id)).concat(joint);
  }
  w.version += 1;
  return { world: w, intent: i };
}

function applyConcession(w: World, intent: Intent, c: Concession): void {
  if (c.target.kind === 'intent') {
    if (c.target.field === 'deadline') intent.deadline = String(c.to);
    else intent.budget = money(intent.budget.currency, Number(c.to));
    return;
  }
  const target = c.target;
  if (target.field === 'joint') return;
  const o = w.offers.find((x) => x.id === target.offer);
  if (!o) throw new Error(`Concession ${c.id}: unknown offer ${target.offer}`);
  switch (target.field) {
    case 'windowEnd':
      o.window = { ...o.window, end: String(c.to) };
      break;
    case 'windowStart':
      o.window = { ...o.window, start: String(c.to) };
      break;
    case 'setupFee':
      o.setupFee = money(o.setupFee.currency, Number(c.to));
      break;
    case 'unitPrice': {
      const ratio = Number(c.to) / Number(c.from);
      o.tiers = o.tiers.map((t) => ({ minQty: t.minQty, unit: money(t.unit.currency, Math.round(t.unit.minor * ratio)) }));
      break;
    }
    case 'capacity':
      o.capacity = Number(c.to);
      break;
    case 'minQty':
      o.minQty = Number(c.to);
      break;
  }
  o.version += 1;
  o.derivedFrom = { concessions: [...(o.derivedFrom?.concessions ?? []), c.id], coalition: o.derivedFrom?.coalition };
}

/** Shift an offer's window end by hours, returning the concession that does it. */
export function extendWindow(world: World, offerId: string, hours: number, id = `c-extend-${offerId}`): Concession {
  const o = world.offers.find((x) => x.id === offerId);
  if (!o) throw new Error(`Unknown offer ${offerId}`);
  return {
    id,
    target: { kind: 'offer', offer: offerId, field: 'windowEnd' },
    from: o.window.end,
    to: addHours(o.window.end, hours),
    estimate: money(world.currency, 0),
    rationale: `Extend the window by ${hours} hours.`,
  };
}
