import type {
  Actor, Concession, Disruption, Intent, Intervention, Money, NegotiationMessage, Plan, Recovery,
  SolveReport, SupplierDecision, Verification, World, Agreement, Obligation, ClaimFinding,
} from '@framvera/contracts';

export type Family = 'feasible' | 'salvageable' | 'impossible';

/** Structural view of the market module's hidden truth. Held only by the referee. */
export interface HiddenTruthLike {
  policies: Record<string, unknown>;
  realCapacity: Record<string, number>;
  shocks: Disruption[];
}

export interface Generated {
  world: World;
  intent: Intent;
  truth: HiddenTruthLike;
}

export interface Deps {
  market: {
    generateWorld(seed: number, family: Family): Generated;
    flagshipWorld(): Generated;
  };
  solver: {
    solve(world: World, intent: Intent, opts?: { fixed?: unknown[]; objective?: 'cost' | 'repair'; timeLimitMs?: number }): Promise<SolveReport>;
    findInterventions(world: World, intent: Intent, opts?: { maxChanges?: number; k?: number }): Promise<Intervention[]>;
    applyConcessions(world: World, intent: Intent, concessions: Concession[]): { world: World; intent: Intent };
    verifyPlan(plan: Plan, world: World, intent: Intent): Verification;
  };
  negotiation: {
    selectQuestions(world: World, intent: Intent, interventions: Intervention[], budget: number): { message: NegotiationMessage; voi: number }[];
    decide(msg: NegotiationMessage, policy: unknown, world: World): SupplierDecision;
    challengeClaims(world: World, plan: Plan): ClaimFinding[];
  };
  obligations: {
    commit(plan: Plan, intent: Intent, decisions: SupplierDecision[]): Agreement;
    disrupt(agreement: Agreement, world: World, d: Disruption): { affected: Obligation[]; world: World };
    recover(agreement: Agreement, world: World, intent: Intent, d: Disruption): Promise<Recovery>;
  };
}

export type StrategyId =
  | 'direct' | 'optimizer' | 'uniform-heuristic' | 'random-relaxations'
  | 'framvera' | 'framvera-no-coalitions' | 'framvera-no-voi' | 'framvera-no-claim-checks'
  | 'oracle' | 'agent-harness';

export const STRATEGIES: StrategyId[] = [
  'direct', 'optimizer', 'uniform-heuristic', 'random-relaxations',
  'framvera', 'framvera-no-coalitions', 'framvera-no-voi', 'framvera-no-claim-checks', 'oracle',
];

/** Strategies that call a live model; never part of the default run. */
export const MODEL_STRATEGIES: StrategyId[] = ['agent-harness'];

export interface Outcome {
  claimed: boolean;
  plan?: Plan;
  world: World;
  intent: Intent;
  questions: number;
  accepted: number;
  decisions: SupplierDecision[];
  solveMs: number;
  notes: string[];
}

export interface RunRecord {
  seed: number;
  family: Family;
  strategy: StrategyId;
  initialStatus: string;
  claimed: boolean;
  trulyFeasible: boolean;
  falseClaim: boolean;
  falseReasons: string[];
  invariantViolations: string[];
  questions: number;
  accepted: number;
  costMinor: number | null;
  oracleCostMinor: number | null;
  recovery: { attempted: boolean; success: boolean; affected: number; note?: string } | null;
  solveMs: number;
  wallMs: number;
  hindsight: boolean;
  error?: string;
  notes: string[];
}

export type { Money, Actor };
