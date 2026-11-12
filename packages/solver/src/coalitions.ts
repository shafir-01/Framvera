import type { Coalition, Intent, Money, Plan, World } from '@framvera/contracts';
import { isUsable } from '@framvera/contracts';
import { stageDemand } from './compile.ts';
import { solve } from './solve.ts';
import { applyCoalition, deriveOffer, describeCoalition, sharedId } from './joint.ts';

/**
 * Candidate joint offers among suppliers that publicly accept joint work: one member's larger
 * capacity run in the window of a member available later. Each candidate supplies something neither
 * member can alone, more units inside the later window.
 */
export function synthesizeCoalitions(world: World, intent: Intent): Coalition[] {
  const out: Coalition[] = [];
  for (const stage of world.stages) {
    const demand = stageDemand(stage, intent);
    if (demand <= 0) continue;
    const joint = world.offers.filter(
      (o) => o.stage === stage.id && !o.id.startsWith('joint:') && o.negotiable.includes('joint') && isUsable(world, o) && o.ratePerHour > 0 && o.tiers.length > 0,
    );
    for (let i = 0; i < joint.length; i++) {
      for (let k = i + 1; k < joint.length; k++) {
        const a = joint[i]!;
        const b = joint[k]!;
        if (a.actor === b.actor) continue;
        const id = sharedId(a, b);
        if (!id || world.offers.some((o) => o.id === id)) continue;
        const derived = deriveOffer(world, id);
        if (!derived) continue;
        const c = describeCoalition(world, id, Math.max(derived.minQty, Math.min(demand, derived.capacity)));
        if (c) out.push(c);
      }
    }
  }
  return out;
}

export interface CoalitionEvaluation {
  coalition: Coalition;
  /** The request has no plan without the coalition and has one with it. */
  unlocks: boolean;
  /** Saving against the best plan without the coalition, when both exist. */
  saves?: Money;
  plan: Plan;
}

/** Solves with each candidate added and keeps those the cheapest plan actually uses. */
export async function evaluateCoalitions(world: World, intent: Intent, candidates?: Coalition[]): Promise<CoalitionEvaluation[]> {
  const list = candidates ?? synthesizeCoalitions(world, intent);
  const base = await solve(world, intent, { explain: false });
  const out: CoalitionEvaluation[] = [];
  for (const cand of list) {
    let next: World;
    try {
      next = applyCoalition(world, cand);
    } catch {
      continue;
    }
    const r = await solve(next, intent, { explain: false });
    const used = r.plan?.allocations.find((a) => a.offer === cand.id);
    if (!r.plan || !used) continue;
    const coalition = describeCoalition(next, cand.id, used.qty, base.plan)!;
    if (!base.plan) out.push({ coalition, unlocks: true, plan: r.plan });
    else if (r.plan.total.minor < base.plan.total.minor) {
      out.push({ coalition, unlocks: false, saves: { currency: r.plan.total.currency, minor: base.plan.total.minor - r.plan.total.minor }, plan: r.plan });
    }
  }
  return out;
}
