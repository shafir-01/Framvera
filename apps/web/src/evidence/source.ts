import type { Id, MarketEvent } from '@framvera/contracts';
import type { Dossier, EvidenceSource } from './types.ts';

async function get<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new Error('The service is not reachable.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error('The service sent an unreadable answer.');
  }
  if (!res.ok) throw new Error(data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status}).`);
  return data as T;
}

export function httpEvidenceSource(base = ''): EvidenceSource {
  const root = base.replace(/\/$/, '');
  const enc = encodeURIComponent;
  return {
    label: 'live',
    async dossier(market: Id) {
      const r = await get<Partial<Dossier>>(`${root}/api/markets/${enc(market)}`);
      if (!r.world || !r.intent) throw new Error('The market record is incomplete.');
      return { id: r.id ?? market, world: r.world, intent: r.intent, plans: r.plans ?? [], agreement: r.agreement ?? null, payments: r.payments ?? [], recoveries: r.recoveries ?? [] };
    },
    async events(market: Id) {
      const r = await get<{ events: MarketEvent[] } | MarketEvent[]>(`${root}/api/markets/${enc(market)}/events?format=json`);
      return Array.isArray(r) ? r : r.events;
    },
    async trace(market: Id, entity: Id) {
      return (await get<{ events: MarketEvent[] }>(`${root}/api/markets/${enc(market)}/trace/${enc(entity)}`)).events;
    },
    async refreshPayment(payment: Id) {
      await get<unknown>(`${root}/api/payments/${enc(payment)}`);
    },
  };
}
