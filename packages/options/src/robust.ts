import type { Agreement, Disruption, Intent, Iso, Money, World } from '@framvera/contracts';
import { LIVE_OBLIGATION, impactOf } from '@framvera/obligations';
import { solve } from '@framvera/solver';
import { exerciseOption } from './exercise.ts';
import { feesPaid } from './discover.ts';
import { fmtTime, spendable } from './standby.ts';
import type { Disturbance, Robustness, StandbyOption } from './types.ts';
import { downstream, iso, ms, toAllocation } from './util.ts';

export interface RobustOptions {
  at?: Iso;
  /** Disturbances to check. Defaults to the single-failure family described in the result. */
  family?: Disruption[];
  delayHours?: number;
  capacityShare?: number;
  /** Also ask the solver whether a full re-plan from published offers could still meet the deadline. */
  recoverable?: boolean;
  feesPaid?: Money;
  timeLimitMs?: number;
}

/** Every committed obligation in turn withdraws, loses capacity, or runs late, discovered when its work should start. */
export function singleFailureFamily(agreement: Agreement, opts: { at?: Iso; delayHours?: number; capacityShare?: number } = {}): Disruption[] {
  const now = ms(opts.at ?? agreement.createdAt);
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const share = opts.capacityShare ?? 0.5;
  const delay = opts.delayHours ?? 12;
  const out: Disruption[] = [];
  const actors = new Set<string>();
  for (const o of live) {
    const at = iso(Math.max(now, ms(o.start)));
    const others = live.filter((x) => x.offer === o.offer && x.id !== o.id).reduce((s, x) => s + x.qty, 0);
    if (!actors.has(o.actor)) {
      actors.add(o.actor);
      out.push({ id: `family-withdraw-${o.id}`, kind: 'withdraw', actor: o.actor, detail: 'Supplier withdraws after accepting.', at });
    }
    const capacity = others + Math.floor(share * o.qty);
    out.push({ id: `family-capacity-${o.id}`, kind: 'capacity-drop', offer: o.offer, detail: `Capacity falls to ${capacity}.`, at, params: { capacity } } as Disruption);
    out.push({ id: `family-delay-${o.id}`, kind: 'delay', offer: o.offer, detail: `Output delayed ${delay} hours.`, at, params: { delayHours: delay } } as Disruption);
  }
  return out;
}

/**
 * robust_feasible: for every disturbance in the family, the committed plan either stays valid unchanged or becomes
 * valid again by exercising purchased options alone, each case checked by the independent verifier. Spare capacity
 * nobody has reserved is not counted on.
 */
export async function robustness(world: World, intent: Intent, agreement: Agreement, options: readonly StandbyOption[], opts: RobustOptions = {}): Promise<Robustness> {
  const family = opts.family ?? singleFailureFamily(agreement, opts);
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const held = options.filter((o) => o.status === 'purchased');
  const spent = opts.feesPaid?.minor ?? feesPaid(options);
  const disturbances: Disturbance[] = [];
  for (const d of family) {
    const ex = exerciseOption(agreement, world, intent, d, held, opts.feesPaid ? { feesPaid: opts.feesPaid } : {});
    const target = live.find((o) => (d.offer ? o.offer === d.offer : o.actor === d.actor))?.id ?? '';
    const outcome = ex.absorbed ? 'absorbed' : ex.exercised ? 'option' : 'uncovered';
    const option = ex.notices[0]?.type === 'ExerciseStandby' ? ex.notices[0].option : undefined;
    let recoverable: boolean | undefined;
    if (opts.recoverable !== false && outcome !== 'absorbed') recoverable = await replannable(world, intent, agreement, d, spent, opts.timeLimitMs);
    const when = fmtTime(ms(d.at));
    const text =
      outcome === 'absorbed'
        ? `${d.detail} (${when}): the plan holds without changes.`
        : outcome === 'option'
          ? `${d.detail} (${when}): exercising ${option} keeps every other obligation and the deadline.`
          : `${d.detail} (${when}): no purchased option covers it${recoverable === undefined ? '' : recoverable ? '; a full re-plan could still meet the deadline if published offers remain open' : '; no re-plan meets the deadline'}.`;
    disturbances.push({ disruption: d, obligation: target, outcome, ...(option ? { option } : {}), ...(recoverable === undefined ? {} : { recoverable }), text });
  }
  const covered = disturbances.filter((x) => x.outcome !== 'uncovered').length;
  return {
    robustFeasible: covered === disturbances.length,
    robustWithoutOptions: disturbances.every((x) => x.outcome === 'absorbed'),
    family: opts.family
      ? `${family.length} given disturbances.`
      : `Each committed obligation in turn withdraws, falls to ${Math.round((opts.capacityShare ?? 0.5) * 100)}% capacity, or runs ${opts.delayHours ?? 12} hours late, discovered when its work should start.`,
    covered,
    total: disturbances.length,
    disturbances,
  };
}

async function replannable(world: World, intent: Intent, agreement: Agreement, d: Disruption, spent: number, timeLimitMs = 3000): Promise<boolean> {
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const at = ms(d.at);
  const impact = impactOf(agreement, world, d, { notBefore: at });
  const failed = new Set(impact.failed.map((o) => o.id));
  const release = new Set<string>();
  for (const o of [...impact.failed, ...impact.mustChange]) {
    release.add(o.stage);
    for (const s of downstream(impact.world, o.stage)) release.add(s);
  }
  const kept = live.filter((o) => !failed.has(o.id)).map(toAllocation);
  const checkIntent = spendable(intent, spent, at);
  for (const fixed of [kept, kept.filter((a) => !release.has(a.stage))]) {
    const r = await solve(impact.world, checkIntent, { fixed, explain: false, timeLimitMs });
    if (r.status === 'optimal' || r.status === 'feasible') return true;
  }
  return false;
}
