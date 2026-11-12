import type { Coalition, Concession, NegotiableField, NegotiationMessage, Offer, SupplierDecision, World } from '@framvera/contracts';
import type { PolicyLike, TruthLike } from './types.ts';
import { HOUR, findOffer, fmtMoney, money, numeric, sameKind, supplierDirection } from './util.ts';

export type Answerable = Extract<NegotiationMessage, { type: 'Propose' } | { type: 'AskPreference' } | { type: 'CounterOffer' }>;

/** Public context a supplier sees with a proposal: the proposed coalitions and their payment splits. */
export interface DecideContext {
  coalitions?: Coalition[];
}

const PRICE_FIELDS: NegotiableField[] = ['unitPrice', 'setupFee'];

function concessionOf(msg: Answerable): Concession {
  return msg.type === 'AskPreference' ? msg.question : msg.concession;
}

function currentValue(offer: Offer, field: NegotiableField): number | undefined {
  switch (field) {
    case 'capacity':
      return offer.capacity;
    case 'minQty':
      return offer.minQty;
    case 'setupFee':
      return offer.setupFee.minor;
    case 'windowEnd':
      return Date.parse(offer.window.end);
    case 'windowStart':
      return Date.parse(offer.window.start);
    case 'unitPrice':
      return offer.tiers[0]?.unit.minor;
    default:
      return undefined;
  }
}

/** The supplier's private limit for one field of one offer, in the same numeric units as `numeric()`. */
export function privateLimit(policy: PolicyLike, offer: Offer, field: NegotiableField): number | undefined {
  const raw = policy.offers?.[offer.id]?.[field] ?? policy.reservation[field];
  if (field === 'capacity' && raw === undefined && typeof policy.maxOvertimeUnits === 'number') {
    return offer.capacity + policy.maxOvertimeUnits;
  }
  if (field === 'windowEnd') {
    const hours = typeof raw === 'number' ? raw : raw === undefined ? policy.maxExtensionHours : undefined;
    if (typeof hours === 'number') return Date.parse(offer.window.end) + hours * HOUR;
  }
  if (field === 'windowStart' && typeof raw === 'number') return Date.parse(offer.window.start) - raw * HOUR;
  return numeric(field, raw as number | string | boolean | undefined);
}

/** True when a counter adds a charge to the proposal instead of replacing its term. */
export function isCharge(proposal: Concession, counter: Concession): boolean {
  return (
    proposal.target.kind === 'offer' &&
    counter.target.kind === 'offer' &&
    (counter.target.field !== proposal.target.field || counter.target.offer !== proposal.target.offer)
  );
}

function reply(msg: Answerable, accept: boolean, reason: string, counter?: Concession): SupplierDecision {
  return counter
    ? { message: msg.id, accept, basis: 'synthetic-policy', counter, reason }
    : { message: msg.id, accept, basis: 'synthetic-policy', reason };
}

/** True when a joint concession's target value names this coalition, with or without the `joint:` prefix. */
export function namesCoalition(to: number | string, id: string): boolean {
  const t = String(to);
  return t === id || t.replace(/^joint:/, '') === id || `joint:${t}` === id;
}

function jointShare(msg: Answerable, c: Concession, ctx: DecideContext): number | undefined {
  const co = ctx.coalitions?.find((x) => namesCoalition(c.to, x.id));
  return co?.split.find((s) => s.actor === msg.to)?.share.minor;
}

/**
 * Deterministic private supplier policy. Accepts a term inside the supplier's limits, counters with the
 * closest term it can commit to, or rejects. A field that needs paid overtime is answered with a counter
 * that adds the overtime charge to the setup fee; accepting that counter binds both. Contingent proposals
 * carry a hold risk, so price floors rise by up to 10% for a supplier with low risk tolerance. A joint
 * order is accepted only when the supplier's share of the proposed split meets its floor.
 * Never accepts or counters beyond a private limit.
 */
export function decide(msg: NegotiationMessage, policy: PolicyLike, world: World, ctx: DecideContext = {}): SupplierDecision {
  if (msg.type !== 'Propose' && msg.type !== 'AskPreference' && msg.type !== 'CounterOffer') {
    return { message: msg.id, accept: false, basis: 'synthetic-policy', reason: 'Only proposals can be answered.' };
  }
  const c = concessionOf(msg);
  if (c.target.kind !== 'offer') return reply(msg, false, 'Deadline and budget changes are the buyer’s decision.');
  const offer = findOffer(world, c.target.offer);
  if (!offer) return reply(msg, false, 'No such offer.');
  if (offer.actor !== msg.to) return reply(msg, false, 'This offer belongs to another supplier.');
  const field = c.target.field;

  const limit = privateLimit(policy, offer, field);
  if (field === 'joint') {
    if (limit === undefined) return reply(msg, false, 'Not able to take part in a joint order.');
    const share = jointShare(msg, c, ctx);
    if (share === undefined) return reply(msg, false, 'Needs to see its share of the joint order first.');
    return share >= limit
      ? reply(msg, true, 'Willing to take part in the joint order at the proposed share.')
      : reply(msg, false, 'Its share of the joint order is too low.');
  }
  if (limit === undefined) return reply(msg, false, 'Cannot move on this term.');

  const to = numeric(field, c.to);
  const from = numeric(field, c.from) ?? currentValue(offer, field);
  if (to === undefined || from === undefined) return reply(msg, false, 'The proposed term could not be read.');

  const dir = supplierDirection(field);
  const contingent = msg.type === 'Propose' && (msg.conditional?.length ?? 0) > 0;
  const risk = Math.min(1, Math.max(0, policy.riskTolerance));
  const effective = contingent && PRICE_FIELDS.includes(field) ? Math.ceil(limit * (1 + 0.1 * (1 - risk))) : limit;
  const premium = policy.premium?.[field]?.minor ?? 0;

  if (dir * (to - effective) >= 0) {
    if (premium > 0 && msg.type !== 'CounterOffer') {
      const charge: Concession = {
        id: `${c.id}:charge`,
        target: { kind: 'offer', offer: offer.id, field: 'setupFee' },
        from: offer.setupFee.minor,
        to: offer.setupFee.minor + premium,
        estimate: money(offer.setupFee.currency, premium),
        rationale: `Agrees to the ${field} change if the overtime is paid: ${fmtMoney(money(offer.setupFee.currency, premium))} added to the setup fee.`,
      };
      return reply(msg, false, 'Can do this with paid overtime; countering with the overtime charge.', charge);
    }
    return reply(msg, true, 'Accepted as proposed.');
  }
  if (premium === 0 && dir * (from - effective) > 0) {
    const counter: Concession = {
      ...c,
      id: `${c.id}:counter`,
      to: sameKind(field, c.to, effective),
      rationale: 'Supplier counter: the closest term this supplier can commit to.',
    };
    return reply(msg, false, 'Can move part of the way; countering with the closest term we can commit to.', counter);
  }
  return reply(msg, false, 'Cannot move that far on this term.');
}

export interface SupplierDesk {
  respond(msg: Answerable, ctx?: DecideContext): SupplierDecision;
}

/**
 * Supplier side of the negotiation. Private policies are captured in this closure and only
 * SupplierDecision values leave it. This is module separation inside one process, not a security
 * boundary: any code running in the same process could read the market truth directly.
 */
export function createSupplierDesk(
  truth: TruthLike,
  world: World,
  terminal?: (msg: Answerable) => SupplierDecision | undefined,
): SupplierDesk {
  const policies = truth.policies;
  return Object.freeze({
    respond(msg: Answerable, ctx: DecideContext = {}): SupplierDecision {
      const human = terminal?.(msg);
      if (human) return { ...human, message: msg.id, basis: 'seller-terminal' };
      const p = policies[msg.to];
      if (!p) return { message: msg.id, accept: false, basis: 'synthetic-policy', reason: 'No answer from this supplier.' };
      return decide(msg, p, world, ctx);
    },
  });
}
