import type { Concession, Intent, Money, NegotiableField, Offer, World } from '@framvera/contracts';
import { addHours, money } from '@framvera/contracts';
import { applyCertificate } from './certificate.ts';
import { checkFeasibility, type CheckOptions } from './feasibility.ts';
import type { CoalitionCertificate } from './truth.ts';

/** How far a single published negotiable field may plausibly move. */
export interface Bounds {
  windowHours: number;
  unitPricePct: number;
  setupFeePct: number;
  capacityPct: number;
  maxJointMembers: number;
}

export const PLAUSIBLE_BOUNDS: Bounds = { windowHours: 6, unitPricePct: 25, setupFeePct: 50, capacityPct: 25, maxJointMembers: 3 };

/** One publicly negotiable change, taken to the edge of the bounds. */
export interface Change {
  id: string;
  concessions: Concession[];
  coalitions: CoalitionCertificate[];
  /** Offers this change touches; two changes touching the same offer are not combined. */
  offers: string[];
}

export interface UnlockingSet {
  changes: string[];
  total: Money;
}

function concession(o: Offer, field: Exclude<NegotiableField, 'joint'>, from: number | string, to: number | string, currency: World['currency']): Concession {
  return { id: `x-${field}-${o.id}`, target: { kind: 'offer', offer: o.id, field }, from, to, estimate: money(currency, 0), rationale: `Move ${field} of ${o.id} to the edge of the plausible range.` };
}

/** Every single change the published negotiable fields allow, at the edge of the bounds. */
export function candidateChanges(world: World, bounds: Bounds = PLAUSIBLE_BOUNDS): Change[] {
  const out: Change[] = [];
  const cur = world.currency;
  for (const o of world.offers) {
    for (const f of o.negotiable) {
      let c: Concession | null = null;
      if (f === 'windowEnd') c = concession(o, f, o.window.end, addHours(o.window.end, bounds.windowHours), cur);
      if (f === 'windowStart') c = concession(o, f, o.window.start, addHours(o.window.start, -bounds.windowHours), cur);
      if (f === 'unitPrice') {
        const top = o.tiers[o.tiers.length - 1]!.unit.minor;
        c = concession(o, f, top, Math.floor((top * (100 - bounds.unitPricePct)) / 100), cur);
      }
      if (f === 'setupFee') c = concession(o, f, o.setupFee.minor, Math.floor((o.setupFee.minor * (100 - bounds.setupFeePct)) / 100), cur);
      if (f === 'capacity') c = concession(o, f, o.capacity, Math.floor((o.capacity * (100 + bounds.capacityPct)) / 100), cur);
      if (f === 'minQty') c = concession(o, f, o.minQty, 0, cur);
      if (c) out.push({ id: c.id, concessions: [c], coalitions: [], offers: [o.id] });
    }
  }
  const byStage = new Map<string, Offer[]>();
  for (const o of world.offers) if (o.negotiable.includes('joint')) byStage.set(o.stage, [...(byStage.get(o.stage) ?? []), o]);
  for (const group of byStage.values()) {
    const subsets = (start: number, picked: Offer[]): void => {
      if (picked.length >= 2) {
        const ids = picked.map((p) => p.id);
        out.push({
          id: `x-joint-${ids.join('+')}`,
          concessions: [],
          coalitions: [{ id: `coal-${ids.join('+')}`, members: picked.map((p) => p.actor), offers: ids }],
          offers: ids,
        });
      }
      if (picked.length >= bounds.maxJointMembers) return;
      for (let i = start; i < group.length; i++) {
        const o = group[i]!;
        if (!picked.some((p) => p.actor === o.actor)) subsets(i + 1, [...picked, o]);
      }
    };
    subsets(0, []);
  }
  return out;
}

/**
 * Exhaustive search over combinations of up to maxChanges candidate changes.
 * Returns every combination that the checker proves feasible, cheapest first,
 * plus the number of combinations it proved infeasible or could not decide.
 */
export function exhaustiveInterventions(world: World, intent: Intent, opts: { maxChanges?: number; bounds?: Bounds; check?: CheckOptions } = {}) {
  const changes = candidateChanges(world, opts.bounds);
  const max = opts.maxChanges ?? 2;
  const unlocking: UnlockingSet[] = [];
  let infeasible = 0;
  const undetermined: string[][] = [];
  const walk = (start: number, picked: Change[]): void => {
    if (picked.length > 0) {
      if (unlocking.some((u) => u.changes.every((id) => picked.some((p) => p.id === id)))) return;
      const applied = applyCertificate(world, intent, {
        concessions: picked.flatMap((p) => p.concessions),
        coalitions: picked.flatMap((p) => p.coalitions),
      });
      const r = checkFeasibility(applied.world, applied.intent, opts.check);
      if (r.status === 'feasible') {
        unlocking.push({ changes: picked.map((p) => p.id), total: r.plan!.total });
        return;
      }
      if (r.status === 'infeasible') infeasible++;
      else undetermined.push(picked.map((p) => p.id));
    }
    if (picked.length >= max) return;
    for (let i = start; i < changes.length; i++) {
      const c = changes[i]!;
      if (picked.some((p) => p.offers.some((o) => c.offers.includes(o)))) continue;
      walk(i + 1, [...picked, c]);
    }
  };
  walk(0, []);
  unlocking.sort((a, b) => a.changes.length - b.changes.length || a.total.minor - b.total.minor);
  return { candidates: changes.map((c) => c.id), unlocking, infeasible, undetermined };
}
