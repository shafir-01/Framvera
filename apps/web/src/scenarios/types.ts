import type { Concession, Id, Intent, Intervention, SolveReport, Verification, World } from '@framvera/contracts';

export type TemplateId = 'flagship' | 'exhibition' | 'circular' | 'unseen';
export type Family = 'feasible' | 'salvageable' | 'impossible';

export interface StartRequest {
  template?: TemplateId;
  seed?: number;
  family?: Family;
}

export interface StartedMarket {
  market: Id;
  world: World;
  intent: Intent;
}

export interface Started extends StartedMarket {
  template: TemplateId;
  seed?: number;
}

export interface AnalyzeOut {
  report: SolveReport;
}

export interface InventOut {
  interventions: Intervention[];
}

export interface NegotiateOut {
  accepted: Concession[];
  report: SolveReport;
  verification: Verification;
  intervention?: Intervention;
}

export interface ScenarioClient {
  start(req: StartRequest): Promise<StartedMarket>;
  analyze(market: Id, intent: Intent): Promise<AnalyzeOut>;
  invent(market: Id, intent: Intent): Promise<InventOut>;
  negotiate(market: Id, intent: Intent): Promise<NegotiateOut>;
}

export type Outcome =
  | { kind: 'feasible' }
  | { kind: 'made-possible'; changes: number }
  | { kind: 'declined'; changes: number }
  | { kind: 'impossible'; summary: string; reasons: string[]; smallest: boolean }
  | { kind: 'unsolved'; reason: string };

export interface ScenarioGalleryProps {
  /** Called as soon as a real market exists for the chosen card. */
  onPick: (picked: Started) => void;
  /** Solve each started market here and show the result line. Default true. */
  runSolve?: boolean;
  /** Replace the HTTP client (tests, offline fixture). */
  client?: ScenarioClient;
}
