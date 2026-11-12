import { createHash } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { loadEngine, type Engine } from '../src/engine.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (h: number) => new Date(Date.UTC(2026, 10, 20, h)).toISOString();
const money = (minor: number) => ({ currency: 'SEK' as const, minor });

/** Deterministic stand-ins so the API contract is testable while sibling modules evolve. */
export function stubEngine(): Engine {
  const world = (v = 1) => ({
    id: 'w1', version: v, seed: 1, name: 'Kits', currency: 'SEK', stages: [], actors: [{ id: 'a1', name: 'Print AB' }, { id: 'a2', name: 'Pack AB' }],
    offers: [], claims: [], family: 'flagship', createdAt: iso(0),
  });
  const intent = {
    id: 'i1', text: '500 kits', quantity: 500, budget: money(5_500_000), deadline: iso(18), deliverTo: 'Kista', negotiable: {},
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: money(5_500_000) },
    provenance: { source: 'buyer', observedAt: iso(0) },
  };
  const plan = { id: 'p1', worldVersion: 2, intent: 'i1', allocations: [], total: money(5_430_000), readyAt: iso(17), objective: 'cost' };
  const hash = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
  return {
    flagshipWorld: () => ({ world: world() as any, intent: intent as any, truth: {} }),
    generateWorld: () => ({ world: world() as any, intent: intent as any, truth: {} }),
    solve: async (w: any) => (w.version >= 2
      ? { status: 'optimal', solver: { name: 'stub', version: '1', ms: 1 }, plan }
      : { status: 'infeasible', solver: { name: 'stub', version: '1', ms: 1 }, core: { constraints: [], method: 'deletion-filter', minimal: true, proven: true, summary: 'No combination fits.' } }),
    findInterventions: async () => [{ id: 'iv1', concessions: [], unlocks: true, method: 'elastic-mip', minimality: 'stub' }],
    negotiate: async (w: any) => ({
      world: { ...w, version: 2 }, plan, messages: [{ id: 'm1', type: 'Propose' }],
      decisions: [{ message: 'm1', accept: true, basis: 'synthetic-policy', reason: 'ok' }],
    }),
    verifyPlan: () => ({ ok: true, checks: [{ id: 'budget', ok: true, text: 'within budget' }] }),
    commit: (p: any) => {
      const obligations = [
        { id: 'o1', agreement: 'ag1', actor: 'a1', offer: 'x', stage: 's', qty: 500, start: iso(1), due: iso(9), amount: money(3_000_000), state: 'PENDING' },
        { id: 'o2', agreement: 'ag1', actor: 'a2', offer: 'y', stage: 't', qty: 500, start: iso(9), due: iso(17), amount: money(2_430_000), state: 'PENDING' },
      ];
      return { id: 'ag1', version: 1, intent: 'i1', plan: p.id, parties: ['a1', 'a2'], state: 'COMMITTED', termsHash: hash(obligations), obligations, acceptances: [], createdAt: iso(1) };
    },
    disrupt: (_a: any, w: any) => ({ affected: [{ id: 'o1' }], world: w }),
    recover: async (_a: any, _w: any, _i: any, d: any) => ({ id: 'r1', disruption: d.id, feasible: true, kept: ['o2'], amended: [], cancelled: ['o1'], added: [], extraCost: money(10_000), slipHours: 0, rejected: [] }),
  };
}

/** Minimal PayPal stand-in in the record shape the payments module reads (order and capture status verbatim). */
export class TestGateway {
  orders = new Map<string, any>();
  created = 0;
  async createOrder(pi: any) {
    this.created += 1;
    const id = `ORD-${this.created}`;
    const rec = { env: 'sandbox', orderId: id, refunds: [], status: 'PAYER_ACTION_REQUIRED', orderStatus: 'PAYER_ACTION_REQUIRED', approveUrl: `https://sandbox.paypal.test/${id}`, debugIds: [] };
    this.orders.set(id, rec);
    return { ...pi.paypal, ...rec };
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o.captureId ? { ...o } : { ...o, status: 'APPROVED', orderStatus: 'APPROVED' };
  }
  async capture(pi: any) {
    const rec = { ...this.orders.get(pi.paypal.orderId), status: 'COMPLETED', orderStatus: 'COMPLETED', captureStatus: 'COMPLETED', captureId: `CAP-${pi.paypal.orderId}`, captured: pi.charged };
    this.orders.set(pi.paypal.orderId, rec);
    return { ...pi.paypal, ...rec };
  }
  async refund(pi: any, amount: any) {
    return { ...pi.paypal, refunds: [...pi.paypal.refunds, { id: `RF-${pi.paypal.refunds.length + 1}`, amount, status: 'COMPLETED' }] };
  }
  async verifyWebhook(headers: Record<string, string>) {
    return headers['x-test-sig'] === 'valid';
  }
}

export async function realEngineReady() {
  const e = await loadEngine();
  const ok = ['createMarket', 'solve', 'findInterventions', 'negotiate', 'verifyPlan', 'commit', 'sign', 'disrupt', 'recover', 'FakeGateway'].every((k) => typeof (e as any)[k] === 'function');
  return { engine: e, ok };
}

export function makeApp(engine: Engine, gateway: any = new TestGateway(), cfg: Parameters<typeof loadConfig>[1] = {}) {
  return createApp({ engine, gateway, dataDir: ':memory:', config: loadConfig({}, { rateLimitPerMin: 10_000, heavyLimitPerMin: 10_000, ...cfg }) });
}

export const post = (app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, url: string, data: unknown = {}, headers: Record<string, string> = {}) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
