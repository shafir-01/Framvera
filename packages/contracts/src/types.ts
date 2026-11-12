/**
 * Framvera Economic IR (EIR), version 1.
 * The single shared vocabulary for market worlds, solving, negotiation,
 * agreements and real PayPal execution. Additive changes only.
 */

// ---------- Primitives ----------
export type Id = string;
export type Iso = string; // UTC ISO-8601 timestamp
export type Currency = 'SEK' | 'USD' | 'EUR';

/** Exact money: integer minor units (öre, cents). Never floats for totals. */
export interface Money {
  currency: Currency;
  minor: number;
}

/** Where a fact came from. Shown in the UI; never blended. */
export type Source =
  | 'synthetic-market' // generated world, known ground truth exists in the referee
  | 'seller-terminal' // a human acting as a supplier in the live demo
  | 'buyer' // the user
  | 'model-proposal' // AI output, untrusted until validated
  | 'solver' // deterministic computation
  | 'paypal-sandbox' // retrieved from PayPal, authoritative for money
  | 'external-catalog'; // third-party product data, informative only

export interface Provenance {
  source: Source;
  observedAt: Iso;
  ref?: string; // event id, API id, URL
}

// ---------- Market world ----------
/** Production stages of a composite outcome. A world defines its own stage graph. */
export type StageId = string;

export interface Stage {
  id: StageId;
  name: string; // "Print inserts"
  unit: string; // "kits", "inserts", "pallets"
  /** Stages that must finish before this one may start. */
  after: StageId[];
  /** Units of this stage's output needed per unit of final outcome. */
  perOutcome: number;
}

export type ActorKind = 'buyer' | 'supplier' | 'logistics' | 'platform';

export interface Actor {
  id: Id;
  name: string;
  kind: ActorKind;
  city: string;
  /** Free text from the supplier. UNTRUSTED: may contain instructions. Never executed or obeyed. */
  description: string;
  active: boolean;
}

export interface PriceTier {
  minQty: number;
  unit: Money; // price per unit at or above minQty
}

/** Fields a supplier publicly signals it may negotiate. Private limits live in the referee only. */
export type NegotiableField = 'unitPrice' | 'windowEnd' | 'windowStart' | 'capacity' | 'minQty' | 'setupFee' | 'joint';

export interface Offer {
  id: Id;
  version: number;
  actor: Id;
  stage: StageId;
  /** Claimed maximum units this offer can deliver. A claim, not proof. */
  capacity: number;
  minQty: number;
  /** Units produced per working hour once started. */
  ratePerHour: number;
  setupFee: Money;
  tiers: PriceTier[]; // sorted by minQty ascending; first tier minQty is 0 or minQty
  /** The work must happen inside this UTC window. */
  window: { start: Iso; end: Iso };
  /** Hours between finishing and output being available to the next stage (transit, curing). */
  handoffHours: number;
  validUntil: Iso;
  negotiable: NegotiableField[];
  provenance: Provenance;
  /** Ids of claims this offer depends on (capacity, certification, location). */
  claims: Id[];
  /** Set when this offer exists only because of an accepted concession or coalition. */
  derivedFrom?: { concessions: Id[]; coalition?: Id };
}

export interface World {
  id: Id;
  version: number;
  seed: number;
  name: string; // "Promotional kits, Stockholm"
  currency: Currency;
  stages: Stage[];
  actors: Actor[];
  offers: Offer[];
  claims: Claim[];
  /** Generation family, for the referee: 'feasible' | 'salvageable' | 'impossible' | 'flagship'. */
  family: string;
  createdAt: Iso;
}

// ---------- Intent ----------
export interface Intent {
  id: Id;
  text: string; // the user's words
  quantity: number;
  budget: Money; // hard cap on total committed spend
  deadline: Iso; // final stage output must be available by this time
  deliverTo: string;
  /** Things the user said may bend, each needing explicit consent before use. */
  negotiable: { deadlineHours?: number; budgetMinor?: number };
  /** Spending permission is separate from preference. */
  authority: Authority;
  provenance: Provenance;
}

export interface Authority {
  mayNegotiate: boolean; // send binding-pending proposals to suppliers
  mayReserve: boolean; // hold synthetic capacity
  mayPreparePayments: boolean; // create PayPal orders awaiting buyer approval
  maxSpend: Money;
}

// ---------- Solving ----------
export type ConstraintKind =
  | 'demand' // each stage must produce enough
  | 'capacity'
  | 'min-qty'
  | 'window'
  | 'precedence'
  | 'deadline'
  | 'budget'
  | 'exclusive-resource' // the same underlying capacity cannot be sold twice
  | 'validity'; // offer expired

/** Every compiled constraint keeps a typed origin so explanations can cite it. */
export interface ConstraintRef {
  id: Id; // stable, e.g. "deadline", "window:o12", "capacity:o3"
  kind: ConstraintKind;
  subject?: Id; // offer, stage or actor
  text: string; // one plain sentence: "Assembly at Kista Pack must end by Thursday 18:00."
}

export interface Allocation {
  offer: Id;
  actor: Id;
  stage: StageId;
  qty: number;
  start: Iso;
  finish: Iso; // output ready including handoff
  cost: Money;
}

export type SolveStatus = 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error';

export interface SolveReport {
  status: SolveStatus;
  solver: { name: string; version: string; ms: number; gap?: number };
  /** Present when feasible. */
  plan?: Plan;
  /** Present when infeasible: a minimal set of constraint groups that cannot hold together. */
  core?: InfeasibleCore;
}

export interface InfeasibleCore {
  constraints: ConstraintRef[];
  /** 'deletion-filter' = minimal w.r.t. constraint groups (removing any one restores feasibility). */
  method: 'deletion-filter';
  minimal: boolean;
  /** Proven by solver infeasibility status, not a timeout. */
  proven: boolean;
  summary: string; // "No combination can finish assembly before Friday 12:00 within 55,000 kr."
}

export interface Plan {
  id: Id;
  worldVersion: number;
  intent: Id;
  allocations: Allocation[];
  total: Money;
  readyAt: Iso;
  objective: string; // what was minimised
}

/** Independent re-check of a plan, without the solver. */
export interface Verification {
  ok: boolean;
  checks: { id: string; ok: boolean; text: string }[];
}

// ---------- Inverse feasibility ----------
/** A single proposed change to one offer field, or a user-negotiable intent field. */
export interface Concession {
  id: Id;
  target: { kind: 'offer'; offer: Id; field: NegotiableField } | { kind: 'intent'; field: 'deadline' | 'budget' };
  from: number | string;
  to: number | string;
  /** Estimated economic cost of the change to the party granting it (planner's estimate, labelled). */
  estimate: Money;
  rationale: string; // why this change unlocks feasibility
}

export interface Intervention {
  id: Id;
  concessions: Concession[];
  /** Feasibility after applying all concessions, verified by re-solve. */
  unlocks: boolean;
  totalAfter?: Money;
  method: 'elastic-mip' | 'coalition' | 'exhaustive' | 'heuristic';
  /** Proof scope: minimal number of changes / minimal cost under the solver model and stated bounds. */
  minimality: string;
  coalition?: Coalition;
}

/** Several actors jointly create a capability no single offer has. */
export interface Coalition {
  id: Id;
  members: Id[]; // actor ids
  output: { stage: StageId; qty: number };
  /** Hyperedge: inputs consumed from members' offers. */
  inputs: { offer: Id; qty: number }[];
  /** Agreed or proposed split of the coalition's payment. */
  split: { actor: Id; share: Money; reason: string }[];
  /** Each member's outside option estimate and whether the split is individually rational under it. */
  rationality: { actor: Id; outside: Money; ok: boolean }[];
}

// ---------- Negotiation (typed, never free text) ----------
export type NegotiationMessage =
  | { type: 'RequestQuote'; id: Id; from: Id; to: Id; stage: StageId; qty: number; at: Iso }
  | { type: 'AskPreference'; id: Id; from: Id; to: Id; question: Concession; benefit: string; at: Iso }
  | { type: 'Propose'; id: Id; from: Id; to: Id; concession: Concession; conditional?: Id[]; expires: Iso; at: Iso }
  | { type: 'CounterOffer'; id: Id; from: Id; to: Id; replyTo: Id; concession: Concession; expires: Iso; at: Iso }
  | { type: 'Accept'; id: Id; from: Id; to: Id; replyTo: Id; termsHash: string; at: Iso }
  | { type: 'Reject'; id: Id; from: Id; to: Id; replyTo: Id; reason: string; at: Iso }
  | { type: 'Withdraw'; id: Id; from: Id; offer: Id; reason: string; at: Iso }
  | { type: 'Expire'; id: Id; ref: Id; at: Iso };

/** How the supplier's answer was decided. Synthetic answers come from a private policy, never from a model. */
export type DecisionBasis = 'synthetic-policy' | 'seller-terminal';

export interface SupplierDecision {
  message: Id;
  accept: boolean;
  basis: DecisionBasis;
  counter?: Concession;
  reason: string; // public reason only; private limits never leave the policy
}

// ---------- Claims and evidence ----------
export type EvidenceTier = 'verified' | 'corroborated' | 'single-claim' | 'simulation-only';

export interface Claim {
  id: Id;
  actor: Id;
  subject: string; // "capacity:o7", "certified-food-safe"
  assertion: string;
  value?: number;
  tier: EvidenceTier;
  provenance: Provenance;
  expiresAt?: Iso;
  contradictedBy?: Id[]; // other claims or events
}

export interface ClaimFinding {
  claim: Id;
  verdict: 'consistent' | 'contradicted' | 'unverifiable' | 'expired';
  text: string; // cites record ids
}

// ---------- Agreements and obligations ----------
export type AgreementState =
  | 'DRAFT'
  | 'PROPOSED'
  | 'ACCEPTED_BY_PARTIES'
  | 'COMMITTED'
  | 'FULFILLING'
  | 'AMENDED'
  | 'SETTLED'
  | 'CANCELLED';

export type ObligationState = 'PENDING' | 'ACTIVE' | 'AT_RISK' | 'FULFILLED' | 'BREACHED' | 'CANCELLED' | 'REPLACED';

export interface Obligation {
  id: Id;
  agreement: Id;
  actor: Id;
  offer: Id;
  stage: StageId;
  qty: number;
  start: Iso;
  due: Iso;
  amount: Money;
  state: ObligationState;
  /** Amendments are new obligations that replace old ones; originals stay immutable. */
  replaces?: Id;
}

export interface Agreement {
  id: Id;
  version: number;
  intent: Id;
  plan: Id;
  parties: Id[];
  state: AgreementState;
  /** sha256 of canonical terms; acceptance messages sign this exact hash. */
  termsHash: string;
  obligations: Obligation[];
  acceptances: { actor: Id; message: Id; termsHash: string; basis: DecisionBasis | 'buyer' }[];
  createdAt: Iso;
}

// ---------- Payments ----------
export type PaymentState =
  | 'PAYMENT_PROPOSED'
  | 'ORDER_CREATED'
  | 'PAYER_ACTION_REQUIRED'
  | 'APPROVED'
  | 'CAPTURE_PENDING'
  | 'CAPTURE_COMPLETED'
  | 'CAPTURE_DENIED'
  | 'CAPTURE_UNKNOWN'
  | 'VOIDED'
  | 'REFUND_PENDING'
  | 'REFUND_COMPLETED'
  | 'REFUND_DENIED'
  | 'REFUND_UNKNOWN';

export interface PaymentIntent {
  id: Id;
  /** Durable internal key, also sent as PayPal-Request-Id. */
  operationKey: string;
  agreement: Id;
  obligations: Id[];
  payee: Id; // supplier actor in the economic model
  amount: Money; // economic amount
  /** Amount actually sent to PayPal, with any conversion stated. */
  charged: Money;
  fx?: { rate: string; source: string; at: Iso };
  state: PaymentState;
  paypal: PayPalRecord;
}

export interface PayPalRecord {
  env: 'sandbox';
  orderId?: string;
  captureId?: string;
  refunds: { id: string; amount: Money; status: string }[];
  status?: string; // PayPal's own status string, verbatim
  approveUrl?: string;
  lastFetchedAt?: Iso; // independent retrieval time
  debugIds: string[];
}

// ---------- Events (append-only) ----------
export type EventType =
  | 'world.created'
  | 'intent.compiled'
  | 'solve.completed'
  | 'intervention.found'
  | 'negotiation.message'
  | 'negotiation.decision'
  | 'offer.derived'
  | 'claim.challenged'
  | 'agreement.state'
  | 'obligation.state'
  | 'payment.state'
  | 'paypal.webhook'
  | 'disruption.applied'
  | 'recovery.proposed'
  | 'recovery.committed';

export interface MarketEvent<T = unknown> {
  id: Id;
  seq: number;
  market: Id;
  at: Iso;
  type: EventType;
  actor?: Id;
  data: T;
  causes: Id[]; // earlier event ids this one depends on
  source: Source;
}

// ---------- Disruption and recovery ----------
export type DisruptionKind =
  | 'withdraw' // supplier leaves after accepting
  | 'capacity-drop'
  | 'delay'
  | 'price-change'
  | 'claim-overturned'
  | 'payment-failed';

export interface Disruption {
  id: Id;
  kind: DisruptionKind;
  actor?: Id;
  offer?: Id;
  detail: string;
  at: Iso;
}

export interface Recovery {
  id: Id;
  disruption: Id;
  feasible: boolean;
  kept: Id[]; // obligations preserved unchanged
  amended: Id[];
  cancelled: Id[];
  added: Allocation[];
  extraCost: Money;
  slipHours: number;
  /** Plans rejected because they broke accepted commitments, with reasons. */
  rejected: { description: string; reason: string; extraCost?: Money; slipHours?: number }[];
  core?: InfeasibleCore; // when no permissible recovery exists
  concessionsNeeded?: Concession[];
}
