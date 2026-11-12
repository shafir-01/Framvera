// Development fixture only. Serves raw API bodies through the real client adapter. Never reachable from a production build.
import type { MarketEvent, PaymentIntent } from '@framvera/contracts';
import { httpApi, type Api } from '../api.ts';
import { fxAgreement, fxAnalyze, fxDisrupt, fxEvents, fxInvent, fxMarket, fxNegotiate, fxPayment, fxRecover, fxStatus } from './fixture.ts';

type Stage = Parameters<typeof fxEvents>[0];

export function fixtureApi(): Api {
  let stage: Stage = 'market';
  const payments = new Map<string, PaymentIntent>();
  const listeners = new Set<(e: MarketEvent) => void>();
  const paypalOn = new URLSearchParams(location.search).has('paypal');
  const fail = new URLSearchParams(location.search).get('fail');

  const advance = (s: Stage) => {
    const before = fxEvents(stage).length;
    stage = s;
    for (const e of fxEvents(stage).slice(before)) listeners.forEach((l) => l(e));
  };

  const route = async (method: string, path: string, body: any): Promise<[number, unknown, number]> => {
    if (fail && path.includes(fail)) return [503, { error: { code: 'unavailable', message: 'The solver is not available on this server' } }, 400];
    if (path === '/api/status') return [200, { ...fxStatus, services: { ...fxStatus.services, paypalConfigured: paypalOn } }, 150];
    if (method === 'POST' && path === '/api/markets') {
      stage = 'market';
      payments.clear();
      return [201, fxMarket, 400];
    }
    if (path === '/api/intents/compile') return [200, { intent: { ...fxMarket.intent, text: body.text, budget: body.budget ?? fxMarket.intent.budget, deadline: body.deadline ?? fxMarket.intent.deadline }, questions: [], model: 'deterministic', live: false }, 300];
    if (path.endsWith('/analyze')) return (advance('analyze'), [200, fxAnalyze, 900]);
    if (path.endsWith('/invent')) return [200, fxInvent, 1100];
    if (path.endsWith('/negotiate')) return (advance('negotiate'), [200, fxNegotiate, 1600]);
    if (path.endsWith('/verify')) return [200, fxNegotiate.verification, 300];
    if (path.endsWith('/commit')) return (advance('commit'), [201, fxAgreement, 700]);
    if (path.endsWith('/approve-payment')) {
      if (!paypalOn) return [503, { error: { code: 'payments_unconfigured', message: 'Payments are not configured on this server' } }, 200];
      return [200, { approvalToken: `tok:${body.payee}`, expiresAt: new Date(Date.now() + 900_000).toISOString(), amount: body.amount }, 300];
    }
    if (path === '/api/payments/orders') {
      const payee = String(body.approvalToken).slice(4);
      const id = `pay-${payee.slice(2)}`;
      const pi = fxPayment(id, payee, 'PAYER_ACTION_REQUIRED');
      payments.set(id, pi);
      return [201, pi, 700];
    }
    const pm = path.match(/^\/api\/payments\/([^/]+)(?:\/(capture|approve-refund|refund))?$/);
    if (pm) {
      const pi = payments.get(pm[1]!);
      if (!pi) return [404, { error: { code: 'not_found', message: 'Payment not found' } }, 100];
      if (pm[2] === 'capture') {
        const next = fxPayment(pi.id, pi.payee, 'CAPTURE_COMPLETED');
        payments.set(pi.id, next);
        advance('pay');
        return [200, next, 900];
      }
      if (pm[2] === 'approve-refund') return [200, { approvalToken: `ref:${pi.id}`, amount: pi.charged }, 200];
      if (pm[2] === 'refund') {
        const next = fxPayment(pi.id, pi.payee, 'REFUND_COMPLETED', true);
        payments.set(pi.id, next);
        return [200, next, 900];
      }
      return [200, { ...pi, paypal: { ...pi.paypal, lastFetchedAt: new Date().toISOString() } }, 500];
    }
    if (path.endsWith('/disrupt')) return [200, fxDisrupt, 700];
    if (path.endsWith('/recover')) return (advance('recover'), [200, fxRecover, 1400]);
    const tm = path.match(/\/trace\/([^/]+)$/);
    if (tm) {
      const entity = decodeURIComponent(tm[1]!);
      return [200, { entity, events: fxEvents(stage).filter((e) => e.actor === entity || JSON.stringify(e.data).includes(entity)) }, 300];
    }
    if (method === 'GET' && /^\/api\/markets\/[^/]+$/.test(path)) return [200, { ...fxMarket, plans: [], agreement: stage === 'market' ? null : fxAgreement, payments: [...payments.values()], recoveries: [] }, 300];
    return [404, { error: { code: 'not_found', message: 'Unknown endpoint' } }, 50];
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const [status, data, ms] = await route(init?.method ?? 'GET', url.pathname, body);
    await new Promise((r) => setTimeout(r, ms));
    return new Response(JSON.stringify(structuredClone(data)), { status, headers: { 'content-type': 'application/json' } });
  };

  const api = httpApi('', {
    fetch: fakeFetch,
    subscribe: (_url, onEvent, onReady) => {
      for (const e of fxEvents(stage)) onEvent(e);
      onReady?.();
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
  });
  return { ...api, mode: 'fixture' };
}
