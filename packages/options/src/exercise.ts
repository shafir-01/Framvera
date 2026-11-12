import { money } from '@framvera/contracts';
import type { Agreement, Allocation, Disruption, Id, Intent, Iso, Money, Recovery, World } from '@framvera/contracts';
import { BINDING, BUYER, LIVE_OBLIGATION, amend, impactOf } from '@framvera/obligations';
import { feesPaid } from './discover.ts';
import { absorbsLate, planExercise } from './standby.ts';
import type { Exercise, StandbyMessage, StandbyOption } from './types.ts';
import { HOUR, iso, ms, terminalStages, toAllocation } from './util.ts';

export interface ExerciseOptions {
  /** When the buyer sends the exercise notice; never earlier than the disruption. */
  at?: Iso;
  /** Option fees already paid, which reduce the budget left for the plan. Defaults to the fees of purchased options. */
  feesPaid?: Money;
  reservedElsewhere?: Map<Id, number>;
  buyer?: Id;
}

function readyOf(world: World, allocations: Allocation[]): number {
  const terminals = terminalStages(world);
  return Math.max(-Infinity, ...allocations.filter((a) => terminals.has(a.stage)).map((a) => ms(a.finish)));
}

/**
 * First response to a disruption: exercise purchased standby options when that alone keeps every other obligation
 * unchanged and the deadline and budget intact. The result replaces one obligation per exercised option. When it
 * returns exercised: false, the caller runs the full recovery.
 */
export function exerciseOption(
  agreement: Agreement,
  world: World,
  intent: Intent,
  d: Disruption,
  options: readonly StandbyOption[],
  opts: ExerciseOptions = {},
): Exercise {
  const at = Math.max(ms(d.at), opts.at ? ms(opts.at) : -Infinity);
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const impact = impactOf(agreement, world, d, { notBefore: at, ...(opts.reservedElsewhere ? { reservedElsewhere: opts.reservedElsewhere } : {}) });
  const failedIds = new Set(impact.failed.map((o) => o.id));
  const failed = live.filter((o) => failedIds.has(o.id));
  const kept = live.filter((o) => !failedIds.has(o.id)).map(toAllocation);
  const none = (reason: string, absorbed = false, extra: Partial<Exercise> = {}): Exercise => ({
    exercised: false,
    absorbed,
    reason,
    replacements: [],
    notices: [],
    options: [...options],
    world: impact.world,
    attempts: [],
    ...extra,
  });
  if (!failed.length) return none('No obligation failed; nothing to exercise.', true);
  if (d.kind === 'delay' && absorbsLate(impact.world, intent, at, kept, failed)) return none('The delay is absorbed by slack; only the due time moves.', true);
  const held = options.filter((o) => o.status === 'purchased' && o.agreement.state === 'COMMITTED');
  if (!held.length) return none('No purchased option to exercise.');
  const fees = opts.feesPaid?.minor ?? feesPaid(options);
  const ex = planExercise({ world: impact.world, intent, at, kept, failed, options: held, spentMinor: fees });
  if (!ex.ok || !ex.plan) {
    return none('No purchased option keeps every other obligation and the deadline; run the full recovery.', false, {
      attempts: ex.attempts,
      ...(ex.verification ? { verification: ex.verification } : {}),
    });
  }

  const buyer = opts.buyer ?? held[0]?.terms.buyer ?? BUYER;
  const byId = new Map(options.map((o) => [o.id, o]));
  const notices: StandbyMessage[] = ex.picks.map((p) => ({
    type: 'ExerciseStandby',
    id: `${p.option}:exercise:${d.id}`,
    from: buyer,
    to: p.terms.supplier,
    option: p.option,
    termsHash: byId.get(p.option)!.termsHash,
    qty: p.allocation.qty,
    replaces: p.obligation.id,
    at: iso(at),
  }));
  const replacements = ex.picks.map((p) => ({ replaces: p.obligation.id, allocation: p.allocation }));
  const keptIds = live.filter((o) => !failedIds.has(o.id)).map((o) => o.id);
  const amendment = BINDING.includes(agreement.state)
    ? amend(
        agreement,
        {
          keep: keptIds,
          replace: replacements.map((r) => ({
            replaces: r.replaces,
            obligation: { actor: r.allocation.actor, offer: r.allocation.offer, stage: r.allocation.stage, qty: r.allocation.qty, start: r.allocation.start, due: r.allocation.finish, amount: r.allocation.cost },
          })),
          add: [],
        },
        buyer,
      )
    : undefined;
  const currency = intent.budget.currency;
  const extra = ex.picks.reduce((s, p) => s + p.allocation.cost.minor - p.obligation.amount.minor, 0);
  const before = readyOf(world, live.map(toAllocation));
  const after = ms(ex.plan.readyAt);
  const recovery: Recovery = {
    id: `rec:${d.id}:${agreement.id}:v${agreement.version}:standby`,
    disruption: d.id,
    feasible: true,
    kept: keptIds,
    amended: ex.picks.map((p) => p.obligation.id),
    cancelled: [],
    added: [],
    extraCost: money(currency, extra),
    slipHours: Number.isFinite(before) ? Math.max(0, Math.round(((after - before) / HOUR) * 100) / 100) : 0,
    rejected: ex.attempts.filter((a) => !a.ok).map((a) => ({ description: `Exercise ${a.option} for ${a.obligation}`, reason: a.reason })),
  };
  const notice = new Map(ex.picks.map((p, k) => [p.option, notices[k]!]));
  const updated = options.map((o) => {
    const n = notice.get(o.id);
    if (!n) return o;
    return {
      ...o,
      status: 'exercised' as const,
      messages: [...o.messages, n],
      agreement: { ...o.agreement, state: 'SETTLED' as const, obligations: o.agreement.obligations.map((h) => ({ ...h, state: 'FULFILLED' as const })) },
    };
  });
  return {
    exercised: true,
    absorbed: false,
    reason: `Exercised ${ex.picks.length === 1 ? 'one standby option' : `${ex.picks.length} standby options`}; every other obligation stays as agreed.`,
    recovery,
    replacements,
    ...(amendment ? { amendment } : {}),
    notices,
    options: updated,
    world: ex.world,
    plan: ex.plan,
    ...(ex.verification ? { verification: ex.verification } : {}),
    attempts: ex.attempts,
  };
}
