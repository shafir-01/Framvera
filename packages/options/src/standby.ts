import { hashTerms, money } from '@framvera/contracts';
import type { Allocation, Id, Intent, Iso, Obligation, Offer, Plan, World } from '@framvera/contracts';
import { verifyPlan } from '@framvera/solver';
import type { ExerciseAttempt, ExercisePlan, OptionLike, StandbyTerms } from './types.ts';
import { HOUR, TOLERANCE_MS, iso, ms, stageIndex, terminalStages, workMs } from './util.ts';

export const standbyOfferId = (option: Id): Id => `standby:${option}`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export function exerciseCostMinor(t: Pick<StandbyTerms, 'strikeUnit' | 'setupFee' | 'qty'>, qty = t.qty): number {
  return t.strikeUnit.minor * qty + t.setupFee.minor;
}

/** The held capacity as an offer at the strike price, valid until the option expires. */
export function standbyOffer(t: StandbyTerms, base: Offer | undefined, observedAt: Iso, fromTerminal = false): Offer {
  return {
    id: standbyOfferId(t.option),
    version: 1,
    actor: t.supplier,
    stage: t.stage,
    capacity: t.qty,
    minQty: t.minExercise,
    ratePerHour: t.ratePerHour,
    setupFee: t.setupFee,
    tiers: [{ minQty: 0, unit: t.strikeUnit }],
    window: t.window,
    handoffHours: t.handoffHours,
    validUntil: t.expires,
    negotiable: [],
    provenance: { source: fromTerminal ? 'seller-terminal' : 'synthetic-market', observedAt, ref: t.option },
    claims: base?.claims ?? [],
    derivedFrom: { concessions: [t.option] },
  };
}

/** Adds each option's held capacity as its own offer and removes the same units from the supplier's open offer. */
export function withStandby(world: World, options: readonly OptionLike[], observedAt: Iso): World {
  if (!options.length) return world;
  const held = new Map<Id, number>();
  for (const o of options) held.set(o.terms.offer, (held.get(o.terms.offer) ?? 0) + o.terms.qty);
  const present = new Set(world.offers.map((o) => o.id));
  const offers = world.offers.map((o) => (held.has(o.id) ? { ...o, capacity: Math.max(0, o.capacity - held.get(o.id)!) } : o));
  const extra = options
    .filter((o) => !present.has(standbyOfferId(o.id)))
    .map((o) => standbyOffer(o.terms, world.offers.find((x) => x.id === o.terms.offer), observedAt, o.basis === 'seller-terminal'));
  return { ...world, version: world.version + 1, offers: [...offers, ...extra] };
}

export function planOf(world: World, intent: Intent, allocations: Allocation[], objective: string): Plan {
  const terminals = terminalStages(world);
  const finals = allocations.filter((a) => terminals.has(a.stage));
  const ready = Math.max(...(finals.length ? finals : allocations).map((a) => ms(a.finish)));
  const total = allocations.reduce((s, a) => s + a.cost.minor, 0);
  const body = allocations.map((a) => `${a.offer}:${a.qty}:${a.start}`).join('|');
  return {
    id: `plan-${hashTerms({ w: world.id, v: world.version, i: intent.id, body }).slice(0, 12)}`,
    worldVersion: world.version,
    intent: intent.id,
    allocations,
    total: money(intent.budget.currency, total),
    readyAt: Number.isFinite(ready) ? iso(ready) : intent.deadline,
    objective,
  };
}

/** Keeps late obligations with their delayed output and checks whether the rest of the plan still holds. */
export function absorbsLate(world: World, intent: Intent, at: number, kept: Allocation[], late: Obligation[]): boolean {
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const all = [...kept];
  for (const o of late) {
    const offer = offers.get(o.offer);
    if (!offer) return false;
    const finish = Math.max(ms(o.due), ms(o.start) + workMs(offer.ratePerHour, o.qty) + Math.round(offer.handoffHours * HOUR));
    all.push({ offer: o.offer, actor: o.actor, stage: o.stage, qty: o.qty, start: o.start, finish: iso(finish), cost: o.amount });
  }
  const plan = planOf(world, intent, all, 'Keep every obligation; accept the late output.');
  return verifyPlan(plan, world, { ...intent, provenance: { ...intent.provenance, observedAt: iso(at) } }, { fixed: all }).ok;
}

/** The request as seen at a later moment, with money already spent outside the plan taken off budget and authority. */
export function spendable(intent: Intent, spentMinor: number, at: number): Intent {
  const auth = intent.authority.maxSpend;
  return {
    ...intent,
    budget: money(intent.budget.currency, intent.budget.minor - spentMinor),
    authority: { ...intent.authority, maxSpend: auth.currency === intent.budget.currency ? money(auth.currency, auth.minor - spentMinor) : auth },
    provenance: { ...intent.provenance, observedAt: iso(at) },
  };
}

export interface ExerciseInput {
  /** World after the disruption, without standby offers. */
  world: World;
  intent: Intent;
  /** When the exercise notice is sent. */
  at: number;
  kept: Allocation[];
  failed: Obligation[];
  options: readonly OptionLike[];
  /** Option fees already paid, which leave less budget and spending authority for the plan. */
  spentMinor: number;
}

export const EXERCISE_OBJECTIVE = 'Exercise purchased standby options; every other obligation stays exactly as agreed.';

/**
 * Replaces each failed obligation with one purchased option, upstream stages first, and checks the result with
 * the independent verifier: kept obligations unchanged, next-stage starts honoured, deadline and budget held.
 */
export function planExercise(inp: ExerciseInput): ExercisePlan {
  const { intent, at } = inp;
  const active = new Set(inp.world.actors.filter((a) => a.active).map((a) => a.id));
  const live = inp.options.filter((o) => ms(o.terms.expires) + TOLERANCE_MS >= at && active.has(o.terms.supplier));
  const world = withStandby(inp.world, live, iso(at));
  const idx = stageIndex(world);
  const stageOf = new Map(world.stages.map((s) => [s.id, s]));
  const terminals = terminalStages(world);
  const failed = [...inp.failed].sort((a, b) => (idx.get(a.stage) ?? 0) - (idx.get(b.stage) ?? 0));
  const allocations = [...inp.kept];
  const picks: ExercisePlan['picks'] = [];
  const attempts: ExerciseAttempt[] = [];
  const used = new Set<Id>();
  for (const ob of failed) {
    const stage = stageOf.get(ob.stage);
    const candidates = inp.options
      .filter((o) => o.terms.stage === ob.stage && !used.has(o.id))
      .sort((a, b) => Number(b.terms.covers.includes(ob.id)) - Number(a.terms.covers.includes(ob.id)) || exerciseCostMinor(a.terms, ob.qty) - exerciseCostMinor(b.terms, ob.qty));
    let chosen: ExercisePlan['picks'][number] | undefined;
    for (const opt of candidates) {
      const t = opt.terms;
      const fail = (reason: string) => attempts.push({ option: opt.id, obligation: ob.id, ok: false, reason });
      if (!active.has(t.supplier)) {
        fail('The standby supplier is no longer active.');
        continue;
      }
      if (ms(t.expires) + TOLERANCE_MS < at) {
        fail(`The option expired ${fmtTime(ms(t.expires))}.`);
        continue;
      }
      if (t.qty < ob.qty) {
        fail(`The option holds ${t.qty} units; ${ob.qty} are needed.`);
        continue;
      }
      const predsReady = Math.max(-Infinity, ...allocations.filter((a) => stage?.after.includes(a.stage)).map((a) => ms(a.finish)));
      const start = Math.max(ms(t.window.start), at, predsReady);
      const workEnd = start + workMs(t.ratePerHour, ob.qty);
      if (workEnd > ms(t.window.end) + TOLERANCE_MS) {
        fail(`Starting ${fmtTime(start)} it cannot finish inside its window.`);
        continue;
      }
      const finish = workEnd + Math.round(t.handoffHours * HOUR);
      const next = allocations.filter((a) => stageOf.get(a.stage)?.after.includes(ob.stage));
      const needBy = next.length ? Math.min(...next.map((a) => ms(a.start))) : terminals.has(ob.stage) ? ms(intent.deadline) : Infinity;
      if (finish > needBy + TOLERANCE_MS) {
        fail(`Its output would be ready ${fmtTime(finish)}, after it is needed at ${fmtTime(needBy)}.`);
        continue;
      }
      chosen = {
        obligation: ob,
        option: opt.id,
        terms: t,
        allocation: {
          offer: standbyOfferId(opt.id),
          actor: t.supplier,
          stage: t.stage,
          qty: ob.qty,
          start: iso(start),
          finish: iso(finish),
          cost: money(t.strikeUnit.currency, exerciseCostMinor(t, ob.qty)),
        },
      };
      attempts.push({ option: opt.id, obligation: ob.id, ok: true, reason: `Ready ${fmtTime(finish)}, before it is needed.` });
      break;
    }
    if (!chosen) return { ok: false, picks, world, attempts };
    allocations.push(chosen.allocation);
    used.add(chosen.option);
    picks.push(chosen);
  }
  const plan = planOf(world, intent, allocations, EXERCISE_OBJECTIVE);
  const verification = verifyPlan(plan, world, spendable(intent, inp.spentMinor, at), { fixed: inp.kept });
  if (!verification.ok) {
    const why = verification.checks.filter((c) => !c.ok).map((c) => c.text).join(' ');
    for (const p of picks) attempts.push({ option: p.option, obligation: p.obligation.id, ok: false, reason: `Independent check failed: ${why}` });
  }
  return { ok: verification.ok, picks, world, plan, verification, attempts };
}
