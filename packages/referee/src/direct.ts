import type { Allocation, Intent, Offer, Plan, Stage, World } from '@framvera/contracts';

const H = 3_600_000;

function unitAt(o: Offer, qty: number): number {
  let u = o.tiers[0]?.unit.minor ?? 0;
  for (const t of o.tiers) if (qty >= t.minQty) u = t.unit.minor;
  return u;
}

function topo(stages: Stage[]): Stage[] {
  const done = new Set<string>();
  const out: Stage[] = [];
  while (out.length < stages.length) {
    const next = stages.find((s) => !done.has(s.id) && s.after.every((a) => done.has(a)));
    if (!next) return out;
    done.add(next.id);
    out.push(next);
  }
  return out;
}

/**
 * Direct procurement: for each stage take the cheapest published offers, filling
 * capacity in price order, scheduled as early as each window allows. No optimisation
 * over timing or cost trade-offs, no negotiation. Returns null when a stage cannot be sourced.
 */
export function buildDirectPlan(world: World, intent: Intent): Plan | null {
  const finish = new Map<string, number>();
  const allocations: Allocation[] = [];
  const now = Date.parse(world.createdAt);
  const actors = new Map(world.actors.map((a) => [a.id, a]));
  for (const stage of topo(world.stages)) {
    const need = Math.ceil(intent.quantity * stage.perOutcome);
    const ready = Math.max(0, ...stage.after.map((a) => finish.get(a) ?? 0));
    const pool = world.offers
      .filter((o) => o.stage === stage.id && actors.get(o.actor)?.active !== false && Date.parse(o.validUntil) >= now)
      .sort((a, b) => unitAt(a, need) - unitAt(b, need) || a.id.localeCompare(b.id));
    let left = need;
    let stageFinish = 0;
    for (const o of pool) {
      if (left <= 0) break;
      const qty = Math.min(left, o.capacity);
      if (qty < o.minQty || qty <= 0) continue;
      const start = Math.max(Date.parse(o.window.start), ready);
      const workEnd = start + (qty / o.ratePerHour) * H;
      if (workEnd > Date.parse(o.window.end)) continue;
      const fin = workEnd + o.handoffHours * H;
      const cost = o.setupFee.minor + unitAt(o, qty) * qty;
      allocations.push({
        offer: o.id, actor: o.actor, stage: stage.id, qty,
        start: new Date(start).toISOString(), finish: new Date(fin).toISOString(),
        cost: { currency: world.currency, minor: cost },
      });
      stageFinish = Math.max(stageFinish, fin);
      left -= qty;
    }
    if (left > 0) return null;
    finish.set(stage.id, stageFinish);
  }
  const total = allocations.reduce((a, x) => a + x.cost.minor, 0);
  const readyAt = new Date(Math.max(...allocations.map((a) => Date.parse(a.finish)))).toISOString();
  return {
    id: `direct:${world.id}`, worldVersion: world.version, intent: intent.id, allocations,
    total: { currency: world.currency, minor: total }, readyAt, objective: 'cheapest published offers per stage',
  };
}

/** The buyer's own check before acting: deadline and budget by plain arithmetic. */
export function directLooksFeasible(plan: Plan, intent: Intent): boolean {
  return Date.parse(plan.readyAt) <= Date.parse(intent.deadline) && plan.total.minor <= intent.budget.minor;
}
