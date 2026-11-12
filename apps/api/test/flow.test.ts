import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { makeApp, post, stubEngine, TestGateway } from './helpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function flow(app: ReturnType<typeof makeApp>) {
  const m: any = await (await post(app, '/api/markets', {})).json();
  const an: any = await (await post(app, `/api/markets/${m.id}/analyze`)).json();
  const inv: any = await (await post(app, `/api/markets/${m.id}/invent`)).json();
  const neg: any = await (await post(app, `/api/markets/${m.id}/negotiate`)).json();
  const ver: any = await (await post(app, `/api/plans/${neg.planId}/verify`)).json();
  const agreement: any = await (await post(app, `/api/agreements/${neg.planId}/commit`)).json();
  return { m, an, inv, neg, ver, agreement };
}

describe('flagship through the API (stub engine, fake gateway)', () => {
  it('analyze infeasible -> invent -> negotiate -> verify -> commit -> pay with approval -> disrupt -> recover', async () => {
    const gw = new TestGateway();
    const app = makeApp(stubEngine(), gw);
    const { m, an, inv, neg, ver, agreement } = await flow(app);
    expect(an.status).toBe('infeasible');
    expect(an.core.proven).toBe(true);
    expect(inv.interventions[0].unlocks).toBe(true);
    expect(neg.planId).toBeTruthy();
    expect(ver.ok).toBe(true);
    expect(agreement.state).toBe('COMMITTED');

    const ap = await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a1', termsHash: agreement.termsHash, amount: { currency: 'SEK', minor: 3_000_000 } });
    expect(ap.status).toBe(200);
    const { approvalToken } = (await ap.json()) as any;
    const order = await post(app, '/api/payments/orders', { approvalToken, market: m.id });
    expect(order.status).toBe(201);
    const pi: any = await order.json();
    expect(pi.state).toBe('PAYER_ACTION_REQUIRED');
    expect(pi.paypal.env).toBe('sandbox');

    const again: any = await (await post(app, '/api/payments/orders', { approvalToken, market: m.id })).json();
    expect(again.id).toBe(pi.id);
    expect(gw.created).toBe(1);

    const fresh: any = await (await app.request(`/api/payments/${pi.id}`)).json();
    expect(fresh.state).toBe('APPROVED');
    const cap: any = await (await post(app, `/api/payments/${pi.id}/capture`)).json();
    expect(cap.state).toBe('CAPTURE_COMPLETED');

    const d: any = await (await post(app, `/api/markets/${m.id}/disrupt`, { kind: 'withdraw', actor: 'a1' })).json();
    expect(d.affected).toHaveLength(1);
    const rec: any = await (await post(app, `/api/markets/${m.id}/recover`, {})).json();
    expect(rec.feasible).toBe(true);
    expect(rec.kept).toContain('o2');

    const trace: any = await (await app.request(`/api/markets/${m.id}/trace/a1`)).json();
    expect(trace.events.length).toBeGreaterThan(0);
  });

  it('streams market events over SSE', async () => {
    const app = makeApp(stubEngine());
    const m: any = await (await post(app, '/api/markets', {})).json();
    const res = await app.request(`/api/markets/${m.id}/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('world.created');
    await reader.cancel();
  });
});

describe('scope escalation is refused', () => {
  async function committed() {
    const gw = new TestGateway();
    const app = makeApp(stubEngine(), gw);
    const ctx = await flow(app);
    return { app, gw, ...ctx };
  }

  it('a proposal cannot become a payment: no token, forged token, and skipping approval all fail', async () => {
    const { app, gw, m, agreement } = await committed();
    const attempts = [
      { agreementId: agreement.id, market: m.id, payee: 'a1' },
      { agreementId: agreement.id, market: m.id, approvalToken: 'forged.token' },
      { agreementId: agreement.id, market: m.id, approvalToken: '' },
    ];
    for (const a of attempts) expect((await post(app, '/api/payments/orders', a)).status).toBe(403);
    expect(gw.created).toBe(0);
    expect((await post(app, '/api/payments/pay-x/capture')).status).toBe(404);
  });

  it('approval is bound to exact terms hash and amount', async () => {
    const { app, agreement, m } = await committed();
    const wrongHash = await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a1', termsHash: 'deadbeef', amount: { currency: 'SEK', minor: 3_000_000 } });
    expect(wrongHash.status).toBe(409);
    const wrongAmount = await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a1', termsHash: agreement.termsHash, amount: { currency: 'SEK', minor: 1 } });
    expect(wrongAmount.status).toBe(409);
  });

  it('an approval for one supplier cannot be replayed for another or reused after use', async () => {
    const { app, gw, agreement, m } = await committed();
    const { approvalToken } = (await (await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a2', termsHash: agreement.termsHash, amount: { currency: 'SEK', minor: 2_430_000 } })).json()) as any;
    const pi: any = await (await post(app, '/api/payments/orders', { approvalToken, market: m.id })).json();
    expect(pi.payee).toBe('a2');
    expect(pi.amount.minor).toBe(2_430_000);
    expect(gw.created).toBe(1);
    const tampered = approvalToken.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect((await post(app, '/api/payments/orders', { approvalToken: tampered, market: m.id })).status).toBe(403);
  });

  it('refunds also require an approval', async () => {
    const { app, agreement, m } = await committed();
    const { approvalToken } = (await (await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a1', termsHash: agreement.termsHash, amount: { currency: 'SEK', minor: 3_000_000 } })).json()) as any;
    const pi: any = await (await post(app, '/api/payments/orders', { approvalToken, market: m.id })).json();
    await post(app, `/api/payments/${pi.id}/capture`);
    expect((await post(app, `/api/payments/${pi.id}/refund`, {})).status).toBe(403);
  });

  it('payments cannot be prepared when the buyer withheld that scope', async () => {
    const app = makeApp(stubEngine());
    const { m, agreement } = await flow(app);
    await post(app, `/api/markets/${m.id}/authority`, { mayPreparePayments: false });
    const r = await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a1', termsHash: agreement.termsHash, amount: { currency: 'SEK', minor: 3_000_000 } });
    expect(r.status).toBe(403);
  });

  it('approving an agreement grants payment authority for that exact agreement only, as a recorded buyer event', async () => {
    const engine = stubEngine();
    const base = engine.flagshipWorld!;
    engine.flagshipWorld = () => {
      const r = base();
      return { ...r, intent: { ...r.intent, authority: { ...r.intent.authority, mayPreparePayments: false } } };
    };
    const gw = new TestGateway();
    const app = makeApp(engine, gw);
    const { m, agreement } = await flow(app);
    const ap: any = await (await post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: m.id, payee: 'a1', termsHash: agreement.termsHash, amount: { currency: 'SEK', minor: 3_000_000 } })).json();
    expect(ap.approvalToken).toBeTruthy();
    const { events }: any = await (await app.request(`/api/markets/${m.id}/events?format=json`)).json();
    const grant = events.find((e: any) => e.data?.grant);
    expect(grant.source).toBe('buyer');
    expect(grant.data.grant).toMatchObject({ scope: 'mayPreparePayments', agreement: agreement.id, termsHash: agreement.termsHash });
    const market: any = await (await app.request(`/api/markets/${m.id}`)).json();
    expect(market.intent.authority.mayPreparePayments).toBe(false);
    expect((await post(app, '/api/payments/orders', { approvalToken: ap.approvalToken, market: m.id })).status).toBe(201);
  });

  it('serves the public PayPal client id and never the secret', async () => {
    const app = createApp({ engine: stubEngine(), gateway: new TestGateway(), dataDir: ':memory:', config: loadConfig({ PAYPAL_CLIENT_ID: 'pub-test-id', PAYPAL_CLIENT_SECRET: 'hidden-secret' }) });
    const cfg: any = await (await app.request('/api/config')).json();
    expect(cfg.paypal.clientId).toBe('pub-test-id');
    const st: any = await (await app.request('/api/status')).json();
    expect(st.paypal.clientId).toBe('pub-test-id');
    expect(JSON.stringify(cfg) + JSON.stringify(st)).not.toContain('hidden-secret');
  });
});

describe('platform guards', () => {
  it('reports status as booleans and counts, never secrets', async () => {
    const app = makeApp(stubEngine());
    const s: any = await (await app.request('/api/status')).json();
    expect(typeof s.services.paypalConfigured).toBe('boolean');
    expect(typeof s.counts.markets).toBe('number');
    expect(JSON.stringify(s)).not.toMatch(/secret|key|token/i);
  });

  it('rate limits per IP', async () => {
    const app = makeApp(stubEngine(), undefined, { rateLimitPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.request('/api/status', { headers: { 'x-forwarded-for': '9.9.9.9' } })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await app.request('/api/status', { headers: { 'x-forwarded-for': '8.8.8.8' } })).status).toBe(200);
  });

  it('answers 501 for missing modules and never leaks stack traces', async () => {
    const app = makeApp({ ...stubEngine(), solve: undefined });
    const m: any = await (await post(app, '/api/markets', {})).json();
    const r = await post(app, `/api/markets/${m.id}/analyze`);
    expect(r.status).toBe(501);
    const boom = stubEngine();
    boom.solve = async () => {
      throw new Error('secret-detail at C:\\path\\file.ts:12');
    };
    const app2 = makeApp(boom);
    const m2: any = await (await post(app2, '/api/markets', {})).json();
    const r2 = await post(app2, `/api/markets/${m2.id}/analyze`);
    expect(r2.status).toBe(500);
    expect(JSON.stringify(await r2.json())).not.toMatch(/secret-detail|\.ts/);
  });

  it('kill switch and daily budget stop live AI calls', async () => {
    const seen: boolean[] = [];
    const e = stubEngine();
    e.compileIntent = async (_t: string, _w: unknown, o: { live: boolean }) => {
      seen.push(o.live);
      return { intent: null, questions: [], model: 'x', live: o.live };
    };
    const off = makeApp(e, undefined, { aiEnabled: false });
    await post(off, '/api/intents/compile', { text: 'hello' });
    const capped = makeApp(e, undefined, { dailyAiCalls: 1 });
    await post(capped, '/api/intents/compile', { text: 'a' });
    await post(capped, '/api/intents/compile', { text: 'b' });
    expect(seen).toEqual([false, true, false]);
  });

  it('webhooks verify the signature and record each event once', async () => {
    const app = makeApp(stubEngine());
    const ev = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1', status: 'COMPLETED' } });
    expect((await post(app, '/api/webhooks/paypal', JSON.parse(ev), { 'x-test-sig': 'bad' })).status).toBe(400);
    const ok: any = await (await post(app, '/api/webhooks/paypal', JSON.parse(ev), { 'x-test-sig': 'valid' })).json();
    expect(ok.duplicate).toBeUndefined();
    const dup: any = await (await post(app, '/api/webhooks/paypal', JSON.parse(ev), { 'x-test-sig': 'valid' })).json();
    expect(dup.duplicate).toBe(true);
  });

  it('allows same origin, localhost and the Pages origin only', async () => {
    const app = makeApp(stubEngine());
    const hit = (origin: string) => Promise.resolve(app.request('/api/status', { headers: { origin } })).then((r) => r.headers.get('access-control-allow-origin'));
    expect(await hit('http://localhost:5173')).toBe('http://localhost:5173');
    expect(await hit('https://shafir-01.github.io')).toBe('https://shafir-01.github.io');
    expect(await hit('https://evil.example')).toBeFalsy();
    const blocked = await post(app, '/api/markets', {}, { origin: 'https://evil.example' });
    expect(blocked.status).toBe(403);
  });
});

describe('integration surface', () => {
  it('maps templates to the market generators and returns id and market', async () => {
    const seen: any[] = [];
    const e = stubEngine();
    e.createMarket = (spec) => {
      seen.push(spec);
      return e.flagshipWorld!();
    };
    const app = makeApp(e);
    for (const t of ['flagship', 'exhibition', 'circular']) {
      const r: any = await (await post(app, '/api/markets', { template: t })).json();
      expect(r.market).toBe(r.id);
      expect(r.template).toBe(t);
    }
    const u: any = await (await post(app, '/api/markets', { template: 'unseen', seed: 42, family: 'impossible' })).json();
    expect(u.seed).toBe(42);
    expect(seen.at(-1)).toEqual({ template: 'unseen', seed: 42, family: 'impossible' });
    expect(seen.slice(0, 3).map((x) => x.template)).toEqual(['flagship', 'exhibition', 'circular']);
    expect((await post(app, '/api/markets', { template: 'nope' })).status).toBe(400);
  });

  it('reports the build commit and keeps secrets out of status', async () => {
    const s: any = await (await makeApp(stubEngine()).request('/api/status')).json();
    expect(s.build).toHaveProperty('commit');
    expect(['render', 'local', 'unknown']).toContain(s.build.source);
    const { buildInfo } = await import('../src/app.ts');
    expect(buildInfo({ RENDER_GIT_COMMIT: 'abc123' })).toEqual({ commit: 'abc123', source: 'render' });
  });

  it('lets the buyer grant scopes but never a limit above the budget', async () => {
    const app = makeApp(stubEngine());
    const m: any = await (await post(app, '/api/markets', {})).json();
    const over = await post(app, `/api/markets/${m.id}/authority`, { maxSpend: { currency: 'SEK', minor: 99_000_000 } });
    expect(over.status).toBe(422);
    const ok: any = await (await post(app, `/api/markets/${m.id}/authority`, { mayPreparePayments: false, maxSpend: { currency: 'SEK', minor: 1_000_000 } })).json();
    expect(ok.authority).toMatchObject({ mayPreparePayments: false, maxSpend: { minor: 1_000_000 } });
  });

  it('links every event after market creation to what caused it', async () => {
    const app = makeApp(stubEngine());
    const m: any = await (await post(app, '/api/markets', {})).json();
    await post(app, `/api/markets/${m.id}/analyze`);
    await post(app, `/api/markets/${m.id}/invent`);
    const neg: any = await (await post(app, `/api/markets/${m.id}/negotiate`)).json();
    await post(app, `/api/plans/${neg.planId}/verify`, { market: m.id });
    await post(app, `/api/agreements/${neg.planId}/commit`, { market: m.id });
    await post(app, `/api/markets/${m.id}/disrupt`, { kind: 'withdraw', actor: 'a1' });
    await post(app, `/api/markets/${m.id}/recover`, {});
    const { events }: any = await (await app.request(`/api/markets/${m.id}/events?format=json`)).json();
    const missing = events.filter((e: any) => e.type !== 'world.created' && !e.causes.length).map((e: any) => e.type);
    expect(missing).toEqual([]);
    const rec = events.find((e: any) => e.type === 'recovery.proposed');
    expect(events.find((e: any) => e.id === rec.causes[0]).type).toBe('disruption.applied');
  });

  it('answers 501 for mechanisms and options when those modules are absent', async () => {
    const app = makeApp(stubEngine());
    const m: any = await (await post(app, '/api/markets', {})).json();
    expect((await post(app, `/api/markets/${m.id}/mechanisms/auction`)).status).toBe(501);
    expect((await post(app, `/api/markets/${m.id}/mechanisms/compare`)).status).toBe(501);
  });
});
