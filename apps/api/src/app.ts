import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { Agreement, Disruption, Money, PayPalRecord, PaymentIntent, PaymentState, Plan } from '@framvera/contracts';
import { availability, need, Unavailable, type Engine } from './engine.ts';
import { loadConfig, type Config } from './config.ts';
import { Store, type Session } from './store.ts';
import { AiBudget, Approvals, RateLimiter } from './security.ts';
import { staticHandler } from './static.ts';
import { register as registerSeller } from './seller.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Deps {
  engine: Engine;
  gateway?: any;
  config?: Config;
  dataDir?: string | ':memory:';
}

class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 501 | 503, public code: string, message: string) {
    super(message);
  }
}

const HEAVY = /\/(analyze|invent|negotiate|recover|compile)$/;
const originAllowed = (origin: string, host: string | undefined) => {
  try {
    const u = new URL(origin);
    if (host && u.host === host) return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return origin === 'https://shafir-01.github.io';
  } catch {
    return false;
  }
};

const isMoney = (m: any): m is Money => Boolean(m) && Number.isInteger(m.minor) && typeof m.currency === 'string';
const sameMoney = (a: Money, b: Money) => a.currency === b.currency && a.minor === b.minor;

export function stateFromRecord(r: PayPalRecord, prev: PaymentState): PaymentState {
  if (prev.startsWith('REFUND') && r.refunds?.some((x) => x.status === 'COMPLETED')) return 'REFUND_COMPLETED';
  if (r.captureId && r.status === 'COMPLETED') return 'CAPTURE_COMPLETED';
  if (r.captureId && prev === 'CAPTURE_COMPLETED') return prev;
  switch (r.status) {
    case 'APPROVED':
      return 'APPROVED';
    case 'PAYER_ACTION_REQUIRED':
      return 'PAYER_ACTION_REQUIRED';
    case 'VOIDED':
      return 'VOIDED';
    case 'CREATED':
      return r.approveUrl ? 'PAYER_ACTION_REQUIRED' : 'ORDER_CREATED';
    case 'COMPLETED':
      return 'CAPTURE_COMPLETED';
    default:
      return r.orderId && prev === 'PAYMENT_PROPOSED' ? 'ORDER_CREATED' : prev;
  }
}

export function createApp(deps: Deps) {
  const { engine } = deps;
  const config = deps.config ?? loadConfig();
  const store = new Store(engine, deps.dataDir ?? config.dataDir);
  const limiter = new RateLimiter();
  const budget = new AiBudget(config.aiEnabled, config.dailyAiCalls);
  const approvals = new Approvals(config.approvalSecret);
  const usedTokens = new Set<string>();
  const seenWebhooks = new Set<string>();
  const paymentIndex = new Map<string, string>();
  const planIndex = new Map<string, string>();
  const agreementIndex = new Map<string, string>();
  let gateway = deps.gateway;
  if (!gateway && engine.PayPalSandboxAdapter && config.paypalConfigured) {
    try {
      gateway = new engine.PayPalSandboxAdapter();
    } catch {
      gateway = undefined;
    }
  }

  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && c.req.method !== 'GET' && c.req.method !== 'OPTIONS' && !originAllowed(origin, c.req.header('host'))) {
      return c.json({ error: { code: 'origin', message: 'Origin not allowed' } }, 403);
    }
    await next();
  });
  app.use('/api/*', cors({ origin: (o, c) => (originAllowed(o, c.req.header('host')) ? o : ''), allowHeaders: ['content-type'], allowMethods: ['GET', 'POST', 'OPTIONS'] }));
  app.use('/api/*', bodyLimit({ maxSize: 1_000_000, onError: (c) => c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413) }));
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/webhooks/paypal') return next();
    const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';
    const heavy = c.req.method === 'POST' && HEAVY.test(c.req.path);
    if (!limiter.allow(`g:${ip}`, config.rateLimitPerMin) || (heavy && !limiter.allow(`h:${ip}`, config.heavyLimitPerMin))) {
      c.header('retry-after', '60');
      return c.json({ error: { code: 'rate_limited', message: 'Too many requests, retry shortly' } }, 429);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof Unavailable) return c.json({ error: { code: 'unavailable', message: `${err.what} is not available on this server` } }, 501);
    console.error('api error:', err instanceof Error ? err.name : 'unknown', c.req.method, c.req.path);
    return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
  });

  const body = async (c: Context): Promise<any> => {
    try {
      const b = await c.req.json();
      return b && typeof b === 'object' ? b : {};
    } catch {
      return {};
    }
  };
  const index = (s: Session) => {
    for (const p of Object.values(s.plans)) planIndex.set(p.id, s.id);
    if (s.agreement) agreementIndex.set(s.agreement.id, s.id);
    for (const p of Object.values(s.payments)) paymentIndex.set(p.id, s.id);
  };
  const session = (id: string): Session => {
    const s = store.load(id);
    if (!s) throw new HttpError(404, 'not_found', 'Market not found');
    index(s);
    return s;
  };
  const findPlan = (planId: string, hint?: string) => {
    const s = store.load(planIndex.get(planId) ?? hint ?? '');
    const plan = s?.plans[planId];
    if (!s || !plan) throw new HttpError(404, 'not_found', 'Plan not found');
    index(s);
    return { s, plan };
  };
  const findAgreement = (id: string, hint?: string) => {
    const s = store.load(agreementIndex.get(id) ?? hint ?? '');
    if (!s || !s.agreement || s.agreement.id !== id) throw new HttpError(404, 'not_found', 'Agreement not found');
    index(s);
    return { s, agreement: s.agreement };
  };
  const findPayment = (id: string) => {
    const s = store.load(paymentIndex.get(id) ?? '');
    const pi = s?.payments[id];
    if (!s || !pi) throw new HttpError(404, 'not_found', 'Payment not found');
    return { s, pi };
  };
  const needGateway = () => {
    if (!gateway) throw new HttpError(503, 'payments_unconfigured', 'Payments are not configured on this server');
    return gateway;
  };
  const truthFor = (s: Session) => {
    if (s.seed === null || s.family === 'flagship') return need(engine.flagshipWorld, 'market')().truth;
    return need(engine.generateWorld, 'market')(s.seed, s.family).truth;
  };

  registerSeller(app, { engine, store, config, session, truthFor, takeLive: () => budget.take() });

  // ---------- markets ----------
  app.post('/api/markets', async (c) => {
    const b = await body(c);
    let seed: number | null = null;
    let family = 'flagship';
    let gen: { world: any; intent: any };
    if (typeof b.seed === 'number' && Number.isFinite(b.seed)) {
      seed = Math.floor(b.seed);
      family = ['feasible', 'salvageable', 'impossible'].includes(b.family) ? b.family : 'salvageable';
      gen = need(engine.generateWorld, 'market')(seed, family);
    } else {
      gen = need(engine.flagshipWorld, 'market')();
    }
    const id = `m-${randomUUID().slice(0, 12)}`;
    const s: Session = {
      id, seed, family, world: gen.world, intent: gen.intent, decisions: [], plans: {}, verified: {}, payments: {},
      approvals: { spent: 0, used: [] }, recoveries: [], disruptions: [],
    };
    store.save(s);
    store.emit(id, 'world.created', { world: s.world.name, seed, family, actors: s.world.actors.length, offers: s.world.offers.length }, 'synthetic-market');
    return c.json({ id, world: s.world, intent: s.intent }, 201);
  });

  app.get('/api/markets/:id', (c) => {
    const s = session(c.req.param('id'));
    return c.json({ id: s.id, world: s.world, intent: s.intent, plans: Object.values(s.plans), agreement: s.agreement ?? null, payments: Object.values(s.payments), recoveries: s.recoveries });
  });

  app.post('/api/intents/compile', async (c) => {
    const b = await body(c);
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 2000) throw new HttpError(400, 'bad_request', 'Describe what you need in a sentence or two');
    const s = typeof b.market === 'string' ? session(b.market) : undefined;
    const world = s?.world ?? need(engine.flagshipWorld, 'market')().world;
    const live = budget.take();
    const r = await need(engine.compileIntent, 'intent compiler')(b.text, world, { live });
    if (s && r?.intent) {
      s.intent = r.intent;
      store.save(s);
      store.emit(s.id, 'intent.compiled', { intent: s.intent, live: Boolean(r.live), model: r.model }, r.live ? 'model-proposal' : 'solver');
    }
    return c.json(r);
  });

  app.post('/api/markets/:id/analyze', async (c) => {
    const s = session(c.req.param('id'));
    const report = await need(engine.solve, 'solver')(s.world, s.intent);
    if (report.status === 'infeasible' && !report.core && engine.explainInfeasible) report.core = await engine.explainInfeasible(s.world, s.intent);
    s.report = report;
    if (report.plan) s.plans[report.plan.id] = report.plan;
    store.save(s);
    index(s);
    store.emit(s.id, 'solve.completed', { status: report.status, solver: report.solver, core: report.core ?? null, plan: report.plan?.id ?? null }, 'solver');
    return c.json(report);
  });

  app.post('/api/markets/:id/invent', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    const interventions = await need(engine.findInterventions, 'inverse feasibility search')(s.world, s.intent, { maxChanges: b.maxChanges, k: b.k });
    const coalitions = engine.synthesizeCoalitions ? await engine.synthesizeCoalitions(s.world, s.intent) : [];
    const findings = engine.challengeClaims ? await engine.challengeClaims(s.world, (s.report as any)?.plan ?? null) : [];
    s.interventions = interventions;
    s.coalitions = coalitions;
    s.findings = findings;
    store.save(s);
    for (const i of interventions as any[]) store.emit(s.id, 'intervention.found', i, 'solver');
    if ((findings as any[]).length) store.emit(s.id, 'claim.challenged', { findings }, 'solver');
    return c.json({ interventions, coalitions, findings });
  });

  app.post('/api/markets/:id/negotiate', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (s.intent.authority?.mayNegotiate === false) throw new HttpError(403, 'scope', 'The buyer has not allowed negotiation');
    const live = budget.take();
    const run = await need(engine.negotiate, 'negotiation')(s.world, s.intent, truthFor(s), { live, interventions: s.interventions, maxQuestions: b.maxQuestions, seed: b.seed });
    s.run = run;
    s.decisions = run.decisions ?? s.decisions;
    if (run.world) s.world = run.world;
    if (run.intent) s.intent = run.intent;
    const plan: Plan | undefined = run.plan ?? run.report?.plan;
    if (plan) s.plans[plan.id] = plan;
    store.save(s);
    index(s);
    for (const m of run.messages ?? []) store.emit(s.id, 'negotiation.message', m, 'solver');
    for (const d of run.decisions ?? []) store.emit(s.id, 'negotiation.decision', d, d.basis === 'seller-terminal' ? 'seller-terminal' : 'synthetic-market');
    return c.json({ ...run, planId: plan?.id ?? null });
  });

  // ---------- plans and agreements ----------
  app.post('/api/plans/:id/verify', async (c) => {
    const b = await body(c);
    const { s, plan } = findPlan(c.req.param('id'), b.market);
    const v = need(engine.verifyPlan, 'plan verifier')(plan, s.world, s.intent);
    s.verified[plan.id] = Boolean(v.ok);
    store.save(s);
    store.emit(s.id, 'solve.completed', { verification: v, plan: plan.id }, 'solver');
    return c.json(v);
  });

  app.post('/api/agreements/:id/commit', async (c) => {
    // The path id names the plan being committed; the agreement id is minted at commit.
    const b = await body(c);
    const { s, plan } = findPlan(c.req.param('id'), b.market);
    if (s.agreement) return c.json(s.agreement);
    if (s.intent.authority?.mayReserve === false) throw new HttpError(403, 'scope', 'The buyer has not allowed reservations');
    const v = need(engine.verifyPlan, 'plan verifier')(plan, s.world, s.intent);
    if (!v.ok) throw new HttpError(422, 'unverified', 'This plan did not pass independent verification');
    s.verified[plan.id] = true;
    if (plan.total.minor > s.intent.budget.minor) throw new HttpError(422, 'over_budget', 'Plan exceeds the budget');
    const agreement: Agreement = await need(engine.commit, 'obligations')(plan, s.intent, s.decisions);
    s.agreement = agreement;
    store.save(s);
    index(s);
    store.emit(s.id, 'agreement.state', { agreement: agreement.id, state: agreement.state, termsHash: agreement.termsHash }, 'solver');
    for (const o of agreement.obligations) store.emit(s.id, 'obligation.state', { obligation: o.id, state: o.state }, 'solver', { actor: o.actor });
    return c.json(agreement, 201);
  });

  // ---------- payments: money only moves behind a buyer approval bound to terms and amount ----------
  const owed = (agreement: Agreement, payee: string): Money | null => {
    const mine = agreement.obligations.filter((o) => o.actor === payee && o.state !== 'CANCELLED' && o.state !== 'REPLACED');
    if (!mine.length) return null;
    return { currency: mine[0]!.amount.currency, minor: mine.reduce((a, o) => a + o.amount.minor, 0) };
  };

  app.post('/api/agreements/:id/approve-payment', async (c) => {
    const b = await body(c);
    const { s, agreement } = findAgreement(c.req.param('id'), b.market);
    if (agreement.state !== 'COMMITTED' && agreement.state !== 'FULFILLING') throw new HttpError(409, 'state', 'Agreement is not committed');
    if (s.intent.authority?.mayPreparePayments === false) throw new HttpError(403, 'scope', 'The buyer has not allowed payment preparation');
    if (b.termsHash !== agreement.termsHash) throw new HttpError(409, 'terms_changed', 'The agreement terms changed since you reviewed them');
    const due = typeof b.payee === 'string' ? owed(agreement, b.payee) : null;
    if (!due) throw new HttpError(404, 'not_found', 'Nothing is owed to that supplier');
    if (!isMoney(b.amount) || !sameMoney(b.amount, due)) throw new HttpError(409, 'amount_mismatch', 'Approved amount does not match what is owed');
    const max = s.intent.authority?.maxSpend;
    if (max && s.approvals.spent + due.minor > max.minor) throw new HttpError(403, 'over_limit', 'This would exceed the buyer spending limit');
    const { token, claim } = approvals.issue({ kind: 'pay', agreement: agreement.id, subject: b.payee, termsHash: agreement.termsHash, amount: due });
    store.emit(s.id, 'payment.state', { approval: 'issued', payee: b.payee, amount: due, expires: new Date(claim.exp).toISOString() }, 'buyer');
    return c.json({ approvalToken: token, expiresAt: new Date(claim.exp).toISOString(), amount: due });
  });

  const apply = (s: Session, pi: PaymentIntent, r: any) => {
    const rec: PayPalRecord = r?.paypal ?? r ?? pi.paypal;
    pi.paypal = { ...pi.paypal, ...rec, refunds: rec.refunds ?? pi.paypal.refunds, debugIds: rec.debugIds ?? pi.paypal.debugIds };
    const next = stateFromRecord(pi.paypal, pi.state);
    if (next !== pi.state) {
      pi.state = next;
      store.emit(s.id, 'payment.state', { payment: pi.id, state: pi.state, paypalStatus: pi.paypal.status ?? null }, 'paypal-sandbox');
    }
    store.save(s);
    paymentIndex.set(pi.id, s.id);
  };

  app.post('/api/payments/orders', async (c) => {
    const b = await body(c);
    if (typeof b.approvalToken !== 'string') throw new HttpError(403, 'approval_required', 'A buyer approval is required before any payment is created');
    const claim = approvals.verify(b.approvalToken);
    if (!claim || claim.kind !== 'pay') throw new HttpError(403, 'approval_invalid', 'The buyer approval is missing, expired or invalid');
    const gw = needGateway();
    const { s, agreement } = findAgreement(claim.agreement, b.market);
    const due = owed(agreement, claim.subject);
    if (agreement.termsHash !== claim.termsHash || !due || !sameMoney(due, claim.amount)) throw new HttpError(409, 'approval_stale', 'The approval no longer matches the agreement');
    if (typeof b.agreementId === 'string' && b.agreementId !== agreement.id) throw new HttpError(409, 'approval_mismatch', 'The approval is for a different agreement');
    const operationKey = createHash('sha256').update(`${agreement.id}|${agreement.termsHash}|${claim.subject}|${due.minor}`).digest('hex').slice(0, 32);
    const existing = Object.values(s.payments).find((p) => p.operationKey === operationKey);
    if (existing) return c.json(existing);
    if (usedTokens.has(claim.nonce)) throw new HttpError(403, 'approval_used', 'This approval was already used');
    usedTokens.add(claim.nonce);
    const max = s.intent.authority?.maxSpend;
    if (max && s.approvals.spent + due.minor > max.minor) throw new HttpError(403, 'over_limit', 'This would exceed the buyer spending limit');
    const pi: PaymentIntent = {
      id: `pay-${randomUUID().slice(0, 12)}`, operationKey, agreement: agreement.id,
      obligations: agreement.obligations.filter((o) => o.actor === claim.subject).map((o) => o.id),
      payee: claim.subject, amount: due, charged: due, state: 'PAYMENT_PROPOSED',
      paypal: { env: 'sandbox', refunds: [], debugIds: [] },
    };
    s.payments[pi.id] = pi;
    s.approvals.spent += due.minor;
    store.emit(s.id, 'payment.state', { payment: pi.id, state: pi.state, approvedBy: 'buyer' }, 'buyer');
    try {
      apply(s, pi, await gw.createOrder(pi));
    } catch {
      usedTokens.delete(claim.nonce);
      s.approvals.spent -= due.minor;
      delete s.payments[pi.id];
      store.save(s);
      throw new HttpError(503, 'payments_unavailable', 'The payment provider could not create the order');
    }
    return c.json(pi, 201);
  });

  app.get('/api/payments/:id', async (c) => {
    const { s, pi } = findPayment(c.req.param('id'));
    const gw = needGateway();
    if (pi.paypal.orderId) {
      try {
        const fresh = await gw.getOrder(pi.paypal.orderId);
        apply(s, pi, { ...(fresh?.paypal ?? fresh), lastFetchedAt: new Date().toISOString() });
      } catch {
        /* last known state is served, dated by lastFetchedAt */
      }
    }
    return c.json(pi);
  });

  app.post('/api/payments/:id/capture', async (c) => {
    const { s, pi } = findPayment(c.req.param('id'));
    const gw = needGateway();
    if (pi.state === 'CAPTURE_COMPLETED') return c.json(pi);
    if (!['APPROVED', 'PAYER_ACTION_REQUIRED', 'ORDER_CREATED', 'CAPTURE_UNKNOWN', 'CAPTURE_PENDING'].includes(pi.state)) throw new HttpError(409, 'state', 'This payment cannot be captured now');
    try {
      if (pi.state !== 'CAPTURE_UNKNOWN') pi.state = 'CAPTURE_PENDING';
      apply(s, pi, await gw.capture(pi));
      if (pi.state === 'CAPTURE_PENDING' && pi.paypal.captureId) pi.state = 'CAPTURE_COMPLETED';
    } catch {
      pi.state = 'CAPTURE_UNKNOWN';
      store.save(s);
      store.emit(s.id, 'payment.state', { payment: pi.id, state: pi.state }, 'paypal-sandbox');
      throw new HttpError(503, 'capture_unknown', 'Capture outcome unknown. Retrieve the payment to reconcile before retrying');
    }
    return c.json(pi);
  });

  app.post('/api/payments/:id/approve-refund', async (c) => {
    const b = await body(c);
    const { s, pi } = findPayment(c.req.param('id'));
    const { agreement } = findAgreement(pi.agreement, s.id);
    if (pi.state !== 'CAPTURE_COMPLETED') throw new HttpError(409, 'state', 'Only captured payments can be refunded');
    const amount = isMoney(b.amount) ? b.amount : pi.charged;
    if (amount.currency !== pi.charged.currency || amount.minor <= 0 || amount.minor > pi.charged.minor) throw new HttpError(409, 'amount_mismatch', 'Refund amount is out of range');
    const { token } = approvals.issue({ kind: 'refund', agreement: agreement.id, subject: pi.id, termsHash: agreement.termsHash, amount });
    return c.json({ approvalToken: token, amount });
  });

  app.post('/api/payments/:id/refund', async (c) => {
    const b = await body(c);
    const { s, pi } = findPayment(c.req.param('id'));
    const claim = approvals.verify(b.approvalToken);
    if (!claim || claim.kind !== 'refund' || claim.subject !== pi.id) throw new HttpError(403, 'approval_required', 'A buyer approval is required for a refund');
    const gw = needGateway();
    if (usedTokens.has(claim.nonce)) throw new HttpError(403, 'approval_used', 'This approval was already used');
    usedTokens.add(claim.nonce);
    pi.state = 'REFUND_PENDING';
    try {
      apply(s, pi, await gw.refund(pi, claim.amount));
      if (pi.state === 'REFUND_PENDING' && pi.paypal.refunds.length) pi.state = 'REFUND_COMPLETED';
    } catch {
      pi.state = 'REFUND_UNKNOWN';
      throw new HttpError(503, 'refund_unknown', 'Refund outcome unknown. Retrieve the payment to reconcile');
    } finally {
      store.save(s);
    }
    return c.json(pi);
  });

  app.post('/api/webhooks/paypal', async (c) => {
    const raw = await c.req.text();
    if (raw.length > 500_000) throw new HttpError(400, 'bad_request', 'Body too large');
    if (!gateway || typeof gateway.verifyWebhook !== 'function') throw new HttpError(503, 'payments_unconfigured', 'Webhooks are not configured');
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let verified = false;
    try {
      const r = await gateway.verifyWebhook(headers, raw);
      verified = r === true || r?.verified === true || r?.verification_status === 'SUCCESS';
    } catch {
      verified = false;
    }
    if (!verified) throw new HttpError(400, 'bad_signature', 'Webhook signature could not be verified');
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'bad_request', 'Invalid JSON');
    }
    const eid = String(ev?.id ?? '');
    if (!eid) throw new HttpError(400, 'bad_request', 'Missing event id');
    if (!seenWebhooks.size) for (const e of store.events('_webhooks')) seenWebhooks.add(String((e.data as any)?.id));
    if (seenWebhooks.has(eid)) return c.json({ ok: true, duplicate: true });
    seenWebhooks.add(eid);
    const resId = ev?.resource?.id;
    const orderId = ev?.resource?.supplementary_data?.related_ids?.order_id ?? resId;
    let market = '';
    for (const sess of store.sessions.values()) {
      if (Object.values(sess.payments).some((p) => p.paypal.orderId === orderId || p.paypal.captureId === resId)) market = sess.id;
    }
    const summary = { id: eid, type: ev.event_type, resource: resId ?? null, status: ev?.resource?.status ?? null };
    store.emit('_webhooks', 'paypal.webhook', summary, 'paypal-sandbox');
    if (market) store.emit(market, 'paypal.webhook', summary, 'paypal-sandbox');
    return c.json({ ok: true });
  });

  // ---------- disruption and recovery ----------
  app.post('/api/markets/:id/disrupt', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (!s.agreement) throw new HttpError(409, 'state', 'Nothing is committed yet');
    const kinds = ['withdraw', 'capacity-drop', 'delay', 'price-change', 'claim-overturned', 'payment-failed'];
    if (!kinds.includes(b.kind)) throw new HttpError(400, 'bad_request', 'Unknown disruption kind');
    const d: Disruption = { id: `d-${randomUUID().slice(0, 8)}`, kind: b.kind, actor: b.actor, offer: b.offer, detail: String(b.detail ?? b.kind).slice(0, 300), at: new Date().toISOString() };
    const r = await need(engine.disrupt, 'obligations')(s.agreement, s.world, d);
    s.world = r.world ?? s.world;
    s.disruptions.push(d);
    store.save(s);
    store.emit(s.id, 'disruption.applied', { disruption: d, affected: (r.affected ?? []).map((o: any) => o.id) }, 'solver', { actor: d.actor });
    return c.json({ disruption: d, affected: r.affected ?? [] });
  });

  app.post('/api/markets/:id/recover', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (!s.agreement) throw new HttpError(409, 'state', 'Nothing is committed yet');
    const list = s.disruptions as Disruption[];
    const d = list.find((x) => x.id === b.disruption) ?? list.at(-1);
    if (!d) throw new HttpError(409, 'state', 'No disruption to recover from');
    const rec = await need(engine.recover, 'recovery')(s.agreement, s.world, s.intent, d);
    s.recoveries.push(rec);
    store.save(s);
    store.emit(s.id, 'recovery.proposed', rec, 'solver');
    return c.json(rec);
  });

  // ---------- observation ----------
  app.get('/api/markets/:id/events', (c) => {
    const id = c.req.param('id');
    session(id);
    const after = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue: any[] = [];
      let wake: (() => void) | null = null;
      const unsub = store.subscribe(id, (e) => {
        queue.push(e);
        wake?.();
      });
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      let last = after;
      try {
        for (const e of store.events(id)) {
          if (e.seq > last) {
            last = e.seq;
            await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
          }
        }
        await stream.writeSSE({ event: 'ready', data: '{}' });
        while (!aborted) {
          if (!queue.length) await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 15000))]);
          wake = null;
          if (!queue.length && !aborted) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
          while (queue.length) {
            const e = queue.shift();
            if (e.seq <= last) continue;
            last = e.seq;
            await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
          }
        }
      } finally {
        unsub();
      }
    });
  });

  app.get('/api/markets/:id/trace/:entity', (c) => {
    const id = c.req.param('id');
    session(id);
    const entity = c.req.param('entity');
    const evs = store.events(id);
    const byId = new Map(evs.map((e) => [e.id, e]));
    const hit = (e: any) => e.id === entity || e.actor === entity || JSON.stringify(e.data ?? null).includes(entity);
    const chain = new Map<string, any>();
    const walk = (e: any) => {
      if (chain.has(e.id)) return;
      chain.set(e.id, e);
      for (const cid of e.causes ?? []) {
        const p = byId.get(cid);
        if (p) walk(p);
      }
    };
    evs.filter(hit).forEach(walk);
    if (!chain.size) throw new HttpError(404, 'not_found', 'No record mentions that entity');
    return c.json({ entity, events: [...chain.values()].sort((a, b) => a.seq - b.seq) });
  });

  app.get('/api/status', (c) => {
    let payments = 0;
    let agreements = 0;
    for (const s of store.sessions.values()) {
      payments += Object.keys(s.payments).length;
      if (s.agreement) agreements += 1;
    }
    return c.json({
      ok: true,
      services: {
        ...availability(engine),
        paypalConfigured: Boolean(gateway),
        aiConfigured: config.aiKeyConfigured,
        aiEnabled: config.aiEnabled,
        aiBudgetLeft: config.aiEnabled && budget.usedToday < config.dailyAiCalls,
        durableLedger: store.durable,
        webUi: Boolean(config.webDist),
      },
      counts: { markets: store.sessions.size, agreements, payments, aiCallsToday: budget.usedToday },
    });
  });

  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Unknown endpoint' } }, 404));
  if (config.webDist) app.get('*', staticHandler(config.webDist));
  return app;
}
