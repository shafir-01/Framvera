import type { Agreement, Id, Iso, MarketEvent, PaymentIntent, Plan, Recovery, Source, World, Intent } from '@framvera/contracts';

/** What GET /api/markets/:id returns. */
export interface Dossier {
  id: Id;
  world: World;
  intent: Intent;
  plans: Plan[];
  agreement: Agreement | null;
  payments: PaymentIntent[];
  recoveries: Recovery[];
}

export interface EvidenceSource {
  readonly label: 'live' | 'fixture';
  dossier(market: Id): Promise<Dossier>;
  events(market: Id): Promise<MarketEvent[]>;
  trace(market: Id, entity: Id): Promise<MarketEvent[]>;
  /** Asks PayPal for the current status of a payment (GET /api/payments/:id). Absent in offline samples. */
  refreshPayment?(payment: Id): Promise<void>;
}

export interface Fact {
  label: string;
  value: string;
  copy?: boolean;
  mono?: boolean;
  tone?: 'ok' | 'bad';
  /** Marks this value as a planner estimate rather than a recorded fact. */
  estimate?: boolean;
}

export interface TraceItem {
  title: string;
  meta?: string;
  source?: Source | 'supplier-policy';
  at?: Iso;
  facts?: Fact[];
  /** An id the viewer may follow to re-trace from it. */
  follow?: Id;
  tone?: 'new' | 'broken';
}

export type NodeSource = Source | 'supplier-policy' | 'planner-estimate';

export interface TraceNode {
  key: string;
  kind: string;
  title: string;
  source: NodeSource;
  at?: Iso;
  ids: { label: string; value: string }[];
  facts: Fact[];
  items: TraceItem[];
  tone?: 'new' | 'broken';
  note?: string;
  events: Id[];
}

export type EntityKind = 'payment' | 'agreement' | 'obligation' | 'offer' | 'claim' | 'actor' | 'disruption' | 'concession' | 'message';

export interface Candidate {
  id: Id;
  kind: EntityKind;
  label: string;
  group: 'Payments' | 'Agreement' | 'Failed or contradicted';
}

export interface Headline {
  title: string;
  changes: { id: Id; text: string; estimate?: string }[];
  caveat: string;
}

export interface Trace {
  entity?: { kind: EntityKind; id: Id; label: string };
  headline?: Headline;
  backward: TraceNode[];
  forward: TraceNode[];
  candidates: Candidate[];
  notFound?: boolean;
}
