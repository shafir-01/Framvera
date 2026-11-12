import type { Disruption, Intent, Plan, World } from '@framvera/contracts';
import type { Deps, Family, HiddenTruthLike, Outcome, RunRecord } from './types.ts';

export interface Judgement {
  falseReasons: string[];
  invariantViolations: string[];
  trulyFeasible: boolean;
}

/**
 * Independent judgement of a claim. The verifier is pure arithmetic over the final world;
 * real capacities come from hidden truth. Any success claimed in the impossible family is false by definition.
 */
export function judge(deps: Deps, o: Outcome, truth: HiddenTruthLike, family: Family): Judgement {
  const falseReasons: string[] = [];
  const invariantViolations: string[] = [];
  if (!o.claimed) return { falseReasons, invariantViolations, trulyFeasible: false };
  if (!o.plan) {
    falseReasons.push('claim without plan');
  } else {
    checkPlan(deps, o.plan, o.world, o.intent, falseReasons, invariantViolations);
    for (const a of o.plan.allocations) {
      const real = truth.realCapacity[a.offer];
      if (real !== undefined && a.qty > real) falseReasons.push(`real capacity exceeded on ${a.offer}`);
    }
  }
  if (family === 'impossible') falseReasons.push('success claimed in an impossible market');
  return { falseReasons, invariantViolations, trulyFeasible: falseReasons.length === 0 };
}

function checkPlan(deps: Deps, plan: Plan, world: World, intent: Intent, reasons: string[], inv: string[]): void {
  const v = deps.solver.verifyPlan(plan, world, intent);
  if (!v.ok) {
    const failed = v.checks.filter((c) => !c.ok).map((c) => c.id).join(',');
    reasons.push(`verifier rejected: ${failed || 'unspecified'}`);
    inv.push(`verifier: ${failed || 'unspecified'}`);
  }
  if (plan.total.minor > intent.budget.minor) {
    reasons.push('budget exceeded');
    inv.push('budget exceeded');
  }
  const used = new Map<string, number>();
  for (const a of plan.allocations) used.set(a.offer, (used.get(a.offer) ?? 0) + a.qty);
  for (const [id, qty] of used) {
    const cap = world.offers.find((o) => o.id === id)?.capacity;
    if (cap !== undefined && qty > cap) inv.push(`capacity oversubscribed on ${id}`);
  }
}

export interface RecoveryResult { attempted: boolean; success: boolean; affected: number; note?: string; invariants: string[] }

/** Applies the first withheld shock that actually hits the plan, then asks for a minimal-change recovery. */
export async function tryRecovery(deps: Deps, o: Outcome, truth: HiddenTruthLike): Promise<RecoveryResult> {
  const none: RecoveryResult = { attempted: false, success: false, affected: 0, invariants: [] };
  if (!o.plan) return none;
  const draft = deps.obligations.commit(o.plan, o.intent, []);
  const signed = draft.parties.map((actor) => ({
    actor, message: `sign-${actor}`, termsHash: draft.termsHash, basis: actor === 'buyer' ? 'buyer' : 'synthetic-policy',
  }));
  const agreement = deps.obligations.commit(o.plan, o.intent, signed as never);
  let hit: { d: Disruption; world: World; affected: string[] } | null = null;
  for (const d of truth.shocks) {
    const r = deps.obligations.disrupt(agreement, o.world, d);
    if (r.affected.length > 0) { hit = { d, world: r.world, affected: r.affected.map((x) => x.id) }; break; }
  }
  if (!hit) return { ...none, note: 'no withheld shock touched the plan' };
  const rec = await deps.obligations.recover(agreement, hit.world, o.intent, hit.d);
  const invariants: string[] = [];
  const touched = new Set(hit.affected);
  for (const id of [...rec.amended, ...rec.cancelled]) {
    if (!touched.has(id)) invariants.push(`recovery changed unaffected obligation ${id}`);
  }
  for (const k of rec.kept) if (touched.has(k)) invariants.push(`affected obligation ${k} reported as kept`);
  return { attempted: true, success: rec.feasible, affected: hit.affected.length, invariants };
}

export function emptyRecord(base: Pick<RunRecord, 'seed' | 'family' | 'strategy' | 'initialStatus'>): RunRecord {
  return {
    ...base, claimed: false, trulyFeasible: false, falseClaim: false, falseReasons: [], invariantViolations: [],
    questions: 0, accepted: 0, costMinor: null, oracleCostMinor: null, recovery: null, solveMs: 0, wallMs: 0,
    hindsight: base.strategy === 'oracle', notes: [],
  };
}
