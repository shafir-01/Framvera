import type { Agreement, ConstraintRef, Id, Intent, MarketEvent, PaymentIntent, SolveReport, World } from '@framvera/contracts';
import type { InventResult, NegotiateResult, ObservatoryProps } from '../api.ts';

export type TabId = 'offers' | 'coalitions' | 'questions' | 'claims' | 'payments';

/** Everything the observatory reads, normalised from the props the web app passes. */
export interface ObservatoryMarket {
  market: Id;
  world: World;
  intent?: Intent;
  /** Blocking constraints from the infeasibility core, when the market was analysed. */
  core: ConstraintRef[];
  invention?: InventResult;
  negotiation?: NegotiateResult;
  agreement?: Agreement;
  payments: PaymentIntent[];
  events: MarketEvent[];
}

function coreFromEvents(events: MarketEvent[]): ConstraintRef[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'solve.completed') continue;
    const d = e.data as { core?: { constraints?: ConstraintRef[] }; report?: SolveReport } | undefined;
    const c = d?.core?.constraints ?? d?.report?.core?.constraints;
    if (c?.length) return c;
  }
  return [];
}

export function toMarket(p: ObservatoryProps): ObservatoryMarket {
  const payments = [...p.payments];
  for (const o of p.recovery?.recovery.payments?.orders ?? []) if (!payments.some((x) => x.id === o.id)) payments.push(o);
  return {
    market: p.market,
    world: p.world,
    intent: p.intent ?? p.negotiation?.intent,
    core: p.negotiation?.before?.core?.constraints ?? coreFromEvents(p.events),
    invention: p.invention,
    negotiation: p.negotiation,
    agreement: p.recovery?.agreement ?? p.agreement,
    payments,
    events: p.events,
  };
}
