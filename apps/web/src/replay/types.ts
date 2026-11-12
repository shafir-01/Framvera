import type { Agreement, Id, MarketEvent, PaymentIntent, Recovery, World } from '@framvera/contracts';
import type { Api } from '../api.ts';

/** The slice of the client the replay needs. */
export type ReplayApi = Pick<Api, 'events' | 'subscribe' | 'payment'>;

export interface ReplayProps {
  market: Id;
  api: ReplayApi;
  /** Names and offers shown at each point. Without it, parties appear by id. */
  world?: World;
  /** When given, used instead of fetching the log. */
  events?: MarketEvent[];
  /** Enriches obligation rows with quantity and amount. */
  agreement?: Agreement;
  /** Fallback source for the recovery comparison when the log carries only a summary. */
  recovery?: { recovery: Recovery; agreement?: Agreement };
  /** Last known payment records. */
  payments?: PaymentIntent[];
}
