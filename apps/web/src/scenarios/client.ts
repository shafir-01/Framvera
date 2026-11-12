import type { Id, Intent, World } from '@framvera/contracts';
import type { ScenarioClient } from './types.ts';

interface RawMarket {
  market?: Id;
  id?: Id;
  world: World;
  intent: Intent;
}

export function httpClient(base = ''): ScenarioClient {
  const root = base.replace(/\/$/, '');
  async function post<T>(path: string, body: unknown, timeoutMs = 60000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(root + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw new Error('The service sent an unreadable answer.');
      }
      if (!res.ok) {
        const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status}).`;
        throw new Error(msg);
      }
      return data as T;
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error('The service took too long to answer.');
      if (err instanceof TypeError) throw new Error('The service is not reachable.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  const enc = encodeURIComponent;
  return {
    async start(req) {
      const body = req.template === 'flagship' ? { flagship: true, template: 'flagship' } : req;
      const r = await post<RawMarket>('/api/markets', body);
      const market = r.market ?? r.id;
      if (!market) throw new Error('The service did not return a market.');
      return { market, world: r.world, intent: r.intent };
    },
    analyze: (market, intent) => post(`/api/markets/${enc(market)}/analyze`, { intent }),
    invent: (market, intent) => post(`/api/markets/${enc(market)}/invent`, { intent }),
    negotiate: (market, intent) => post(`/api/markets/${enc(market)}/negotiate`, { intent }, 90000),
  };
}
