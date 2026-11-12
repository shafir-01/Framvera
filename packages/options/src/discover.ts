import { effectiveCapacity, money, unitPrice } from '@framvera/contracts';
import type { Agreement, Id, Intent, Iso, Obligation, Offer, World } from '@framvera/contracts';
import { BUYER, LIVE_OBLIGATION } from '@framvera/obligations';
import { createStandbyDesk, termsHashOf, type StandbyDesk, type StandbyTruth } from './desk.ts';
import { assessRisk } from './risk.ts';
import { exerciseCostMinor, fmtTime, planExercise } from './standby.ts';
import type { Declined, Discovery, ObligationRisk, RequestStandby, StandbyDecision, StandbyMessage, StandbyOption, StandbyTerms } from './types.ts';
import { HOUR, fmtKr, iso, ms, successors, toAllocation, workMs } from './util.ts';

export interface DiscoverOptions {
  /** Supplier boundary. Pass a desk, or the private truth to build one. */
  desk?: StandbyDesk;
  truth?: StandbyTruth;
  risks?: ObligationRisk[];
  /** Market time of the requests. Defaults to the agreement's creation time. */
  at?: Iso;
  buyer?: Id;
  /** How many of the riskiest obligations get backups. */
  maxTargets?: number;
  minRisk?: number;
  /** Backup suppliers asked per obligation, cheapest exercise cost first. */
  perTarget?: number;
  /** Opening fee as a share of the held strike value. */
  openingFeeShare?: number;
  /** Largest fee the buyer accepts, as a share of the backed obligation's amount. */
  maxFeeShare?: number;
  /** Largest strike mark-up over the published unit price the buyer accepts. */
  maxStrikePremium?: number;
  /** Hours a supplier's acceptance stays open for the buyer. */
  quoteHours?: number;
}

interface Target {
  ob: Obligation;
  kept: ReturnType<typeof toAllocation>[];
  predsReady: number;
  needBy: number;
}

function targetOf(world: World, intent: Intent, live: Obligation[], ob: Obligation): Target {
  const stage = world.stages.find((s) => s.id === ob.stage);
  const kept = live.filter((o) => o.id !== ob.id).map(toAllocation);
  const predsReady = Math.max(-Infinity, ...kept.filter((a) => stage?.after.includes(a.stage)).map((a) => ms(a.finish)));
  const next = new Set(successors(world, ob.stage));
  const starts = kept.filter((a) => next.has(a.stage)).map((a) => ms(a.start));
  const needBy = starts.length ? Math.min(...starts) : ms(intent.deadline);
  return { ob, kept, predsReady, needBy };
}

function agreementOf(terms: StandbyTerms, termsHash: string, intent: Intent, at: Iso, accept: StandbyMessage, basis: StandbyOption['basis']): Agreement {
  const id = `agr:${terms.option}`;
  return {
    id,
    version: 1,
    intent: intent.id,
    plan: terms.option,
    parties: [terms.buyer, terms.supplier],
    state: 'PROPOSED',
    termsHash,
    obligations: [
      { id: `obl:${terms.option}:hold`, agreement: id, actor: terms.supplier, offer: terms.offer, stage: terms.stage, qty: terms.qty, start: at, due: terms.expires, amount: terms.fee, state: 'PENDING' },
    ],
    acceptances: [{ actor: terms.supplier, message: accept.id, termsHash, basis }],
    createdAt: at,
  };
}

/**
 * Finds backup suppliers for the riskiest committed obligations and negotiates contingent standby terms with each
 * through its private policy. A supplier's acceptance makes a quote; nothing binds the buyer until acceptOptions.
 */
export function discoverOptions(world: World, intent: Intent, agreement: Agreement, opts: DiscoverOptions = {}): Discovery {
  const desk = opts.desk ?? (opts.truth ? createStandbyDesk(opts.truth, world, intent.id) : undefined);
  if (!desk) throw new Error('discoverOptions needs a supplier desk or the private truth to build one.');
  const at = opts.at ?? agreement.createdAt;
  const now = ms(at);
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const buyer = opts.buyer ?? agreement.parties.find((p) => !live.some((o) => o.actor === p)) ?? BUYER;
  const risks = opts.risks ?? assessRisk(world, agreement, { at });
  const targets = risks
    .filter((r) => r.pFail >= (opts.minRisk ?? 0.02))
    .sort((a, b) => b.pFail - a.pFail || b.amount.minor - a.amount.minor)
    .slice(0, opts.maxTargets ?? 3);
  const active = new Set(world.actors.filter((a) => a.active).map((a) => a.id));
  const committed = new Map<Id, number>();
  for (const o of live) committed.set(o.offer, (committed.get(o.offer) ?? 0) + o.qty);
  const held = new Map<Id, number>();
  const options: StandbyOption[] = [];
  const declined: Declined[] = [];
  const unsuitable: Discovery['unsuitable'] = [];
  const quoteUntil = iso(now + (opts.quoteHours ?? 24) * HOUR);
  const planTotal = live.reduce((acc, o) => acc + o.amount.minor, 0);
  const auth = intent.authority.maxSpend;
  const cap = Math.min(intent.budget.minor, auth.currency === intent.budget.currency ? auth.minor : Infinity);

  for (const risk of targets) {
    const ob = live.find((o) => o.id === risk.obligation)!;
    const tg = targetOf(world, intent, live, ob);
    const reveal = Math.max(now, ms(ob.start));
    const drafts: { offer: Offer; terms: StandbyTerms }[] = [];
    for (const offer of world.offers) {
      if (offer.stage !== ob.stage || offer.actor === ob.actor || offer.id.startsWith('standby:')) continue;
      if (!active.has(offer.actor) || offer.ratePerHour <= 0 || offer.setupFee.currency !== intent.budget.currency) continue;
      const no = (reason: string) => unsuitable.push({ obligation: ob.id, offer: offer.id, reason });
      const spare = effectiveCapacity(world, offer) - (committed.get(offer.id) ?? 0) - (held.get(offer.id) ?? 0);
      if (spare < ob.qty) {
        no(`Has room for ${Math.max(0, spare)} units; ${ob.qty} are needed.`);
        continue;
      }
      if (offer.minQty > ob.qty) {
        no(`Minimum order ${offer.minQty} is above the ${ob.qty} units needed.`);
        continue;
      }
      const work = workMs(offer.ratePerHour, ob.qty);
      const start = Math.max(ms(offer.window.start), reveal, tg.predsReady);
      const finish = start + work + Math.round(offer.handoffHours * HOUR);
      if (start + work > ms(offer.window.end)) {
        no(`Starting ${fmtTime(start)} it cannot finish inside its window.`);
        continue;
      }
      if (finish > tg.needBy) {
        no(`Output would be ready ${fmtTime(finish)}, after it is needed at ${fmtTime(tg.needBy)}.`);
        continue;
      }
      const cost = planTotal - ob.amount.minor + exerciseCostMinor({ strikeUnit: unitPrice(offer, ob.qty), setupFee: offer.setupFee, qty: ob.qty });
      if (cost > cap) {
        no(`Replacing at its published price brings the total to ${fmtKr(cost)}, above the ${fmtKr(cap)} limit.`);
        continue;
      }
      const latestStart = Math.min(ms(offer.window.end) - work, tg.needBy - work - Math.round(offer.handoffHours * HOUR));
      const strike = unitPrice(offer, ob.qty);
      drafts.push({
        offer,
        terms: {
          option: `opt:${ob.id}:${offer.id}`,
          buyer,
          supplier: offer.actor,
          offer: offer.id,
          stage: ob.stage,
          covers: [ob.id],
          qty: ob.qty,
          minExercise: Math.min(offer.minQty, ob.qty),
          fee: money(strike.currency, Math.round((opts.openingFeeShare ?? 0.01) * strike.minor * ob.qty)),
          strikeUnit: strike,
          setupFee: offer.setupFee,
          window: offer.window,
          ratePerHour: offer.ratePerHour,
          handoffHours: offer.handoffHours,
          expires: iso(latestStart),
        },
      });
    }
    drafts.sort((a, b) => exerciseCostMinor(a.terms) - exerciseCostMinor(b.terms));

    for (const { offer, terms } of drafts.slice(0, opts.perTarget ?? 2)) {
      const messages: StandbyMessage[] = [];
      const decisions: StandbyDecision[] = [];
      const ask = (t: StandbyTerms, n: number): { decision: StandbyDecision; reply: StandbyMessage } => {
        const req: RequestStandby = { type: 'RequestStandby', id: `${t.option}:r${n}`, from: buyer, to: t.supplier, terms: t, termsHash: termsHashOf(t, intent.id), expires: quoteUntil, at };
        const r = desk.respond(req);
        messages.push(req, r.reply);
        decisions.push(r.decision);
        return r;
      };
      const published = unitPrice(offer, ob.qty).minor;
      const tooFar = (t: StandbyTerms): string | null => {
        if (t.qty < ob.qty) return `Holds only ${t.qty} of ${ob.qty} units.`;
        if (ms(t.expires) < now + HOUR) return 'Would expire within the hour.';
        if (t.strikeUnit.minor > published * (1 + (opts.maxStrikePremium ?? 0.2))) return 'Strike price is too far above the published price.';
        if (t.fee.minor > (opts.maxFeeShare ?? 0.1) * ob.amount.minor) return 'Fee is too large for the obligation it backs.';
        return null;
      };
      let final: StandbyTerms | undefined;
      let accept: StandbyMessage | undefined;
      let basis: StandbyOption['basis'] = 'synthetic-policy';
      const first = ask(terms, 1);
      if (first.decision.accept) {
        final = terms;
        accept = first.reply;
        basis = first.decision.basis;
      } else if (first.decision.counter) {
        const why = tooFar(first.decision.counter);
        if (why) declined.push({ obligation: ob.id, offer: offer.id, actor: offer.actor, reason: `Counter not taken: ${why}`, messages, decisions });
        else {
          const second = ask(first.decision.counter, 2);
          if (second.decision.accept) {
            final = first.decision.counter;
            accept = second.reply;
            basis = second.decision.basis;
          } else declined.push({ obligation: ob.id, offer: offer.id, actor: offer.actor, reason: second.decision.reason, messages, decisions });
        }
      } else declined.push({ obligation: ob.id, offer: offer.id, actor: offer.actor, reason: first.decision.reason, messages, decisions });
      if (!final || !accept) continue;

      const latestFailure = Math.min(reveal, ms(final.expires));
      const termsHash = termsHashOf(final, intent.id);
      const check = planExercise({
        world,
        intent,
        at: latestFailure,
        kept: tg.kept,
        failed: [ob],
        options: [{ id: final.option, terms: final, basis }],
        spentMinor: 0,
      });
      if (!check.ok || !check.verification) {
        declined.push({ obligation: ob.id, offer: offer.id, actor: offer.actor, reason: check.attempts.at(-1)?.reason ?? 'Replacement failed the independent check.', messages, decisions });
        continue;
      }
      held.set(offer.id, (held.get(offer.id) ?? 0) + final.qty);
      options.push({
        id: final.option,
        status: 'quoted',
        terms: final,
        termsHash,
        basis,
        agreement: agreementOf(final, termsHash, intent, at, accept, basis),
        messages,
        decisions,
        check: check.verification,
        exerciseCost: money(final.strikeUnit.currency, exerciseCostMinor(final)),
        latestFailure: iso(latestFailure),
        readyBy: check.picks[0]!.allocation.finish,
        needBy: iso(tg.needBy),
      });
    }
  }
  return { risks, targets: targets.map((t) => t.obligation), options, declined, unsuitable };
}

/**
 * Records the buyer's acceptance of the exact terms hash for the chosen quotes, which commits their agreements.
 * Every other quote lapses and never binds anyone.
 */
export function acceptOptions(options: readonly StandbyOption[], buy: readonly Id[], opts: { at?: Iso } = {}): StandbyOption[] {
  return options.map((o) => {
    const request = o.messages.find((m): m is RequestStandby => m.type === 'RequestStandby');
    const at = opts.at ?? o.agreement.createdAt;
    const open = o.status === 'quoted' && o.agreement.state === 'PROPOSED' && (!request || ms(at) <= ms(request.expires));
    const signed = o.agreement.acceptances.some((a) => a.actor === o.terms.supplier && a.termsHash === o.termsHash);
    if (buy.includes(o.id) && open && signed) {
      const accept: StandbyMessage = { type: 'Accept', id: `${o.id}:buyer-accept`, from: o.terms.buyer, to: o.terms.supplier, replyTo: o.agreement.acceptances[0]!.message, termsHash: o.termsHash, at };
      return {
        ...o,
        status: 'purchased',
        messages: [...o.messages, accept],
        agreement: {
          ...o.agreement,
          state: 'COMMITTED',
          acceptances: [...o.agreement.acceptances, { actor: o.terms.buyer, message: accept.id, termsHash: o.termsHash, basis: 'buyer' }],
          obligations: o.agreement.obligations.map((h) => ({ ...h, state: 'ACTIVE' })),
        },
      };
    }
    if (o.status !== 'quoted') return o;
    return {
      ...o,
      status: 'lapsed',
      agreement: { ...o.agreement, state: 'CANCELLED', obligations: o.agreement.obligations.map((h) => ({ ...h, state: 'CANCELLED' })) },
    };
  });
}

/** Units each purchased option holds on its supplier's offer, for capacity checks elsewhere in the market. */
export function heldCapacity(options: readonly StandbyOption[]): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const o of options) if (o.status === 'purchased') out.set(o.terms.offer, (out.get(o.terms.offer) ?? 0) + o.terms.qty);
  return out;
}

export function feesPaid(options: readonly StandbyOption[]): number {
  return options.filter((o) => o.status === 'purchased' || o.status === 'exercised').reduce((s, o) => s + o.terms.fee.minor, 0);
}
