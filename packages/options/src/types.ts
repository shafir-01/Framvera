import type {
  Agreement,
  Allocation,
  DecisionBasis,
  EvidenceTier,
  Id,
  Iso,
  Money,
  NegotiationMessage,
  Obligation,
  Plan,
  Recovery,
  StageId,
  SupplierDecision,
  Verification,
  World,
  Disruption,
} from '@framvera/contracts';

export type FailureMode = 'withdraw' | 'capacity-drop' | 'delay';

/** One source of failure risk behind an obligation. Probabilities are planner estimates. */
export interface RiskFactor {
  kind: 'reliability' | 'claim';
  ref?: Id;
  tier: EvidenceTier | 'undeclared';
  mode: FailureMode;
  p: number;
  text: string;
}

export interface ObligationRisk {
  obligation: Id;
  actor: Id;
  offer: Id;
  stage: StageId;
  amount: Money;
  reliability: { declared?: number; tier: EvidenceTier | 'undeclared'; effective: number; claim?: Id };
  factors: RiskFactor[];
  /** Probability of each first failure mode; they sum to pFail. Independence across factors is assumed. */
  modes: Record<FailureMode, number>;
  pFail: number;
  label: 'planner-estimate';
}

/** Contingent standby terms: capacity held now for a fee, delivered at the strike price only if called before expiry. */
export interface StandbyTerms {
  option: Id;
  buyer: Id;
  supplier: Id;
  offer: Id;
  stage: StageId;
  /** Committed obligations this standby backs. */
  covers: Id[];
  qty: number;
  minExercise: number;
  /** Paid when both parties accept; kept by the supplier whether or not the option is exercised. */
  fee: Money;
  /** Unit price if exercised. */
  strikeUnit: Money;
  /** The supplier's published setup fee, charged on exercise. */
  setupFee: Money;
  window: { start: Iso; end: Iso };
  ratePerHour: number;
  handoffHours: number;
  /** The exercise notice must arrive by this time. */
  expires: Iso;
}

export type StandbyMessage =
  | { type: 'RequestStandby'; id: Id; from: Id; to: Id; terms: StandbyTerms; termsHash: string; expires: Iso; at: Iso }
  | { type: 'CounterStandby'; id: Id; from: Id; to: Id; replyTo: Id; terms: StandbyTerms; termsHash: string; expires: Iso; at: Iso }
  | { type: 'ExerciseStandby'; id: Id; from: Id; to: Id; option: Id; termsHash: string; qty: number; replaces: Id; at: Iso }
  | Extract<NegotiationMessage, { type: 'Accept' } | { type: 'Reject' }>;

export type RequestStandby = Extract<StandbyMessage, { type: 'RequestStandby' }>;

export interface StandbyDecision extends Omit<SupplierDecision, 'counter'> {
  counter?: StandbyTerms;
}

export type OptionStatus = 'quoted' | 'purchased' | 'lapsed' | 'exercised';

/** A standby option. Binding only once both parties accepted the exact terms hash and its agreement is COMMITTED. */
export interface StandbyOption {
  id: Id;
  status: OptionStatus;
  terms: StandbyTerms;
  termsHash: string;
  basis: DecisionBasis;
  /** The option's own agreement: one hold obligation whose amount is the fee and whose due time is the expiry. */
  agreement: Agreement;
  messages: StandbyMessage[];
  decisions: StandbyDecision[];
  /** Independent check that exercising at the latest failure time keeps every other obligation unchanged. */
  check: Verification;
  exerciseCost: Money;
  /** Latest time the backed obligation could fail and still be replaced by this option. */
  latestFailure: Iso;
  readyBy: Iso;
  needBy: Iso;
}

export interface Declined {
  obligation: Id;
  offer: Id;
  actor: Id;
  reason: string;
  messages: StandbyMessage[];
  decisions: StandbyDecision[];
}

export interface Discovery {
  risks: ObligationRisk[];
  targets: Id[];
  options: StandbyOption[];
  declined: Declined[];
  /** Backups that could not replace the obligation in time, with the reason. */
  unsuitable: { obligation: Id; offer: Id; reason: string }[];
}

export interface LossStats {
  expected: Money;
  /** 95% interval for the expected loss from the sample standard error. */
  ci95: [Money, Money];
  var90: Money;
  /** Mean of the worst 10% of scenarios; null when fewer than 10 scenarios fall in the tail. */
  cvar90: Money | null;
  pMiss: number;
  pDisrupted: number;
}

export interface OptionValue {
  option: Id;
  fee: Money;
  /** Expected loss avoided when this option is held alone. */
  avoided: Money;
  avoidedCi95: [Money, Money];
  net: Money;
  /** Expected loss avoided on top of the options bought before it. */
  marginal?: Money;
  buy: boolean;
  reason: string;
}

export interface Valuation {
  label: 'planner-estimate';
  seed: number;
  scenarios: number;
  assumptions: ValueAssumptions;
  baseline: LossStats;
  withOptions: LossStats;
  options: OptionValue[];
  buy: Id[];
  fees: Money;
  budget: Money;
  solves: number;
  ms: number;
}

export interface ValueAssumptions {
  /** Loss when no recovery meets the deadline: the buyer's budget unless given. */
  lossOnMiss: Money;
  /** Chance an unreserved backup still has room when a failure surfaces. */
  availability: number;
  /** Unit price surcharges for last-minute purchases, sampled uniformly. */
  rushPremiums: number[];
  /** Hours of notice before the obligation's start, sampled uniformly. */
  noticeHours: number[];
  delayHours: number[];
  /** Share of the obligation a supplier can still make after a capacity drop. */
  capacityShares: number[];
}

export interface ExerciseAttempt {
  option: Id;
  obligation: Id;
  ok: boolean;
  reason: string;
}

/** The parts of an option the exercise check needs; quotes under evaluation and purchased options both qualify. */
export type OptionLike = Pick<StandbyOption, 'id' | 'terms' | 'basis'>;

export interface ExercisePlan {
  ok: boolean;
  picks: { obligation: Obligation; option: Id; terms: StandbyTerms; allocation: Allocation }[];
  world: World;
  plan?: Plan;
  verification?: Verification;
  attempts: ExerciseAttempt[];
}

export interface Exercise {
  exercised: boolean;
  /** Nothing needs replacing: no obligation failed, or a delay leaves the rest of the plan valid. */
  absorbed: boolean;
  reason: string;
  recovery?: Recovery;
  replacements: { replaces: Id; allocation: Allocation }[];
  amendment?: Agreement;
  notices: StandbyMessage[];
  options: StandbyOption[];
  world: World;
  plan?: Plan;
  verification?: Verification;
  attempts: ExerciseAttempt[];
}

export type DisturbanceOutcome = 'absorbed' | 'option' | 'uncovered';

export interface Disturbance {
  disruption: Disruption;
  obligation: Id;
  outcome: DisturbanceOutcome;
  option?: Id;
  /** Without options: whether a full re-plan from published offers could still meet the deadline. */
  recoverable?: boolean;
  text: string;
}

export interface Robustness {
  /** Every disturbance in the family leaves the plan valid unchanged or valid again by exercising purchased options alone. */
  robustFeasible: boolean;
  /** The same condition with no options. */
  robustWithoutOptions: boolean;
  family: string;
  covered: number;
  total: number;
  disturbances: Disturbance[];
}
