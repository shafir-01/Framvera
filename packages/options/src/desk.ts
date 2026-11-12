import { effectiveCapacity, hashTerms, money, unitPrice } from '@framvera/contracts';
import type { Id, World } from '@framvera/contracts';
import type { RequestStandby, StandbyDecision, StandbyMessage, StandbyTerms } from './types.ts';
import { HOUR, clamp01, iso, ms, workMs } from './util.ts';

/** Optional standby clause of a private supplier policy. Absent fields follow from the supplier's risk tolerance. */
export interface StandbyClause {
  willing?: boolean;
  /** Smallest fee, as a share of the strike value of the held capacity. */
  feeShare?: number;
  /** Mark-up over the private unit price floor for a contingent order. */
  strikePremium?: number;
  maxHoldHours?: number;
  maxQty?: number;
}

/** The private policy fields the standby desk reads. Structurally compatible with the market's SupplierPolicy. */
export interface StandbyPolicyLike {
  reservation: Partial<Record<string, number | string | boolean>>;
  riskTolerance: number;
  offers?: Record<Id, Partial<Record<string, number | string | boolean>>>;
  standby?: StandbyClause;
}

export interface StandbyTruth {
  policies: Record<Id, StandbyPolicyLike>;
}

export interface StandbyDesk {
  respond(msg: RequestStandby): { decision: StandbyDecision; reply: StandbyMessage };
}

export function termsHashOf(terms: StandbyTerms, intent: Id): string {
  return hashTerms({ kind: 'standby', intent, terms });
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** The supplier's private limits for a standby on one offer. Never leaves the desk. */
function limits(policy: StandbyPolicyLike, world: World, terms: StandbyTerms, at: number) {
  const offer = world.offers.find((o) => o.id === terms.offer)!;
  const clause = policy.standby ?? {};
  const risk = clamp01(policy.riskTolerance);
  const published = unitPrice(offer, terms.qty).minor;
  const floor = num(policy.offers?.[offer.id]?.unitPrice) ?? num(policy.reservation.unitPrice) ?? published;
  const strikeFloor = Math.ceil(floor * (1 + (clause.strikePremium ?? 0.1 * (1 - risk))));
  const feeShare = clause.feeShare ?? 0.02 + 0.06 * (1 - risk);
  const maxQty = Math.min(clause.maxQty ?? Infinity, effectiveCapacity(world, offer));
  const physical = ms(offer.window.end) - workMs(offer.ratePerHour, terms.qty);
  const latest = Math.min(at + (clause.maxHoldHours ?? 24 + 96 * risk) * HOUR, physical);
  return { willing: clause.willing !== false, strikeFloor, feeShare, maxQty, latest };
}

function closest(terms: StandbyTerms, l: ReturnType<typeof limits>): StandbyTerms {
  const qty = Math.min(terms.qty, l.maxQty);
  const strike = Math.max(terms.strikeUnit.minor, l.strikeFloor);
  const fee = Math.max(terms.fee.minor, Math.ceil(l.feeShare * strike * qty));
  const expires = Math.min(ms(terms.expires), l.latest);
  return {
    ...terms,
    qty,
    minExercise: Math.min(terms.minExercise, qty),
    strikeUnit: money(terms.strikeUnit.currency, strike),
    fee: money(terms.fee.currency, fee),
    expires: iso(expires),
  };
}

const same = (a: StandbyTerms, b: StandbyTerms) =>
  a.qty === b.qty && a.strikeUnit.minor === b.strikeUnit.minor && a.fee.minor === b.fee.minor && ms(a.expires) === ms(b.expires);

/**
 * Deterministic standby clause of a private supplier policy: accepts terms inside its limits, counters with the
 * closest terms it can commit to, or declines. A contingent order carries a premium over the private price floor
 * that shrinks as risk tolerance grows, matching how the policy prices any contingent proposal.
 */
export function decideStandby(msg: RequestStandby, policy: StandbyPolicyLike, world: World, intent: Id): { decision: StandbyDecision; reply: StandbyMessage } {
  const t = msg.terms;
  const reject = (reason: string) => ({
    decision: { message: msg.id, accept: false, basis: 'synthetic-policy' as const, reason },
    reply: { type: 'Reject' as const, id: `${msg.id}:reject`, from: msg.to, to: msg.from, replyTo: msg.id, reason, at: msg.at },
  });
  const offer = world.offers.find((o) => o.id === t.offer);
  if (!offer) return reject('No such offer.');
  if (offer.actor !== msg.to || t.supplier !== msg.to) return reject('This offer belongs to another supplier.');
  if (msg.termsHash !== termsHashOf(t, intent)) return reject('The terms do not match their hash.');
  const l = limits(policy, world, t, ms(msg.at));
  if (!l.willing) return reject('Not offering standby capacity.');
  const best = closest(t, l);
  if (best.qty <= 0 || ms(best.expires) <= ms(msg.at)) return reject('Cannot hold that capacity for any useful period.');
  if (same(best, t)) {
    return {
      decision: { message: msg.id, accept: true, basis: 'synthetic-policy', reason: 'Standby accepted as proposed.' },
      reply: { type: 'Accept', id: `${msg.id}:accept`, from: msg.to, to: msg.from, replyTo: msg.id, termsHash: msg.termsHash, at: msg.at },
    };
  }
  const termsHash = termsHashOf(best, intent);
  return {
    decision: { message: msg.id, accept: false, basis: 'synthetic-policy', reason: 'Countering with the closest standby terms this supplier can commit to.', counter: best },
    reply: { type: 'CounterStandby', id: `${msg.id}:counter`, from: msg.to, to: msg.from, replyTo: msg.id, terms: best, termsHash, expires: msg.expires, at: msg.at },
  };
}

/**
 * Supplier side of standby negotiation. Private policies stay in this closure; only decisions and typed replies
 * leave it. A seller terminal answer, when present, replaces the synthetic policy for that message.
 */
export function createStandbyDesk(
  truth: StandbyTruth,
  world: World,
  intent: Id,
  terminal?: (msg: RequestStandby) => { accept: boolean; reason: string } | undefined,
): StandbyDesk {
  const policies = truth.policies;
  return Object.freeze({
    respond(msg: RequestStandby): { decision: StandbyDecision; reply: StandbyMessage } {
      const human = terminal?.(msg);
      if (human) {
        const decision: StandbyDecision = { message: msg.id, accept: human.accept, basis: 'seller-terminal', reason: human.reason };
        const reply: StandbyMessage = human.accept
          ? { type: 'Accept', id: `${msg.id}:accept`, from: msg.to, to: msg.from, replyTo: msg.id, termsHash: msg.termsHash, at: msg.at }
          : { type: 'Reject', id: `${msg.id}:reject`, from: msg.to, to: msg.from, replyTo: msg.id, reason: human.reason, at: msg.at };
        return { decision, reply };
      }
      const p = policies[msg.to];
      if (!p) {
        const reason = 'No answer from this supplier.';
        return {
          decision: { message: msg.id, accept: false, basis: 'synthetic-policy', reason },
          reply: { type: 'Reject', id: `${msg.id}:reject`, from: msg.to, to: msg.from, replyTo: msg.id, reason, at: msg.at },
        };
      }
      return decideStandby(msg, p, world, intent);
    },
  });
}
