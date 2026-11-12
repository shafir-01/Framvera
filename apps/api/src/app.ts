import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { Agreement, Concession, Disruption, Money, PayPalRecord, PaymentIntent, PaymentState, Plan } from '@framvera/contracts';
import { availability, need, Unavailable, type Bundle, type Engine, type Template } from './engine.ts';
import { loadConfig, type Config } from './config.ts';
import { Store, type Session } from './store.ts';
import { AiBudget, Approvals, RateLimiter } from './security.ts';
import { staticHandler } from './static.ts';
import { register as registerSeller } from './seller.ts';
import { registerDepth } from './depth.ts';
import * as paypalModule from '@framvera/paypal';

const VERSION = '0.1.0';

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
const TEMPLATES: Template[] = ['flagship', 'exhibition', 'circular', 'unseen'];
const FAMILIES = ['feasible', 'salvageable', 'impossible'];
const SPENT: PaymentState[] = ['VOIDED', 'CAPTURE_DENIED', 'REFUND_COMPLETED'];

/** Commit the server runs: Render's deploy commit, else the checked-out HEAD read from the repository files. */
export function buildInfo(env: Record<string, string | undefined> = process.env, start = process.cwd()): { commit: string | null; source: string } {
  if (env.RENDER_GIT_COMMIT) return { commit: env.RENDER_GIT_COMMIT, source: 'render' };
  try {
    let dir = resolve(start);
    while (!existsSync(join(dir, '.git'))) {
      const up = dirname(dir);
      if (up === dir) return { commit: null, source: 'unknown' };
      dir = up;
    }
    const git = join(dir, '.git');
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return { commit: head, source: 'local' };
    const ref = head.slice(4).trim();
    if (existsSync(join(git, ref))) return { commit: readFileSync(join(git, ref), 'utf8').trim(), source: 'local' };
    const packed = existsSync(join(git, 'packed-refs')) ? readFileSync(join(git, 'packed-refs'), 'utf8') : '';
    const line = packed.split('\n').find((l) => l.trim().endsWith(` ${ref}`));
    return { commit: line ? line.split(' ')[0]! : null, source: line ? 'local' : 'unknown' };
  } catch {
    return { commit: null, source: 'unknown' };
  }
}

const without = <T extends object>(o: T, ...keys: string[]): T => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as T;


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
  const truths = new Map<string, any>();
  const build = buildInfo();
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
  // Plan and agreement ids are deterministic per market template, so the session named in the request wins.
  const findPlan = (planId: string, hint?: string) => {
    const hinted = typeof hint === 'string' ? store.load(hint) : undefined;
    const s = hinted?.plans[planId] ? hinted : hinted ? undefined : store.load(planIndex.get(planId) ?? '');
    const plan = s?.plans[planId];
    if (!s || !plan) throw new HttpError(404, 'not_found', 'Plan not found');
    index(s);
    return { s, plan };
  };
  const findAgreement = (id: string, hint?: string) => {
    const hinted = typeof hint === 'string' ? store.load(hint) : undefined;
    const s = hinted ?? store.load(agreementIndex.get(id) ?? '');
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
  const generate = (template: Template, seed: number | null, family: string): Bundle => {
    if (engine.createMarket) return engine.createMarket({ template, seed, family });
    if (template === 'unseen') return need(engine.generateWorld, 'market generator')(seed ?? 0, family);
    if (template !== 'flagship') throw new Unavailable(`${template} market`);
    return need(engine.flagshipWorld, 'market')();
  };
  const templateOf = (s: Session): Template => s.template ?? (s.seed === null || s.family === 'flagship' ? 'flagship' : 'unseen');
  /** Supplier policies stay in this process: never in a session snapshot, an event or a response. */
  const truthFor = (s: Session) => {
    let t = truths.get(s.id);
    if (!t) {
      t = generate(templateOf(s), s.seed, s.family).truth;
      truths.set(s.id, t);
    }
    return t;
  };
  const obligationError = (e: unknown): never => {
    if (e instanceof Error && e.name === 'ObligationError') throw new HttpError(422, String((e as any).code ?? 'rejected'), e.message);
    throw e;
  };

  registerSeller(app, { engine, store, config, session, truthFor, takeLive: () => budget.take() });

  // ---------- markets ----------
  app.post('/api/markets', async (c) => {
    const b = await body(c);
    const hasSeed = typeof b.seed === 'number' && Number.isFinite(b.seed);
    if (b.template !== undefined && !TEMPLATES.includes(b.template)) throw new HttpError(400, 'bad_request', `Unknown template. Use one of: ${TEMPLATES.join(', ')}`);
    const template: Template = b.template ?? (b.flagship || !hasSeed ? 'flagship' : 'unseen');
    const seed: number | null = template !== 'unseen' ? null : hasSeed ? Math.abs(Math.floor(b.seed)) % 2_147_483_647 : Math.floor(Math.random() * 1_000_000);
    const family = template === 'unseen' ? (FAMILIES.includes(b.family) ? b.family : 'salvageable') : template;
    const gen = generate(template, seed, family);
    const id = `m-${randomUUID().slice(0, 12)}`;
    const s: Session = {
      id, template, seed, family, world: gen.world, intent: gen.intent, decisions: [], plans: {}, verified: {}, payments: {},
      approvals: { spent: 0, used: [] }, recoveries: [], disruptions: [],
    };
    truths.set(id, gen.truth);
    store.save(s);
    store.emit(id, 'world.created', { world: s.world.name, template, seed, family, actors: s.world.actors.length, offers: s.world.offers.length }, 'synthetic-market');
    return c.json({ id, market: id, template, seed, family, world: s.world, intent: s.intent }, 201);
  });

  app.get('/api/templates', (c) => c.json({ templates: engine.templates?.() ?? (engine.flagshipWorld ? ['flagship'] : []), families: FAMILIES }));

  app.get('/api/markets/:id', (c) => {
    const s = session(c.req.param('id'));
    return c.json({
      id: s.id, market: s.id, template: templateOf(s), seed: s.seed, world: s.world, intent: s.intent, plans: Object.values(s.plans), agreement: s.agreement ?? null,
      history: s.history ?? [], payments: Object.values(s.payments), recoveries: s.recoveries, run: s.run ?? null, options: s.options ?? null,
    });
  });

  /** The buyer grants or withdraws scopes explicitly. A spending limit can never exceed the budget the buyer stated. */
  app.post('/api/markets/:id/authority', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    const a = { ...s.intent.authority };
    const withheld = new Set(s.withheld ?? []);
    for (const k of ['mayNegotiate', 'mayReserve', 'mayPreparePayments'] as const) {
      if (typeof b[k] !== 'boolean') continue;
      a[k] = b[k];
      if (b[k]) withheld.delete(k);
      else withheld.add(k);
    }
    s.withheld = [...withheld];
    if (b.mayPreparePayments === false) s.grants = {};
    if (b.maxSpend !== undefined) {
      if (!isMoney(b.maxSpend) || b.maxSpend.currency !== s.intent.budget.currency || b.maxSpend.minor < 0) throw new HttpError(400, 'bad_request', 'Spending limit must be an amount in the budget currency');
      if (b.maxSpend.minor > s.intent.budget.minor) throw new HttpError(422, 'over_budget', 'The spending limit cannot exceed the budget');
      a.maxSpend = b.maxSpend;
    }
    s.intent = { ...s.intent, authority: a };
    store.save(s);
    store.emit(s.id, 'intent.compiled', { intent: s.intent.id, authority: a, changedBy: 'buyer' }, 'buyer');
    return c.json({ authority: a });
  });

  /** Compiled or negotiated intents can only narrow what the buyer already allowed, never widen it. */
  const narrower = (prev: any, next: any) => {
    if (!prev) return { mayNegotiate: false, mayReserve: false, mayPreparePayments: false, maxSpend: next?.maxSpend ?? { currency: 'SEK', minor: 0 } };
    const max = next?.maxSpend && next.maxSpend.currency === prev.maxSpend?.currency && next.maxSpend.minor < prev.maxSpend.minor ? next.maxSpend : prev.maxSpend;
    return {
      mayNegotiate: Boolean(prev.mayNegotiate && next?.mayNegotiate !== false),
      mayReserve: Boolean(prev.mayReserve && next?.mayReserve !== false),
      mayPreparePayments: Boolean(prev.mayPreparePayments && next?.mayPreparePayments !== false),
      maxSpend: max,
    };
  };
  /** A negotiation may move the deadline or budget only where the buyer consented in this request and within the flex the buyer stated. */
  const consentedIntent = (prev: any, next: any, consent: any) => {
    if (!next) return prev;
    const flex = prev.negotiable ?? {};
    let budget = prev.budget;
    if (next.budget?.currency === prev.budget.currency && next.budget.minor !== prev.budget.minor) {
      const up = next.budget.minor - prev.budget.minor;
      if (up < 0 || (consent?.budget === true && up <= (flex.budgetMinor ?? 0))) budget = next.budget;
    }
    let deadline = prev.deadline;
    const shift = (Date.parse(next.deadline) - Date.parse(prev.deadline)) / 3_600_000;
    if (Number.isFinite(shift) && shift !== 0 && (shift < 0 || (consent?.deadline === true && shift <= (flex.deadlineHours ?? 0)))) deadline = next.deadline;
    return { ...prev, budget, deadline, authority: narrower(prev.authority, next.authority) };
  };

  app.post('/api/intents/compile', async (c) => {
    const b = await body(c);
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 2000) throw new HttpError(400, 'bad_request', 'Describe what you need in a sentence or two');
    const s = typeof b.market === 'string' ? session(b.market) : undefined;
    const world = s?.world ?? need(engine.flagshipWorld, 'market')().world;
    const live = budget.take();
    const r = await need(engine.compileIntent, 'intent compiler')(b.text, world, { live });
    if (s && r?.intent) {
      s.intent = { ...r.intent, authority: narrower(s.intent.authority, r.intent.authority) };
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
    const opts = { ...(Number.isInteger(b.maxChanges) ? { maxChanges: b.maxChanges } : {}), ...(Number.isInteger(b.k) ? { k: Math.min(10, b.k) } : {}) };
    const interventions = await need(engine.findInterventions, 'inverse feasibility search')(s.world, s.intent, opts);
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

  /** Deadline and budget changes are the buyer's to grant; the request says which ones the buyer allows. */
  const consentFrom = (b: any) => {
    const given = b?.consent && typeof b.consent === 'object' ? b.consent : {};
    return (c: Concession): boolean | undefined => {
      if (c.target.kind !== 'intent') return undefined;
      const v = given[c.target.field];
      return typeof v === 'boolean' ? v : undefined;
    };
  };

  /**
   * A buyer-chosen set of changes to negotiate (a what-if branch). Strict: known offers, fields those offers list as
   * negotiable, well-formed values, intent changes only inside the flex the buyer stated and never above the spending limit.
   * Whether a set unlocks the order is decided by re-solving, never taken from the request.
   */
  const chosenInterventions = async (s: Session, raw: unknown) => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) throw new HttpError(400, 'bad_request', 'Send between 1 and 5 interventions');
    const offers = new Map(s.world.offers.map((o) => [o.id, o]));
    const flex = s.intent.negotiable ?? {};
    const max = s.intent.authority?.maxSpend;
    const bad = (why: string): never => {
      throw new HttpError(422, 'bad_intervention', why);
    };
    const out: any[] = [];
    for (const [i, iv] of raw.entries()) {
      const cs = (iv as any)?.concessions;
      if (!Array.isArray(cs) || cs.length === 0 || cs.length > 6) bad(`Intervention ${i + 1} needs between 1 and 6 changes`);
      const concessions = cs.map((c: any, j: number) => {
        const t = c?.target;
        const id = typeof c?.id === 'string' && c.id.length <= 80 ? c.id : `chosen-${i + 1}-${j + 1}`;
        const rationale = typeof c?.rationale === 'string' ? c.rationale.slice(0, 300) : 'Chosen by the buyer.';
        const estimate = isMoney(c?.estimate) && c.estimate.currency === s.world.currency ? c.estimate : { currency: s.world.currency, minor: 0 };
        if (t?.kind === 'offer') {
          const o = offers.get(t.offer);
          if (!o) return bad(`Offer ${String(t.offer).slice(0, 40)} is not in this market`);
          if (!o.negotiable.includes(t.field)) bad(`${o.id} does not list ${String(t.field).slice(0, 20)} as negotiable`);
          const time = t.field === 'windowEnd' || t.field === 'windowStart';
          if (t.field === 'joint') {
            if (typeof c.to !== 'string' || !/^joint:shared:[\w-]+(>[\w-]+)+$/.test(c.to)) bad('A joint change must name a shared offer');
            const members = String(c.to).slice('joint:shared:'.length).split('>');
            if (!members.includes(o.id) || members.some((m: string) => !offers.get(m)?.negotiable.includes('joint'))) bad('Every member of a joint change must be an offer that lists joint delivery');
          } else if (time ? typeof c.to !== 'string' || Number.isNaN(Date.parse(c.to)) : !Number.isInteger(c.to) || c.to < 0) bad(`Change ${id} has an invalid value`);
          const from = t.field === 'joint' ? 'separate' : time ? (t.field === 'windowEnd' ? o.window.end : o.window.start) : t.field === 'capacity' ? o.capacity : t.field === 'minQty' ? o.minQty : t.field === 'setupFee' ? o.setupFee.minor : (o.tiers[0]?.unit.minor ?? 0);
          return { id, target: { kind: 'offer', offer: o.id, field: t.field }, from, to: time ? new Date(c.to).toISOString() : c.to, estimate, rationale };
        }
        if (t?.kind === 'intent' && t.field === 'budget') {
          if (!Number.isInteger(c.to) || c.to < s.intent.budget.minor || c.to - s.intent.budget.minor > (flex.budgetMinor ?? 0)) bad('A budget change must stay inside the flex the buyer stated');
          if (max && c.to > max.minor) bad('A budget change cannot exceed the spending limit');
          return { id, target: { kind: 'intent', field: 'budget' }, from: s.intent.budget.minor, to: c.to, estimate, rationale };
        }
        if (t?.kind === 'intent' && t.field === 'deadline') {
          const shift = (Date.parse(c.to) - Date.parse(s.intent.deadline)) / 3_600_000;
          if (!Number.isFinite(shift) || shift < 0 || shift > (flex.deadlineHours ?? 0)) bad('A deadline change must stay inside the flex the buyer stated');
          return { id, target: { kind: 'intent', field: 'deadline' }, from: s.intent.deadline, to: new Date(c.to).toISOString(), estimate, rationale };
        }
        return bad(`Change ${id} targets something that cannot be negotiated`);
      });
      let unlocks = false;
      let totalAfter: Money | undefined;
      try {
        const next = need(engine.applyConcessions, 'inverse feasibility')(s.world, s.intent, concessions);
        const r = await need(engine.solve, 'solver')(next.world, next.intent);
        unlocks = (r.status === 'optimal' || r.status === 'feasible') && Boolean(r.plan);
        totalAfter = r.plan?.total;
      } catch (e) {
        if (e instanceof Unavailable) throw e;
        bad(`Intervention ${i + 1} cannot be applied to this market`);
      }
      out.push({ id: typeof (iv as any).id === 'string' ? String((iv as any).id).slice(0, 80) : `chosen-${i + 1}`, concessions, unlocks, ...(totalAfter ? { totalAfter } : {}), method: 'heuristic', minimality: 'Chosen by the buyer; no minimality claim.' });
    }
    return out;
  };

  app.post('/api/markets/:id/negotiate', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (!s.intent.authority?.mayNegotiate) throw new HttpError(403, 'scope', 'The buyer has not allowed negotiation');
    const chosen = await chosenInterventions(s, b.interventions);
    const live = budget.take();
    const maxQuestions = Number.isInteger(b.maxQuestions) && b.maxQuestions > 0 ? Math.min(20, b.maxQuestions) : undefined;
    const run = await need(engine.negotiate, 'negotiation')(s.world, s.intent, truthFor(s), { live, maxQuestions, buyerConsent: consentFrom(b), ...(chosen ? { chosen } : {}) });
    s.run = without(run, 'world', 'before');
    s.decisions = run.decisions ?? s.decisions;
    if (run.world) s.world = run.world;
    if (run.intent) s.intent = consentedIntent(s.intent, run.intent, b.consent);
    const plan: Plan | undefined = run.plan ?? (run.verification?.ok === false ? undefined : run.report?.plan);
    if (plan) s.plans[plan.id] = plan;
    store.save(s);
    index(s);
    const accepts: string[] = [];
    for (const m of run.messages ?? []) {
      const ev = store.emit(s.id, 'negotiation.message', m, m.type === 'Propose' || m.type === 'AskPreference' ? 'solver' : 'synthetic-market', { actor: m.from });
      if (m.type === 'Accept') accepts.push(ev.id);
    }
    const decided: string[] = [];
    for (const d of run.decisions ?? []) decided.push(store.emit(s.id, 'negotiation.decision', d, d.basis === 'seller-terminal' ? 'seller-terminal' : 'synthetic-market').id);
    if (plan) {
      const causes = accepts.length ? accepts : decided.length ? decided : undefined;
      store.emit(s.id, 'solve.completed', { status: run.report?.status ?? 'feasible', solver: run.report?.solver ?? null, plan: plan.id, total: plan.total, after: 'negotiation', unlockedBy: run.unlockedBy ?? null }, 'solver', { causes });
    }
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

  /** Every party signs the exact terms hash: the buyer by asking to commit, each supplier only for terms it already offers. */
  const signAndCommit = (s: Session, draft: Agreement, why: string, recovery?: string) => {
    if (draft.state === 'COMMITTED' || !engine.sign) return { agreement: draft, acceptedBy: [] as string[] };
    const { agreement, accepts, declined } = engine.sign(draft, s.world, truthFor(s));
    const acceptedBy: string[] = [];
    const causes = store.causal.get(s.id, [recovery ? `recovery:${recovery}` : null, `verify:${draft.plan}`, `plan:${draft.plan}`]);
    for (const m of accepts) {
      const buyer = !agreement.obligations.some((o) => o.actor === (m as any).from);
      acceptedBy.push(store.emit(s.id, 'negotiation.message', m, buyer ? 'buyer' : 'synthetic-market', { actor: (m as any).from, causes }).id);
    }
    if (agreement.state !== 'COMMITTED') {
      const names = declined.map((d) => `${s.world.actors.find((a) => a.id === d.actor)?.name ?? d.actor} (${d.reason})`).join(', ');
      throw new HttpError(409, 'not_accepted', `${why} is not accepted by every party yet${names ? `: ${names}` : ''}`);
    }
    return { agreement, acceptedBy };
  };

  const emitAgreement = (s: Session, a: Agreement, extra: Record<string, unknown> = {}) => {
    store.emit(s.id, 'agreement.state', { agreement: a, state: a.state, termsHash: a.termsHash, plan: a.plan, ...extra }, 'solver');
    for (const o of a.obligations) store.emit(s.id, 'obligation.state', { obligation: o, state: o.state }, 'solver', { actor: o.actor });
  };

  app.post('/api/agreements/:id/commit', async (c) => {
    // The path id names the plan being committed; the agreement id is minted at commit.
    const b = await body(c);
    const { s, plan } = findPlan(c.req.param('id'), b.market);
    if (s.agreement) return c.json(s.agreement);
    if (!s.intent.authority?.mayReserve) throw new HttpError(403, 'scope', 'The buyer has not allowed reservations');
    const v = need(engine.verifyPlan, 'plan verifier')(plan, s.world, s.intent);
    if (!v.ok) throw new HttpError(422, 'unverified', 'This plan did not pass independent verification');
    s.verified[plan.id] = true;
    if (plan.total.minor > s.intent.budget.minor) throw new HttpError(422, 'over_budget', 'Plan exceeds the budget');
    let draft: Agreement;
    try {
      draft = await need(engine.commit, 'obligations')(plan, s.intent, s.decisions, { world: s.world });
    } catch (e) {
      obligationError(e);
      throw e;
    }
    const { agreement, acceptedBy } = signAndCommit(s, draft, 'This agreement');
    s.agreement = agreement;
    store.save(s);
    index(s);
    emitAgreement(s, agreement, { acceptedBy });
    return c.json(agreement, 201);
  });

  // ---------- payments: money only moves behind a buyer approval bound to terms and amount ----------
  /** What is still owed to a payee: live obligations not already covered by a payment that is open or captured. */
  const owedTo = (s: Session, agreement: Agreement, payee: string) => {
    const covered = new Set(Object.values(s.payments).filter((p) => p.agreement === agreement.id && !SPENT.includes(p.state)).flatMap((p) => p.obligations));
    const mine = agreement.obligations.filter((o) => o.actor === payee && o.state !== 'CANCELLED' && o.state !== 'REPLACED' && !covered.has(o.id));
    if (!mine.length) return null;
    return { obligations: mine.map((o) => o.id), amount: { currency: mine[0]!.amount.currency, minor: mine.reduce((a, o) => a + o.amount.minor, 0) } as Money };
  };

  const hasGrant = (s: Session, a: Agreement) => s.grants?.[a.id]?.termsHash === a.termsHash && !s.withheld?.includes('mayPreparePayments');
  /** Authority for preparing this agreement's payments: the intent's own, widened only by a grant for this exact agreement version. */
  const authorityFor = (s: Session, a: Agreement) => (hasGrant(s, a) ? { ...s.intent.authority, mayPreparePayments: true } : s.intent.authority);

  app.post('/api/agreements/:id/approve-payment', async (c) => {
    const b = await body(c);
    const { s, agreement } = findAgreement(c.req.param('id'), b.market);
    if (agreement.state !== 'COMMITTED' && agreement.state !== 'FULFILLING') throw new HttpError(409, 'state', 'Agreement is not committed');
    if (s.withheld?.includes('mayPreparePayments')) throw new HttpError(403, 'scope', 'The buyer has not allowed payment preparation');
    if (b.termsHash !== agreement.termsHash) throw new HttpError(409, 'terms_changed', 'The agreement terms changed since you reviewed them');
    const due = typeof b.payee === 'string' ? owedTo(s, agreement, b.payee) : null;
    if (!due) throw new HttpError(404, 'not_found', 'Nothing is owed to that supplier');
    if (!isMoney(b.amount) || !sameMoney(b.amount, due.amount)) throw new HttpError(409, 'amount_mismatch', 'Approved amount does not match what is owed');
    const max = s.intent.authority?.maxSpend;
    if (max && s.approvals.spent + due.amount.minor > max.minor) throw new HttpError(403, 'over_limit', 'This would exceed the buyer spending limit');
    // Approving this agreement is the buyer's grant of payment authority for exactly this agreement version.
    if (!s.intent.authority?.mayPreparePayments && !hasGrant(s, agreement)) {
      s.grants = { ...(s.grants ?? {}), [agreement.id]: { termsHash: agreement.termsHash, at: new Date().toISOString() } };
      store.save(s);
      store.emit(s.id, 'intent.compiled', { intent: s.intent.id, grant: { scope: 'mayPreparePayments', agreement: agreement.id, version: agreement.version, termsHash: agreement.termsHash }, changedBy: 'buyer' }, 'buyer', { causes: store.causal.get(s.id, [`agreement:${agreement.id}`]) });
    }
    const { token, claim } = approvals.issue({ kind: 'pay', market: s.id, agreement: agreement.id, subject: b.payee, termsHash: agreement.termsHash, amount: due.amount });
    return c.json({ approvalToken: token, expiresAt: new Date(claim.exp).toISOString(), amount: due.amount, obligations: due.obligations });
  });


  const returnBase = (c: Context) => {
    const origin = c.req.header('origin');
    if (origin && originAllowed(origin, c.req.header('host'))) return origin;
    try {
      return new URL(c.req.url).origin;
    } catch {
      return undefined;
    }
  };

  /** Takes the payment module's result as the new truth for this payment and records the change. */
  const adopt = (s: Session, pi: PaymentIntent, next: PaymentIntent, extra: Record<string, unknown> = {}) => {
    const changed = next.state !== pi.state || next.paypal.captureId !== pi.paypal.captureId || next.paypal.refunds.length !== pi.paypal.refunds.length;
    pi.state = next.state;
    pi.paypal = next.paypal;
    store.save(s);
    if (changed || Object.keys(extra).length) store.emit(s.id, 'payment.state', { payment: pi, state: pi.state, paypalStatus: pi.paypal.status ?? null, ...extra }, 'paypal-sandbox', { actor: pi.payee });
  };
  const refused = (e: any) => e?.name === 'PayPalApiError' && e.outcomeUnknown === false;
  /** Money moves only through the payments module: reconcile before retry, refunds bounded by what was captured. */
  const pay = {
    open: engine.payments?.open ?? paypalModule.openOrder,
    capture: engine.payments?.capture ?? paypalModule.capturePayment,
    refund: engine.payments?.refund ?? paypalModule.refundPayment,
    reconcile: engine.payments?.reconcile ?? paypalModule.reconcile,
    refundable: engine.payments?.refundable ?? paypalModule.refundable,
  };
  const paypalTrouble = (what: string, pi: PaymentIntent, e?: any) => {
    const r = pi.paypal as any;
    console.error(`paypal ${what}: payment ${pi.id} state ${pi.state} issue ${e?.issue ?? r.issue ?? 'none'} name ${e?.errorName ?? 'none'} debug ${e?.debugId ?? r.debugIds?.at(-1) ?? 'none'}`);
  };

  app.post('/api/payments/orders', async (c) => {
    const b = await body(c);
    if (typeof b.approvalToken !== 'string') throw new HttpError(403, 'approval_required', 'A buyer approval is required before any payment is created');
    const claim = approvals.verify(b.approvalToken);
    if (!claim || claim.kind !== 'pay') throw new HttpError(403, 'approval_invalid', 'The buyer approval is missing, expired or invalid');
    const gw = needGateway();
    if (claim.market && typeof b.market === 'string' && b.market !== claim.market) throw new HttpError(409, 'approval_mismatch', 'The approval was given in a different session');
    const { s, agreement } = findAgreement(claim.agreement, claim.market ?? b.market);
    if (typeof b.agreementId === 'string' && b.agreementId !== agreement.id) throw new HttpError(409, 'approval_mismatch', 'The approval is for a different agreement');
    const operationKey = createHash('sha256').update(`${agreement.id}|${agreement.termsHash}|${claim.subject}|${claim.amount.minor}|${claim.nonce}`).digest('hex').slice(0, 32);
    const existing = Object.values(s.payments).find((p) => p.operationKey === operationKey);
    if (existing) return c.json(existing);
    const due = owedTo(s, agreement, claim.subject);
    if (agreement.termsHash !== claim.termsHash || !due || !sameMoney(due.amount, claim.amount)) throw new HttpError(409, 'approval_stale', 'The approval no longer matches the agreement');
    if (usedTokens.has(claim.nonce)) throw new HttpError(403, 'approval_used', 'This approval was already used');
    if (!authorityFor(s, agreement)?.mayPreparePayments) throw new HttpError(403, 'scope', 'The buyer has not allowed payment preparation for this agreement');
    usedTokens.add(claim.nonce);
    const max = s.intent.authority?.maxSpend;
    if (max && s.approvals.spent + due.amount.minor > max.minor) throw new HttpError(403, 'over_limit', 'This would exceed the buyer spending limit');
    const pi: PaymentIntent = {
      id: `pay-${randomUUID().slice(0, 12)}`, operationKey, agreement: agreement.id, obligations: due.obligations,
      payee: claim.subject, amount: due.amount, charged: due.amount, state: 'PAYMENT_PROPOSED',
      paypal: { env: 'sandbox', refunds: [], debugIds: [] },
    };
    s.payments[pi.id] = pi;
    s.approvals.spent += due.amount.minor;
    const payeeName = s.world.actors.find((a) => a.id === pi.payee)?.name ?? pi.payee;
    const stageName = (id: string) => s.world.stages.find((x) => x.id === id)?.name ?? id;
    const lines = agreement.obligations.filter((o) => due.obligations.includes(o.id)).map((o) => ({ obligation: o.id, name: `${stageName(o.stage)}, ${payeeName}`.slice(0, 127), amount: o.amount }));
    const base = returnBase(c);
    const orderOpts = {
      description: `${s.world.name}: ${payeeName}`.slice(0, 127), lines,
      ...(base ? { returnUrl: `${base}/?paypal=return&payment=${pi.id}`, cancelUrl: `${base}/?paypal=cancel&payment=${pi.id}` } : {}),
    };
    const extra = { approvedBy: 'buyer', gateway: gw.kind ?? 'paypal-sandbox' };
    try {
      adopt(s, pi, await pay.open(pi, gw, { ...orderOpts, authority: authorityFor(s, agreement) }), extra);
      paymentIndex.set(pi.id, s.id);
    } catch (e: any) {
      paypalTrouble('create order failed', pi, e);
      usedTokens.delete(claim.nonce);
      s.approvals.spent -= due.amount.minor;
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
        adopt(s, pi, await pay.reconcile(pi, gw));
        pi.paypal.lastFetchedAt = new Date().toISOString();
        store.save(s);
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
      adopt(s, pi, await pay.capture(pi, gw));
    } catch (e: any) {
      paypalTrouble('capture failed', pi, e);
      if (refused(e)) throw new HttpError(409, 'refused', `PayPal refused the capture${e.issue ? ` (${e.issue})` : ''}`);
      pi.state = 'CAPTURE_UNKNOWN';
      store.save(s);
      store.emit(s.id, 'payment.state', { payment: pi, state: pi.state }, 'paypal-sandbox', { actor: pi.payee });
      throw new HttpError(503, 'capture_unknown', 'Capture outcome unknown. Retrieve the payment to reconcile before retrying');
    }
    if (pi.state === 'PAYER_ACTION_REQUIRED') throw new HttpError(409, 'not_approved', 'The buyer has not approved this order on PayPal yet');
    if (pi.state === 'CAPTURE_DENIED') paypalTrouble('capture denied', pi);
    return c.json(pi);
  });

  const REFUNDABLE: PaymentState[] = ['CAPTURE_COMPLETED', 'REFUND_COMPLETED', 'REFUND_DENIED'];

  app.post('/api/payments/:id/approve-refund', async (c) => {
    const b = await body(c);
    const { s, pi } = findPayment(c.req.param('id'));
    const { agreement } = findAgreement(pi.agreement, s.id);
    if (!REFUNDABLE.includes(pi.state) || !pi.paypal.captureId) throw new HttpError(409, 'state', 'Only captured payments can be refunded');
    const left: Money = pay.refundable(pi);
    const amount = isMoney(b.amount) ? b.amount : left;
    if (amount.currency !== left.currency || amount.minor <= 0 || amount.minor > left.minor) throw new HttpError(409, 'amount_mismatch', 'Refund amount is out of range');
    const { token } = approvals.issue({ kind: 'refund', market: s.id, agreement: agreement.id, subject: pi.id, termsHash: agreement.termsHash, amount });
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
    // A refused refund is final for its request id (PayPal replays the stored answer), so a new attempt needs the next sequence.
    const sequence = pi.paypal.refunds.length + (s.refundRefusals?.[pi.id] ?? 0);
    try {
      adopt(s, pi, await pay.refund(pi, gw, claim.amount, { sequence }), { approvedBy: 'buyer' });
    } catch (e: any) {
      paypalTrouble('refund failed', pi, e);
      if (refused(e) || e?.name === 'MoneyError' || e?.name === 'PaymentInvariantError') throw new HttpError(409, 'refused', 'The refund was refused');
      pi.state = 'REFUND_UNKNOWN';
      store.save(s);
      throw new HttpError(503, 'refund_unknown', 'Refund outcome unknown. Retrieve the payment to reconcile');
    }
    if (pi.state === 'REFUND_DENIED') {
      paypalTrouble('refund denied', pi);
      s.refundRefusals = { ...(s.refundRefusals ?? {}), [pi.id]: (s.refundRefusals?.[pi.id] ?? 0) + 1 };
      store.save(s);
      const issue = (pi.paypal as any).issue as string | undefined;
      const why = issue === 'REFUND_FAILED_INSUFFICIENT_FUNDS' ? 'the merchant PayPal account does not hold enough funds in this currency' : issue ? issue.toLowerCase().replace(/_/g, ' ') : 'no reason given';
      throw new HttpError(409, 'refund_denied', `PayPal declined the refund: ${why}. Nothing was refunded; you can approve the refund again later.`);
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
    let payment: string | null = null;
    for (const sess of store.sessions.values()) {
      const hit = Object.values(sess.payments).find((p) => p.paypal.orderId === orderId || p.paypal.captureId === resId);
      if (hit) {
        market = sess.id;
        payment = hit.id;
      }
    }
    const summary = { id: eid, type: ev.event_type, resource: resId ?? null, status: ev?.resource?.status ?? null, payment };
    store.emit('_webhooks', 'paypal.webhook', summary, 'paypal-sandbox');
    if (market) store.emit(market, 'paypal.webhook', summary, 'paypal-sandbox');
    return c.json({ ok: true });
  });

  // ---------- disruption and recovery ----------
  const KINDS = ['withdraw', 'capacity-drop', 'delay', 'price-change', 'claim-overturned', 'payment-failed'];
  const ids = (l: any[] | undefined) => (l ?? []).map((o: any) => (typeof o === 'string' ? o : o.id));

  app.post('/api/markets/:id/disrupt', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (!s.agreement) throw new HttpError(409, 'state', 'Nothing is committed yet');
    if (!KINDS.includes(b.kind)) throw new HttpError(400, 'bad_request', 'Unknown disruption kind');
    const str = (v: unknown) => (typeof v === 'string' && v.length <= 120 ? v : undefined);
    // Market time: an explicit valid time, else the moment the agreement was made.
    const at = typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : s.agreement.createdAt;
    // A supplier withdrawing from a joint delivery withdraws its own offer; the joint offer then fails with it.
    const jointWithdraw = b.kind === 'withdraw' && typeof b.actor === 'string' && typeof b.offer === 'string' && !s.world.offers.some((o) => o.id === b.offer && o.actor === b.actor && !o.derivedFrom?.coalition && !o.id.startsWith('joint:'));
    const own = jointWithdraw ? s.world.offers.find((o) => o.actor === b.actor && !o.id.startsWith('joint:') && !o.derivedFrom?.coalition) : undefined;
    const d: Disruption = { id: `d-${randomUUID().slice(0, 8)}`, kind: b.kind, actor: str(b.actor), offer: jointWithdraw ? own?.id : str(b.offer), detail: String(b.detail ?? b.kind).slice(0, 300), at };
    if (b.params && typeof b.params === 'object') {
      const p: Record<string, number | string> = {};
      for (const k of ['capacity', 'delayHours', 'unitPriceMinor', 'pricePercent', 'claim']) if (typeof b.params[k] === 'number' || typeof b.params[k] === 'string') p[k] = b.params[k];
      (d as any).params = p;
    }
    const r = await need(engine.disrupt, 'obligations')(s.agreement, s.world, d, { payments: Object.values(s.payments) });
    s.world = r.world ?? s.world;
    s.disruptions.push(d);
    store.save(s);
    store.emit(s.id, 'disruption.applied', { disruption: d, affected: ids(r.affected), atRisk: ids(r.atRisk), endangeredPayments: r.endangeredPayments ?? [] }, 'solver', { actor: d.actor });
    return c.json({ ...without(r, 'world'), disruption: d, affected: r.affected ?? [], world: s.world });
  });

  app.post('/api/markets/:id/recover', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (!s.agreement) throw new HttpError(409, 'state', 'Nothing is committed yet');
    const list = s.disruptions as Disruption[];
    const d = list.find((x) => x.id === b.disruption) ?? list.at(-1);
    if (!d) throw new HttpError(409, 'state', 'No disruption to recover from');
    const recover = need(engine.recover, 'recovery');
    const payments = Object.values(s.payments);
    // Purchased standby options are called first: they replace a failed obligation without touching any other.
    const O = engine.options;
    const held: any[] = (s.options as any)?.options ?? [];
    const purchased = held.filter((o) => o.status === 'purchased');
    let optionNote: string | null = null;
    if (purchased.length && O?.exerciseOption) {
      const ex = O.exerciseOption(s.agreement, s.world, s.intent, d, held, O.heldCapacity ? { reservedElsewhere: O.heldCapacity(held) } : {});
      optionNote = ex.reason ?? null;
      if (ex.exercised && ex.recovery) {
        const rec = { ...ex.recovery, amendment: ex.amendment, plan: ex.plan, verification: ex.verification, replacements: ex.replacements, source: 'standby-option', reason: ex.reason };
        s.world = ex.world ?? s.world;
        s.options = { ...((s.options as any) ?? {}), options: ex.options ?? held, exercise: { exercised: true, reason: ex.reason, disruption: d.id } };
        s.recoveries.push(rec);
        store.save(s);
        for (const m of ex.notices ?? []) store.emit(s.id, 'negotiation.message', m, 'buyer', { actor: m.from, causes: store.causal.get(s.id, [`disruption:${d.id}`]) });
        for (const o of (ex.options ?? []).filter((x: any) => x.status === 'exercised')) {
          store.emit(s.id, 'agreement.state', { agreement: o.agreement, state: o.agreement.state, termsHash: o.agreement.termsHash, option: o.id }, 'buyer', { causes: store.causal.get(s.id, [`disruption:${d.id}`]) });
        }
        store.emit(s.id, 'recovery.proposed', { recovery: rec }, 'solver');
        return c.json({ ...rec, recovery: rec, agreement: ex.amendment ?? s.agreement, exercised: true, notices: ex.notices ?? [] });
      }
    }
    // Held standby units are off the open market; the options themselves are offers recovery may use.
    const base = purchased.length && O?.withStandby ? O.withStandby(s.world, purchased, d.at) : s.world;
    let rec = await recover(s.agreement, base, s.intent, d, { payments });
    let negotiated: any = null;
    // With published offers exhausted, suppliers are asked for the smallest change; their private policies answer.
    if (!rec.feasible && engine.negotiate && b.negotiate !== false && s.intent.authority?.mayNegotiate) {
      const run = await engine.negotiate(rec.world ?? s.world, s.intent, truthFor(s), { buyerConsent: consentFrom(b), explain: false });
      if (run.accepted?.length && run.world) {
        const again = await recover(s.agreement, run.world, s.intent, d, { payments });
        const accepts: string[] = [];
        for (const m of run.messages ?? []) {
          const ev = store.emit(s.id, 'negotiation.message', m, m.type === 'Propose' || m.type === 'AskPreference' ? 'solver' : 'synthetic-market', { actor: m.from });
          if (m.type === 'Accept') accepts.push(ev.id);
        }
        for (const dec of run.decisions ?? []) store.emit(s.id, 'negotiation.decision', dec, dec.basis === 'seller-terminal' ? 'seller-terminal' : 'synthetic-market');
        negotiated = { outcome: run.outcome, accepted: run.accepted, messages: run.messages?.length ?? 0, feasibleAfter: again.feasible };
        if (again.feasible) {
          rec = again;
          s.decisions = [...s.decisions, ...(run.decisions ?? [])];
        }
      } else negotiated = { outcome: run.outcome, accepted: [], messages: run.messages?.length ?? 0, feasibleAfter: false };
    }
    const kept = { ...without(rec, 'world'), ...(negotiated ? { negotiated } : {}), ...(optionNote ? { options: optionNote } : {}) };
    s.recoveries.push(kept);
    if (rec.world) s.world = rec.world;
    store.save(s);
    store.emit(s.id, 'recovery.proposed', { recovery: kept }, 'solver');
    return c.json({ ...rec, ...(negotiated ? { negotiated } : {}), recovery: kept, agreement: rec.amendment ?? s.agreement });
  });

  app.post('/api/markets/:id/recover/commit', async (c) => {
    const s = session(c.req.param('id'));
    const b = await body(c);
    if (!s.agreement) throw new HttpError(409, 'state', 'Nothing is committed yet');
    const recs = s.recoveries as any[];
    const rec = recs.find((r) => r.id === b.recovery) ?? recs.at(-1);
    if (!rec) throw new HttpError(409, 'state', 'No recovery to commit');
    if (!rec.feasible) throw new HttpError(422, 'infeasible', 'This recovery is not feasible');
    if (!rec.amendment) return c.json({ agreement: s.agreement, recovery: rec.id, changed: false });
    if (rec.amendment.version !== s.agreement.version + 1) throw new HttpError(409, 'stale', 'The agreement changed since this recovery was proposed');
    if (b.termsHash !== undefined && b.termsHash !== rec.amendment.termsHash) throw new HttpError(409, 'terms_changed', 'The amended terms changed since you reviewed them');
    const signed = signAndCommit(s, rec.amendment, 'The amended agreement', rec.id);
    const prior = s.agreement;
    let superseded: Agreement = { ...prior, state: 'AMENDED' };
    let agreement = signed.agreement;
    let moved: any[] = [];
    if (engine.commitRecovery) {
      try {
        const r = engine.commitRecovery(prior, rec, signed.agreement.acceptances);
        superseded = r.original;
        agreement = r.amended;
        moved = r.obligations;
      } catch (e) {
        obligationError(e);
      }
    }
    s.history = [...(s.history ?? []), { ...superseded, obligations: superseded.obligations.map((o) => moved.find((x) => x.id === o.id) ?? o) }];
    s.agreement = agreement;
    store.save(s);
    index(s);
    store.emit(s.id, 'agreement.state', { agreement: superseded, state: superseded.state, termsHash: superseded.termsHash, plan: superseded.plan, recovery: rec.id }, 'solver');
    for (const o of moved) store.emit(s.id, 'obligation.state', { obligation: o, state: o.state, recovery: rec.id }, 'solver', { actor: o.actor });
    emitAgreement(s, agreement, { acceptedBy: signed.acceptedBy, recovery: rec.id });
    store.emit(s.id, 'recovery.committed', { recovery: rec }, 'solver');
    return c.json({ agreement, recovery: rec.id, changed: true });
  });

  // ---------- observation ----------
  app.get('/api/markets/:id/events', (c) => {
    const id = c.req.param('id');
    session(id);
    if (c.req.query('format') === 'json') return c.json({ events: store.events(id) });
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

  registerDepth(app, { engine, store, session, truthFor, body, fail: (status, code, message) => new HttpError(status, code, message) });

  app.get('/api/config', (c) => {
    const live = Boolean(gateway) && (gateway.kind ?? 'paypal-sandbox') === 'paypal-sandbox';
    return c.json({ paypal: { env: 'sandbox', clientId: live && config.paypalClientId ? config.paypalClientId : null, currency: 'SEK', intent: 'capture' } });
  });

  app.get('/api/status', (c) => {
    let payments = 0;
    let agreements = 0;
    for (const s of store.sessions.values()) {
      payments += Object.keys(s.payments).length;
      if (s.agreement) agreements += 1;
    }
    const kind: string = gateway ? (gateway.kind ?? 'paypal-sandbox') : 'none';
    return c.json({
      ok: true,
      version: VERSION,
      build,
      paypal: { env: 'sandbox', configured: kind === 'paypal-sandbox', gateway: kind, ...(kind === 'paypal-sandbox' && config.paypalClientId ? { clientId: config.paypalClientId, currency: 'SEK' } : {}) },
      services: {
        ...availability(engine),
        paypalConfigured: kind === 'paypal-sandbox',
        paymentsGateway: kind,
        negotiateInterventions: typeof engine.negotiate === 'function' && typeof engine.applyConcessions === 'function',
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
