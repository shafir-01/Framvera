import type {
  Agreement,
  AgreementState,
  DecisionBasis,
  Id,
  Intent,
  Iso,
  NegotiationMessage,
  Obligation,
  ObligationState,
  Plan,
  SupplierDecision,
  World,
} from '@framvera/contracts';
import { hashTerms } from '@framvera/contracts';
import { allocationCost, coalitionMembers, jointParts, splitJoint, uniqueJobs, workMs } from './model.ts';
import { HOUR, MINUTE, ObligationError, sumMoney } from './util.ts';

export const BUYER: Id = 'buyer';

export interface PartyAcceptance {
  actor: Id;
  message: Id;
  termsHash: string;
  basis: DecisionBasis | 'buyer';
}
type AcceptMessage = Extract<NegotiationMessage, { type: 'Accept' }>;
export type AcceptanceInput = PartyAcceptance | (AcceptMessage & { basis: DecisionBasis | 'buyer' }) | SupplierDecision;

const AGREEMENT_NEXT: Record<AgreementState, AgreementState[]> = {
  DRAFT: ['PROPOSED', 'CANCELLED'],
  PROPOSED: ['ACCEPTED_BY_PARTIES', 'CANCELLED'],
  ACCEPTED_BY_PARTIES: ['COMMITTED', 'CANCELLED'],
  COMMITTED: ['FULFILLING', 'AMENDED', 'CANCELLED', 'SETTLED'],
  FULFILLING: ['SETTLED', 'AMENDED', 'CANCELLED'],
  AMENDED: [],
  SETTLED: [],
  CANCELLED: [],
};

const OBLIGATION_NEXT: Record<ObligationState, ObligationState[]> = {
  PENDING: ['ACTIVE', 'CANCELLED', 'REPLACED'],
  ACTIVE: ['AT_RISK', 'FULFILLED', 'BREACHED', 'CANCELLED', 'REPLACED'],
  AT_RISK: ['ACTIVE', 'FULFILLED', 'BREACHED', 'CANCELLED', 'REPLACED'],
  FULFILLED: [],
  BREACHED: [],
  CANCELLED: [],
  REPLACED: [],
};

export const BINDING: AgreementState[] = ['COMMITTED', 'FULFILLING'];
export const LIVE_OBLIGATION: ObligationState[] = ['PENDING', 'ACTIVE', 'AT_RISK'];

export const canAgreement = (from: AgreementState, to: AgreementState): boolean => AGREEMENT_NEXT[from].includes(to);
export const canObligation = (from: ObligationState, to: ObligationState): boolean => OBLIGATION_NEXT[from].includes(to);

function moveAgreement(a: Agreement, to: AgreementState): Agreement {
  if (!canAgreement(a.state, to)) throw new ObligationError('agreement-transition', `Agreement ${a.id} cannot move from ${a.state} to ${to}.`);
  return { ...a, state: to };
}

export function moveObligation(o: Obligation, to: ObligationState): Obligation {
  if (o.state === to) return o;
  if (!canObligation(o.state, to)) throw new ObligationError('obligation-transition', `Obligation ${o.id} cannot move from ${o.state} to ${to}.`);
  return { ...o, state: to };
}

export function termsOf(a: Pick<Agreement, 'id' | 'version' | 'intent' | 'plan' | 'parties' | 'obligations'>): unknown {
  return {
    id: a.id,
    version: a.version,
    intent: a.intent,
    plan: a.plan,
    parties: [...a.parties].sort(),
    obligations: a.obligations.map((o) => ({
      id: o.id,
      actor: o.actor,
      offer: o.offer,
      stage: o.stage,
      qty: o.qty,
      start: o.start,
      due: o.due,
      amount: o.amount,
      replaces: o.replaces,
    })),
  };
}

/** sha256 of the canonical terms, computed with the shared helper so browsers can recheck it. */
export const termsHashOf = (a: Parameters<typeof termsOf>[0]): string => hashTerms(termsOf(a));

export interface DraftOptions {
  buyer?: Id;
  at?: Iso;
  /** With the world, a joint offer's allocation becomes one obligation per member, each with its own share. */
  world?: World;
}

/** Deterministic draft: the same plan and intent always give the same agreement id, obligation ids and terms hash. */
export function draftAgreement(plan: Plan, intent: Intent, opts: DraftOptions = {}): Agreement {
  const buyer = opts.buyer ?? BUYER;
  const id = `agr:${plan.id}`;
  const obligations: Obligation[] = plan.allocations.flatMap((al, i) => {
    const base = { agreement: id, actor: al.actor, offer: al.offer, stage: al.stage, qty: al.qty, start: al.start, due: al.finish, amount: al.cost, state: 'PENDING' as const };
    const parts = splitJoint(base, opts.world);
    return parts.length === 1 ? [{ ...parts[0]!, id: `obl:${plan.id}:${i}` }] : parts.map((p, k) => ({ ...p, id: `obl:${plan.id}:${i}.${k}` }));
  });
  const parties = [buyer, ...new Set(obligations.map((o) => o.actor))];
  const base = { id, version: 1, intent: intent.id, plan: plan.id, parties, obligations };
  return { ...base, state: 'DRAFT', termsHash: termsHashOf(base), acceptances: [], createdAt: opts.at ?? intent.provenance.observedAt };
}

export function proposeAgreement(plan: Plan, intent: Intent, opts: DraftOptions = {}): Agreement {
  return moveAgreement(draftAgreement(plan, intent, opts), 'PROPOSED');
}

function normalize(input: AcceptanceInput): PartyAcceptance | null {
  if ('type' in input && input.type === 'Accept') {
    return { actor: input.from, message: input.id, termsHash: input.termsHash, basis: input.basis };
  }
  if ('actor' in input && 'termsHash' in input) return input as PartyAcceptance;
  return null;
}

/** Records one party's acceptance. Only parties may accept, only the exact terms hash, and only on their own basis. */
export function accept(a: Agreement, input: AcceptanceInput, buyer: Id = BUYER): Agreement {
  const acc = normalize(input);
  if (!acc) throw new ObligationError('not-an-acceptance', 'A supplier decision on a concession is not acceptance of agreement terms.');
  if (a.state !== 'PROPOSED') throw new ObligationError('agreement-transition', `Agreement ${a.id} is ${a.state}; acceptance needs PROPOSED.`);
  if (!a.parties.includes(acc.actor)) throw new ObligationError('not-a-party', `${acc.actor} is not a party to ${a.id}.`);
  if (acc.termsHash !== a.termsHash) throw new ObligationError('terms-mismatch', `Acceptance by ${acc.actor} signs different terms.`);
  const isBuyer = acc.actor === buyer;
  if (isBuyer !== (acc.basis === 'buyer')) throw new ObligationError('basis', `${acc.actor} cannot accept on basis ${acc.basis}.`);
  const prior = a.acceptances.find((x) => x.actor === acc.actor);
  if (prior) {
    if (prior.message === acc.message) return a;
    throw new ObligationError('duplicate-acceptance', `${acc.actor} already accepted ${a.id} v${a.version}.`);
  }
  const next: Agreement = { ...a, acceptances: [...a.acceptances, { ...acc }] };
  return missingAcceptances(next).length === 0 ? moveAgreement(next, 'ACCEPTED_BY_PARTIES') : next;
}

export const missingAcceptances = (a: Agreement): Id[] =>
  a.parties.filter((p) => !a.acceptances.some((x) => x.actor === p && x.termsHash === a.termsHash));

/** COMMITTED only when every party signed the current terms hash. Obligations become ACTIVE. */
export function commitAgreement(a: Agreement): Agreement {
  const missing = missingAcceptances(a);
  if (missing.length) throw new ObligationError('missing-acceptance', `Waiting for acceptance from ${missing.join(', ')}.`);
  if (termsHashOf(a) !== a.termsHash) throw new ObligationError('terms-mismatch', `Terms of ${a.id} changed after signing.`);
  const committed = moveAgreement(a, 'COMMITTED');
  return { ...committed, obligations: committed.obligations.map((o) => (o.state === 'PENDING' ? moveObligation(o, 'ACTIVE') : o)) };
}

export function startFulfilling(a: Agreement): Agreement {
  return moveAgreement(a, 'FULFILLING');
}

export function settle(a: Agreement): Agreement {
  const open = a.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  if (open.length) throw new ObligationError('open-obligations', `${open.length} obligations are still open.`);
  return moveAgreement(a, 'SETTLED');
}

/** Before commitment any party may walk away; after commitment cancellation needs every party's consent. */
export function cancelAgreement(a: Agreement, consents: Id[] = []): Agreement {
  if (BINDING.includes(a.state)) {
    const missing = a.parties.filter((p) => !consents.includes(p));
    if (missing.length) throw new ObligationError('consent', `Cancelling a committed agreement needs consent from ${missing.join(', ')}.`);
  }
  const c = moveAgreement(a, 'CANCELLED');
  return { ...c, obligations: c.obligations.map((o) => (LIVE_OBLIGATION.includes(o.state) ? moveObligation(o, 'CANCELLED') : o)) };
}

export interface AmendmentSpec {
  keep: Id[];
  replace: { replaces: Id; obligation: Omit<Obligation, 'id' | 'agreement' | 'state' | 'replaces'> }[];
  add: Omit<Obligation, 'id' | 'agreement' | 'state' | 'replaces'>[];
}

/** A new version that must be accepted by every party. The original object is never touched. */
export function amend(a: Agreement, spec: AmendmentSpec, buyer: Id = BUYER, world?: World): Agreement {
  if (!BINDING.includes(a.state)) throw new ObligationError('agreement-transition', `Only a committed agreement can be amended; ${a.id} is ${a.state}.`);
  const version = a.version + 1;
  const byId = new Map(a.obligations.map((o) => [o.id, o]));
  const kept = spec.keep.map((id) => {
    const o = byId.get(id);
    if (!o) throw new ObligationError('unknown-obligation', `No obligation ${id} in ${a.id}.`);
    return o;
  });
  const replaced = spec.replace.flatMap((r): Obligation[] => {
    if (!byId.has(r.replaces)) throw new ObligationError('unknown-obligation', `No obligation ${r.replaces} in ${a.id}.`);
    const parts = splitJoint(r.obligation, world);
    return parts.map((p, k) => ({ ...p, id: parts.length === 1 ? `${r.replaces}~v${version}` : `${r.replaces}~v${version}.${k}`, agreement: a.id, state: 'PENDING', replaces: r.replaces }));
  });
  const added = spec.add.flatMap((o, i): Obligation[] => {
    const parts = splitJoint(o, world);
    return parts.map((p, k) => ({ ...p, id: parts.length === 1 ? `obl:${a.id}:v${version}:${i}` : `obl:${a.id}:v${version}:${i}.${k}`, agreement: a.id, state: 'PENDING' }));
  });
  const obligations = [...kept, ...replaced, ...added];
  const parties = [buyer, ...new Set(obligations.map((o) => o.actor))];
  const base = { id: a.id, version, intent: a.intent, plan: a.plan, parties, obligations };
  return { ...base, state: 'PROPOSED', termsHash: termsHashOf(base), acceptances: [], createdAt: a.createdAt };
}

/** Marks the earlier version as superseded once its amendment is committed. Terms of both stay unchanged. */
export function supersede(original: Agreement, amended: Agreement): Agreement {
  if (amended.id !== original.id || amended.version !== original.version + 1) throw new ObligationError('version', 'Amendment does not follow this version.');
  if (!BINDING.includes(amended.state)) throw new ObligationError('agreement-transition', 'Amendment is not committed yet.');
  return moveAgreement(original, 'AMENDED');
}

export interface CommitOptions extends DraftOptions {
  world?: World;
  /** Units already reserved on each offer by other agreements in the same market. */
  reserved?: Map<Id, number> | Record<Id, number>;
}

/**
 * Turns a plan into an agreement. It is COMMITTED only when every party's acceptance of the exact terms hash is
 * present; otherwise it is returned PROPOSED or ACCEPTED_BY_PARTIES with the acceptances that were valid.
 */
export function commit(plan: Plan, intent: Intent, decisions: readonly AcceptanceInput[] = [], opts: CommitOptions = {}): Agreement {
  const total = sumMoney(
    plan.allocations.map((a) => a.cost),
    intent.budget.currency,
  );
  if (total.minor > intent.budget.minor) throw new ObligationError('budget', `Plan total ${total.minor} exceeds budget ${intent.budget.minor}.`);
  if (intent.authority.maxSpend.currency === total.currency && total.minor > intent.authority.maxSpend.minor) {
    throw new ObligationError('authority', 'Plan total exceeds the spending authority.');
  }
  if (!intent.authority.mayReserve) throw new ObligationError('authority', 'The buyer has not authorised reserving capacity.');
  if (opts.world) assertCapacity(plan, opts.world, opts.reserved);
  let a = proposeAgreement(plan, intent, opts);
  const buyer = opts.buyer ?? BUYER;
  for (const d of decisions) {
    const acc = normalize(d);
    if (!acc || acc.termsHash !== a.termsHash || !a.parties.includes(acc.actor)) continue;
    if (a.state !== 'PROPOSED') break;
    try {
      a = accept(a, acc, buyer);
    } catch (e) {
      if (!(e instanceof ObligationError) || e.code !== 'duplicate-acceptance') throw e;
    }
  }
  return a.state === 'ACCEPTED_BY_PARTIES' ? commitAgreement(a) : a;
}

export function assertCapacity(plan: Plan, world: World, reserved?: Map<Id, number> | Record<Id, number>): void {
  const held = reserved instanceof Map ? reserved : new Map(Object.entries(reserved ?? {}));
  const use = new Map<Id, number>();
  for (const al of plan.allocations) use.set(al.offer, (use.get(al.offer) ?? 0) + al.qty);
  for (const [offer, qty] of use) {
    const o = world.offers.find((x) => x.id === offer);
    if (!o) throw new ObligationError('unknown-offer', `Offer ${offer} is not in the world.`);
    const total = qty + (held.get(offer) ?? 0);
    if (total > o.capacity) throw new ObligationError('over-allocation', `Offer ${offer} would hold ${total} units against capacity ${o.capacity}.`);
  }
}

/** Units held on each offer by live obligations of binding or accepted agreements. */
export function reservations(agreements: Agreement[], except?: Id): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const a of agreements) {
    if (a.id === except || !['ACCEPTED_BY_PARTIES', ...BINDING].includes(a.state)) continue;
    for (const o of uniqueJobs(a.obligations.filter((x) => LIVE_OBLIGATION.includes(x.state)))) out.set(o.offer, (out.get(o.offer) ?? 0) + o.qty);
  }
  return out;
}

export function acceptMessage(a: Agreement, actor: Id, replyTo: Id, at: Iso, to: Id = BUYER): AcceptMessage {
  return { type: 'Accept', id: `acc:${a.id}:v${a.version}:${actor}`, from: actor, to, replyTo, termsHash: a.termsHash, at };
}

export interface SignResult {
  agreement: Agreement;
  accepts: AcceptMessage[];
  declined: { actor: Id; reason: string }[];
}

/** Why a supplier's standing offer does not already cover its obligations, or null when it does. */
export function outsideOffer(obligations: Obligation[], world: World): string | null {
  const byId = new Map(world.offers.map((o) => [o.id, o]));
  const actors = new Map(world.actors.map((a) => [a.id, a]));
  const use = new Map<Id, number>();
  for (const ob of obligations) {
    const offer = byId.get(ob.offer);
    if (!offer) return `offer ${ob.offer} is no longer published`;
    if (actors.get(offer.actor)?.active === false || actors.get(ob.actor)?.active === false) return 'the supplier is no longer active';
    use.set(offer.id, (use.get(offer.id) ?? 0) + ob.qty);
    if ((use.get(offer.id) ?? 0) > offer.capacity) return `asks for more than the published capacity of ${offer.capacity}`;
    if (ob.qty < offer.minQty) return `below the minimum order of ${offer.minQty}`;
    const start = Date.parse(ob.start);
    const work = workMs(offer, ob.qty);
    if (start < Date.parse(offer.window.start) - MINUTE || start + work > Date.parse(offer.window.end) + MINUTE) return 'outside the published working window';
    if (Date.parse(ob.due) + MINUTE < start + work + offer.handoffHours * HOUR) return 'earlier than production and handoff allow';
    const floor = jointParts(world, offer.id, ob.qty)?.find((p) => p.actor === ob.actor)?.share.minor ?? allocationCost(offer, ob.qty).minor;
    if (ob.amount.currency !== offer.setupFee.currency || ob.amount.minor < floor) return 'below the published price';
  }
  return null;
}

function standingOfferBasis(obligations: Obligation[], world: World): 'synthetic-policy' | 'seller-terminal' | null {
  const byId = new Map(world.offers.map((o) => [o.id, o]));
  const sources = obligations.flatMap((ob) => {
    const offer = byId.get(ob.offer);
    if (!offer) return [];
    const members = coalitionMembers(offer.id);
    return members ? members.map((m) => byId.get(m)?.provenance.source) : [offer.provenance.source];
  });
  if (sources.some((s) => s === 'seller-terminal')) return 'seller-terminal';
  return sources.every((s) => s === 'synthetic-market') ? 'synthetic-policy' : null;
}

/**
 * Collects acceptances of the exact terms hash. The buyer signs by asking to commit. A synthetic supplier signs
 * only when its own published offer already covers every one of its obligations; a seller at the terminal and
 * any supplier whose terms differ from its offer are left to answer for themselves.
 */
export function sign(draft: Agreement, world: World, _truth?: unknown, opts: { at?: Iso; buyer?: Id } = {}): SignResult {
  const buyer = opts.buyer ?? BUYER;
  const at = opts.at ?? new Date().toISOString();
  if (draft.state !== 'PROPOSED') return { agreement: draft, accepts: [], declined: [] };
  let a = draft;
  const accepts: AcceptMessage[] = [];
  const declined: SignResult['declined'] = [];
  for (const party of draft.parties) {
    if (a.acceptances.some((x) => x.actor === party)) continue;
    if (party === buyer) {
      const m = acceptMessage(a, buyer, a.id, at, a.id);
      a = accept(a, { ...m, basis: 'buyer' }, buyer);
      accepts.push(m);
      continue;
    }
    const mine = a.obligations.filter((o) => o.actor === party);
    const basis = standingOfferBasis(mine, world);
    const why = outsideOffer(mine, world);
    if (why) declined.push({ actor: party, reason: why });
    else if (basis !== 'synthetic-policy') declined.push({ actor: party, reason: 'waiting for the seller to accept' });
    else {
      const m = acceptMessage(a, party, a.id, at, buyer);
      a = accept(a, { ...m, basis }, buyer);
      accepts.push(m);
    }
  }
  return { agreement: a.state === 'ACCEPTED_BY_PARTIES' ? commitAgreement(a) : a, accepts, declined };
}
