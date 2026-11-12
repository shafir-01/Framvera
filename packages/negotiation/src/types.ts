import type {
  Allocation,
  ClaimFinding,
  Coalition,
  Concession,
  Id,
  Intent,
  Intervention,
  Iso,
  Money,
  NegotiableField,
  NegotiationMessage,
  SolveReport,
  SupplierDecision,
  Verification,
  World,
} from '@framvera/contracts';

/** The solver surface negotiation depends on. Injected so the loop can be exercised in isolation. */
export interface SolverApi {
  solve(
    world: World,
    intent: Intent,
    opts?: { fixed?: Allocation[]; objective?: 'cost' | 'repair'; timeLimitMs?: number; explain?: boolean },
  ): Promise<SolveReport>;
  findInterventions(world: World, intent: Intent, opts?: { maxChanges?: number; k?: number }): Promise<Intervention[]>;
  applyConcessions(world: World, intent: Intent, concessions: Concession[]): { world: World; intent: Intent };
  verifyPlan(plan: NonNullable<SolveReport['plan']>, world: World, intent: Intent): Verification;
}

/**
 * The private supplier policy as read by `decide`. Mirrors the market's SupplierPolicy;
 * only the fields below are consulted.
 */
export interface PolicyLike {
  /**
   * Limit per field: unitPrice/setupFee/minQty floors, capacity ceiling, latest windowEnd and earliest
   * windowStart (ISO, or hours relative to the published window), joint: smallest acceptable share in minor units.
   */
  reservation: Partial<Record<NegotiableField, number | string | boolean>>;
  riskTolerance: number;
  outside: Money;
  /** Least extra payment wanted for granting a change to a field (overtime crew, rush handling). */
  premium?: Partial<Record<NegotiableField, Money>>;
  /** Per-offer limits override `reservation` when present. */
  offers?: Record<Id, Partial<Record<NegotiableField, number | string | boolean>>>;
  /** Extra units the supplier can run on overtime above the published capacity. */
  maxOvertimeUnits?: number;
  /** Hours the supplier can extend a window beyond its published end. */
  maxExtensionHours?: number;
}

export interface TruthLike {
  policies: Record<Id, PolicyLike>;
}

export interface Range {
  lo: number;
  mid: number;
  hi: number;
}

export interface AcceptanceEstimate extends Range {
  /** Public signals that produced the estimate, in plain words. */
  signals: string[];
}

export type QuestionMessage = Extract<NegotiationMessage, { type: 'AskPreference' } | { type: 'Propose' }>;

export interface RankedQuestion {
  message: QuestionMessage;
  /** Budget-normalised value per question: feasibility gain + surplus gain / budget. */
  voi: number;
  voiRange: { lo: number; hi: number };
  pAccept: AcceptanceEstimate;
  /** Expected increase in P(feasible plan) attributed to this question. */
  feasibilityGain: number;
  /** Expected buyer surplus (budget minus plan total) attributed to this question. */
  surplusGain: Money;
  /** Questions that must all be accepted together; conditional proposals reference each other. */
  group: Id;
  groupSize: number;
  intervention: Id;
  concession: Concession;
  /** True when the answer must come from the buyer (deadline or budget flex), not a supplier. */
  buyerQuestion: boolean;
  benefit: string;
}

export interface FeasibleSet {
  keys: string[];
  concessions: Concession[];
  total: Money;
  source: 'intervention' | 'reject-probe' | 'counter-probe';
  intervention: Id;
}

export interface OutcomeModel {
  feasibleSets: FeasibleSet[];
  infeasibleKeys: string[][];
  solves: number;
  ms: number;
}

export interface MessageText {
  message: Id;
  text: string;
  source: 'template' | 'model-proposal';
}

export type NegotiationOutcome =
  | 'feasible'
  | 'already-feasible'
  | 'no-interventions'
  | 'budget-exhausted'
  | 'needs-buyer-consent'
  | 'refused'
  | 'unverified';

export interface NegotiationRun {
  id: Id;
  worldId: Id;
  worldVersionBefore: number;
  intent: Id;
  outcome: NegotiationOutcome;
  queryBudget: number;
  queriesUsed: number;
  interventions: Intervention[];
  outcomeModel: Pick<OutcomeModel, 'solves' | 'ms'> & { feasibleSets: number };
  /** The ranked plan of questions at the start of the run. */
  questions: RankedQuestion[];
  messages: NegotiationMessage[];
  decisions: SupplierDecision[];
  texts: MessageText[];
  /** Every binding change, including overtime charges added by supplier counters. */
  accepted: Concession[];
  rejected: Concession[];
  /** Coalitions joined through accepted joint changes, with the split the members accepted. */
  coalitions: Coalition[];
  /** Deadline or budget changes the buyer must approve before they can be used. */
  pendingBuyerQuestions: RankedQuestion[];
  before: SolveReport;
  after?: SolveReport;
  verification?: Verification;
  world?: World;
  intentAfter?: Intent;
  startedAt: Iso;
  finishedAt: Iso;
}

export interface ClaimFindingDetail extends ClaimFinding {
  kind: 'double-booked' | 'expired' | 'fee-excluded' | 'contradicted' | 'injection' | 'single-claim' | 'consistent';
  records: Id[];
}
