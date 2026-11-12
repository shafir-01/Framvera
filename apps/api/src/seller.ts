import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Concession, Disruption, Intent, NegotiableField, NegotiationMessage, Offer, Plan, SupplierDecision, World } from '@framvera/contracts';
import type { Engine } from './engine.ts';
import type { Config } from './config.ts';
import type { Session, Store } from './store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SellerCtx {
  engine: Engine;
  store: Store;
  config: Config;
  session: (id: string) => Session;
  truthFor: (s: Session) => any;
  takeLive: () => boolean;
}

type Answerable = Extract<NegotiationMessage, { type: 'Propose' } | { type: 'AskPreference' } | { type: 'CounterOffer' }>;
type Action = 'accept' | 'reject' | 'counter';

const HOUR = 3_600_000;
const SEAT_TTL = 30 * 60_000;
const SESSION_TTL = 4 * HOUR;
export const TERMINAL_LABEL = 'answered by a person at the seller terminal';

class AwaitSeller extends Error {
  constructor(public actor: string, public termsHash: string) {
    super('awaiting seller');
  }
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** Same bytes the negotiation loop signs on Accept, so a seller's hash and the typed Accept agree. */
export const termsHashOf = (c: Concession): string =>
  createHash('sha256').update(canonicalJson({ target: c.target, from: c.from, to: c.to })).digest('hex');

const concessionOf = (m: Answerable): Concession => (m.type === 'AskPreference' ? m.question : m.concession);
const isTime = (f: string) => f === 'windowEnd' || f === 'windowStart' || f === 'deadline';

function numeric(field: string, v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (isTime(field)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

const group = (n: number) => Math.trunc(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const kr = (minor: number, cur = 'SEK') => {
  const whole = Math.trunc(Math.abs(minor) / 100);
  const frac = Math.abs(minor) % 100;
  const body = group(whole) + (frac ? `,${String(frac).padStart(2, '0')}` : '');
  return `${minor < 0 ? '-' : ''}${body}${cur === 'SEK' ? ' kr' : ` ${cur}`}`;
};
const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const at = (ms: number) => when.format(new Date(ms)).replace(',', '');
const hours = (h: number) => `${Math.round(h * 10) / 10} h`;
const FIELD_LABEL: Record<NegotiableField, string> = {
  unitPrice: 'Unit price', windowEnd: 'Latest finish', windowStart: 'Earliest start', capacity: 'Capacity', minQty: 'Minimum order', setupFee: 'Setup fee', joint: 'Joint delivery',
};

function unitPriceAt(offer: Offer, qty: number): number {
  let p = offer.tiers[0]?.unit.minor ?? 0;
  for (const t of offer.tiers) if (qty >= t.minQty) p = t.unit.minor;
  return p;
}

interface Pending {
  termsHash: string;
  message: Answerable;
  concession: Concession;
  askedAt: string;
}
interface Answer {
  termsHash: string;
  action: Action;
  decision: SupplierDecision;
  at: string;
}
interface Claim {
  k: 'seat' | 'sess';
  market: string;
  actor: string;
  nonce: string;
  exp: number;
}

export function register(app: Hono, ctx: SellerCtx) {
  const secret = ctx.config.approvalSecret ? Buffer.from(`seat:${ctx.config.approvalSecret}`) : randomBytes(32);
  const sign = (p: string) => createHmac('sha256', secret).update(p).digest('base64url');
  const issue = (c: Omit<Claim, 'nonce' | 'exp'>, ttl: number, nonce = randomBytes(12).toString('hex')) => {
    const claim: Claim = { ...c, nonce, exp: Date.now() + ttl };
    const p = Buffer.from(JSON.stringify(claim)).toString('base64url');
    return { token: `${p}.${sign(p)}`, claim };
  };
  const verify = (token: unknown, k: Claim['k']): Claim | null => {
    if (typeof token !== 'string' || token.length > 1500) return null;
    const [p, sig] = token.split('.');
    if (!p || !sig) return null;
    const good = Buffer.from(sign(p));
    const got = Buffer.from(sig);
    if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
    try {
      const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claim;
      return c.k === k && c.exp > Date.now() ? c : null;
    } catch {
      return null;
    }
  };

  const key = (market: string, actor: string) => `${market}|${actor}`;
  const seats = new Map<string, { sid: string; seatedAt: string }>();
  const usedSeatTokens = new Set<string>();
  const pending = new Map<string, Pending>();
  const answers = new Map<string, Map<string, Answer>>();
  const announced = new Set<string>();
  const withdrawn = new Set<string>();
  const running = new Set<string>();

  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 501, code: string, message: string) => c.json({ error: { code, message } }, status);
  const body = async (c: Context): Promise<any> => {
    try {
      const b = await c.req.json();
      return b && typeof b === 'object' ? b : {};
    } catch {
      return {};
    }
  };
  const seatedIn = (market: string) => [...seats.keys()].filter((k) => k.startsWith(`${market}|`)).map((k) => k.slice(market.length + 1));

  /** Valid session bearer for exactly this market and actor, and that seat is still the current one. */
  const authorize = (c: Context, b: any, market: string, actor: string) => {
    const claim = verify(b.session, 'sess');
    if (!claim) return fail(c, 401, 'seat_required', 'Open the seat link you were given to start answering');
    if (claim.market !== market || claim.actor !== actor) return fail(c, 403, 'wrong_seat', 'This seat belongs to a different supplier');
    if (seats.get(key(market, actor))?.sid !== claim.nonce) return fail(c, 403, 'not_seated', 'This supplier is not currently answered by a person');
    return null;
  };

  const findActor = (w: World, id: string) => w.actors.find((a) => a.id === id);
  const ownOffers = (w: World, actor: string) => w.offers.filter((o) => o.actor === actor);

  // ---------- co-pilot: effect of one concession on the seller's own published terms, capacity and schedule. Private policy values never reach this view. ----------
  const planFor = (s: Session): Plan | undefined => {
    const plans = Object.values(s.plans);
    return plans.filter((p) => p.worldVersion === s.world.version).at(-1) ?? plans.at(-1);
  };
  const copilot = (s: Session, actor: string, c: Concession) => {
    const w = s.world;
    const cur = w.currency;
    const lines: { label: string; now: string; after: string }[] = [];
    const notes: string[] = [];
    if (c.target.kind !== 'offer') return { lines, notes: ['This change is the buyer’s decision.'] };
    const offer = w.offers.find((o) => o.id === (c.target as any).offer);
    if (!offer || offer.actor !== actor) return { lines, notes: ['This proposal does not match any of your offers.'] };
    const field = c.target.field;
    const stage = w.stages.find((x) => x.id === offer.stage);
    const alloc = planFor(s)?.allocations.find((a) => a.offer === offer.id && a.actor === actor);
    const qty = alloc?.qty ?? Math.min(offer.capacity, Math.round(s.intent.quantity * (stage?.perOutcome ?? 1)));
    const unit = stage?.unit ?? 'units';
    const to = numeric(field, c.to);
    const from = numeric(field, c.from);
    const price = unitPriceAt(offer, qty);
    const qtyLabel = alloc ? `Planned work: ${group(qty)} ${unit}` : `Expected work: ${group(qty)} ${unit}`;
    const needH = offer.ratePerHour > 0 ? qty / offer.ratePerHour : 0;
    const startMs = Date.parse(offer.window.start);
    const endMs = Date.parse(offer.window.end);

    switch (field) {
      case 'unitPrice': {
        if (to === undefined) break;
        lines.push({ label: 'Price per ' + unit.replace(/s$/, ''), now: kr(price, cur), after: kr(to, cur) });
        lines.push({ label: `Revenue on ${group(qty)} ${unit}`, now: kr(price * qty, cur), after: kr(to * qty, cur) });
        lines.push({ label: 'Change in revenue', now: '', after: kr((to - price) * qty, cur) });
        break;
      }
      case 'capacity': {
        if (to === undefined) break;
        const over = Math.max(0, to - offer.capacity);
        lines.push({ label: 'Capacity', now: `${group(offer.capacity)} ${unit}`, after: `${group(to)} ${unit}` });
        lines.push({ label: 'Share of capacity used', now: `${Math.round((qty / Math.max(1, offer.capacity)) * 100)}%`, after: `${Math.round((qty / Math.max(1, to)) * 100)}%` });
        if (over > 0) {
          notes.push(`${group(over)} ${unit} above what you published.`);
        }
        break;
      }
      case 'windowEnd':
      case 'windowStart': {
        if (to === undefined) break;
        const newStart = field === 'windowStart' ? to : startMs;
        const newEnd = field === 'windowEnd' ? to : endMs;
        const avail = (e: number, st: number) => (e - st) / HOUR;
        lines.push({ label: FIELD_LABEL[field], now: at(from ?? (field === 'windowEnd' ? endMs : startMs)), after: at(to) });
        lines.push({ label: 'Hours in your window', now: hours(avail(endMs, startMs)), after: hours(avail(newEnd, newStart)) });
        if (needH > 0) {
          lines.push({ label: `Hours needed for ${group(qty)} ${unit}`, now: hours(needH), after: hours(needH) });
          lines.push({ label: 'Spare hours', now: hours(avail(endMs, startMs) - needH), after: hours(avail(newEnd, newStart) - needH) });
          if (avail(newEnd, newStart) < needH) notes.push('The new window is shorter than the work needs.');
        }
        break;
      }
      case 'minQty':
        if (to === undefined) break;
        lines.push({ label: 'Minimum order', now: `${group(offer.minQty)} ${unit}`, after: `${group(to)} ${unit}` });
        lines.push({ label: qtyLabel, now: qty >= offer.minQty ? 'above minimum' : 'below minimum', after: qty >= to ? 'above minimum' : 'below minimum' });
        break;
      case 'setupFee':
        if (to === undefined) break;
        lines.push({ label: 'Setup fee', now: kr(offer.setupFee.minor, cur), after: kr(to, cur) });
        lines.push({ label: 'Change in revenue', now: '', after: kr(to - offer.setupFee.minor, cur) });
        break;
      case 'joint':
        lines.push({ label: 'Delivery', now: 'on your own', after: 'together with other suppliers' });
        break;
    }
    lines.push({ label: qtyLabel, now: alloc ? `${at(Date.parse(alloc.start))} to ${at(Date.parse(alloc.finish))}` : 'not scheduled yet', after: 'same schedule' });
    if (field !== 'unitPrice' && field !== 'setupFee' && field !== 'joint') {
      lines.push({ label: `Revenue on ${group(qty)} ${unit}`, now: kr(price * qty, cur), after: kr(price * qty, cur) });
    }
    const committed = (s.agreement?.obligations ?? []).filter((o) => o.actor === actor && o.state !== 'CANCELLED' && o.state !== 'REPLACED');
    if (committed.length) {
      const sum = committed.reduce((a, o) => a + o.qty, 0);
      notes.push(`Already committed in this market: ${group(sum)} ${unit}.`);
    }
    return { lines, notes };
  };

  const benefitOf = (s: Session, m: Answerable): string => {
    if (m.type === 'AskPreference') return m.benefit;
    const c = m.concession;
    const est = c.estimate ? ` Planner’s estimate of what this costs you: ${kr(c.estimate.minor, c.estimate.currency)}.` : '';
    return `${c.rationale}${est}`;
  };

  const describe = (s: Session, p: Pending) => {
    const c = p.concession;
    const t = c.target;
    const field: NegotiableField = t.kind === 'offer' ? t.field : ('joint' as NegotiableField);
    const offer = t.kind === 'offer' ? s.world.offers.find((o) => o.id === t.offer) : undefined;
    const cur = s.world.currency;
    const show = (v: number | string) => {
      const n = numeric(field, v);
      if (n === undefined) return String(v);
      if (isTime(field)) return at(n);
      if (field === 'unitPrice' || field === 'setupFee') return kr(n, cur);
      return group(n);
    };
    const input = isTime(field)
      ? { kind: 'time' as const, current: numeric(field, c.to) ?? null }
      : field === 'unitPrice' || field === 'setupFee'
        ? { kind: 'money' as const, current: numeric(field, c.to) ?? null }
        : { kind: 'int' as const, current: numeric(field, c.to) ?? null };
    const expires = p.message.type === 'Propose' || p.message.type === 'CounterOffer' ? p.message.expires : null;
    return {
      id: p.termsHash,
      termsHash: p.termsHash,
      type: p.message.type,
      messageId: p.message.id,
      from: 'Framvera',
      askedAt: p.askedAt,
      expires,
      offer: offer?.id ?? null,
      field,
      fieldLabel: FIELD_LABEL[field],
      change: { from: show(c.from), to: show(c.to) },
      benefit: benefitOf(s, p.message),
      copilot: copilot(s, p.message.to, c),
      input,
    };
  };

  // ---------- negotiation with a seat in the market ----------
  const decisionFor = (a: Answer, msg: Answerable): SupplierDecision => ({ ...a.decision, message: msg.id, basis: 'seller-terminal' });

  const terminalFor = (s: Session) => (msg: Answerable): SupplierDecision | undefined => {
    const k = key(s.id, msg.to);
    if (!seats.has(k)) return undefined;
    const c = concessionOf(msg);
    const h = termsHashOf(c);
    const ans = answers.get(k)?.get(h);
    if (ans) return decisionFor(ans, msg);
    pending.set(k, { termsHash: h, message: msg, concession: c, askedAt: new Date().toISOString() });
    throw new AwaitSeller(msg.to, h);
  };

  const settle = (s: Session, run: any) => {
    s.run = run;
    s.decisions = run.decisions ?? s.decisions;
    if (run.world) s.world = run.world;
    if (run.intent ?? run.intentAfter) s.intent = (run.intent ?? run.intentAfter) as Intent;
    const plan: Plan | undefined = run.plan ?? run.report?.plan ?? run.after?.plan;
    if (plan) s.plans[plan.id] = plan;
    ctx.store.save(s);
    for (const m of run.messages ?? []) if (!announced.has(m.id)) ctx.store.emit(s.id, 'negotiation.message', m, 'solver');
    for (const d of run.decisions ?? []) if (d.basis !== 'seller-terminal') ctx.store.emit(s.id, 'negotiation.decision', d, 'synthetic-market');
    return { ...run, planId: plan?.id ?? null };
  };

  const runNegotiation = async (s: Session, b: any) => {
    const negotiate = ctx.engine.negotiate;
    if (typeof negotiate !== 'function') return { unavailable: true as const };
    for (const k of seatedIn(s.id)) pending.delete(key(s.id, k));
    try {
      const run = await negotiate(s.world, s.intent, ctx.truthFor(s), {
        live: ctx.takeLive(), interventions: s.interventions, maxQuestions: b?.maxQuestions, seed: b?.seed, terminal: terminalFor(s),
      });
      return { run: settle(s, run) };
    } catch (e) {
      if (!(e instanceof AwaitSeller)) throw e;
      const p = pending.get(key(s.id, e.actor))!;
      if (!announced.has(p.message.id)) {
        announced.add(p.message.id);
        ctx.store.emit(s.id, 'negotiation.message', p.message, 'solver', { actor: e.actor });
      }
      const a = findActor(s.world, e.actor);
      return { awaiting: { actor: e.actor, actorName: a?.name ?? e.actor, message: p.message, termsHash: p.termsHash, label: 'waiting for a person at the seller terminal' } };
    }
  };

  const guard = async <T>(market: string, fn: () => Promise<T>): Promise<T | 'busy'> => {
    if (running.has(market)) return 'busy';
    running.add(market);
    try {
      return await fn();
    } finally {
      running.delete(market);
    }
  };

  // Registered before the market negotiate route: with a person seated the loop waits for them, otherwise it falls through.
  app.post('/api/markets/:id/negotiate', async (c, next) => {
    const id = c.req.param('id');
    if (!seatedIn(id).length || typeof ctx.engine.negotiate !== 'function') return next();
    const s = ctx.session(id);
    if (!s.intent.authority?.mayNegotiate) return fail(c, 403, 'scope', 'The buyer has not allowed negotiation');
    const b = await body(c);
    const r = await guard(id, () => runNegotiation(s, b));
    if (r === 'busy') return fail(c, 409, 'busy', 'A negotiation round is already running');
    if ('awaiting' in r) return c.json({ awaitingSeller: r.awaiting }, 202);
    if ('unavailable' in r) return next();
    return c.json(r.run);
  });

  // ---------- seats, minted by the buyer session ----------
  app.post('/api/markets/:id/seats', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const b = await body(c);
    const actor = typeof b.actor === 'string' ? findActor(s.world, b.actor) : undefined;
    if (!actor || (actor.kind && actor.kind !== 'supplier' && actor.kind !== 'logistics')) return fail(c, 404, 'not_found', 'No such supplier in this market');
    const { token, claim } = issue({ k: 'seat', market: s.id, actor: actor.id }, SEAT_TTL);
    return c.json({ token, link: `/#/seller/${s.id}/${actor.id}?seat=${token}`, actor: actor.id, actorName: actor.name, expiresAt: new Date(claim.exp).toISOString() }, 201);
  });

  app.get('/api/markets/:id/seats', (c) => {
    const s = ctx.session(c.req.param('id'));
    return c.json({
      seats: seatedIn(s.id).map((a) => ({
        actor: a, actorName: findActor(s.world, a)?.name ?? a, seatedAt: seats.get(key(s.id, a))!.seatedAt, label: 'a person at the seller terminal',
        awaiting: pending.get(key(s.id, a))?.termsHash ?? null,
      })),
    });
  });

  app.post('/api/markets/:id/seats/release', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const b = await body(c);
    const k = key(s.id, String(b.actor));
    const had = seats.delete(k);
    pending.delete(k);
    answers.delete(k);
    return c.json({ released: had, answeredBy: 'synthetic-policy' });
  });

  app.post('/api/markets/:id/seller/:actor/seat', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const actor = c.req.param('actor');
    const b = await body(c);
    const claim = verify(b.token, 'seat');
    if (!claim || claim.market !== s.id || claim.actor !== actor) return fail(c, 403, 'seat_invalid', 'This seat link is invalid, expired or for a different supplier');
    if (usedSeatTokens.has(claim.nonce)) return fail(c, 409, 'seat_used', 'This seat link was already used');
    usedSeatTokens.add(claim.nonce);
    const sess = issue({ k: 'sess', market: s.id, actor }, SESSION_TTL);
    seats.set(key(s.id, actor), { sid: sess.claim.nonce, seatedAt: new Date().toISOString() });
    return c.json({ session: sess.token, expiresAt: new Date(sess.claim.exp).toISOString(), actor, actorName: findActor(s.world, actor)?.name ?? actor }, 201);
  });

  app.post('/api/markets/:id/seller/:actor/leave', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const actor = c.req.param('actor');
    const b = await body(c);
    const denied = authorize(c, b, s.id, actor);
    if (denied) return denied;
    const k = key(s.id, actor);
    seats.delete(k);
    pending.delete(k);
    answers.delete(k);
    return c.json({ left: true });
  });

  app.post('/api/markets/:id/seller/:actor/view', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const actor = c.req.param('actor');
    const b = await body(c);
    const denied = authorize(c, b, s.id, actor);
    if (denied) return denied;
    const a = findActor(s.world, actor);
    const k = key(s.id, actor);
    const p = pending.get(k);
    const committed = (s.agreement?.obligations ?? []).filter((o) => o.actor === actor && o.state !== 'CANCELLED' && o.state !== 'REPLACED');
    return c.json({
      market: s.id,
      world: s.world.name,
      currency: s.world.currency,
      actor: { id: actor, name: a?.name ?? actor, city: a?.city ?? '' },
      offers: ownOffers(s.world, actor).map((o) => ({
        id: o.id, stage: s.world.stages.find((x) => x.id === o.stage)?.name ?? o.stage, unit: s.world.stages.find((x) => x.id === o.stage)?.unit ?? 'units',
        capacity: o.capacity, minQty: o.minQty, ratePerHour: o.ratePerHour, setupFee: kr(o.setupFee.minor, s.world.currency),
        price: kr(unitPriceAt(o, o.capacity), s.world.currency), windowStart: at(Date.parse(o.window.start)), windowEnd: at(Date.parse(o.window.end)),
        withdrawn: withdrawn.has(`${s.id}|${o.id}`),
      })),
      commitments: committed.map((o) => ({ id: o.id, qty: o.qty, due: at(Date.parse(o.due)), amount: kr(o.amount.minor, o.amount.currency), state: o.state })),
      canWithdraw: Boolean(s.agreement),
      pending: p ? [describe(s, p)] : [],
      answered: [...(answers.get(k)?.values() ?? [])].map((x) => ({ id: x.termsHash, action: x.action, at: x.at })),
      label: TERMINAL_LABEL,
    });
  });

  app.post('/api/markets/:id/seller/:actor/answer', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const actor = c.req.param('actor');
    const b = await body(c);
    const denied = authorize(c, b, s.id, actor);
    if (denied) return denied;
    const k = key(s.id, actor);
    const action: Action | undefined = ['accept', 'reject', 'counter'].includes(b.action) ? b.action : undefined;
    if (!action) return fail(c, 400, 'bad_request', 'Choose accept, reject or counter');
    const p = pending.get(k);
    if (typeof b.termsHash !== 'string' || !p || p.termsHash !== b.termsHash) {
      if (typeof b.termsHash === 'string' && answers.get(k)?.has(b.termsHash)) return fail(c, 409, 'already_answered', 'You already answered this proposal');
      return fail(c, 409, 'terms_changed', 'The proposal changed since you opened it. Review the current one');
    }
    const msg = p.message;
    const base = p.concession;
    let decision: SupplierDecision;
    if (action === 'accept') {
      decision = { message: msg.id, accept: true, basis: 'seller-terminal', reason: 'Accepted by the supplier.' };
    } else if (action === 'reject') {
      const why = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 200) : 'Declined by the supplier.';
      decision = { message: msg.id, accept: false, basis: 'seller-terminal', reason: why };
    } else {
      if (base.target.kind !== 'offer') return fail(c, 422, 'bad_counter', 'Only offer terms can be countered');
      const field = base.target.field;
      const to = b.counter?.to;
      const n = numeric(field, to);
      if (field === 'joint' || n === undefined || !Number.isFinite(n) || (!isTime(field) && (!Number.isInteger(n) || n < 0)) || (typeof to === 'string' && !isTime(field))) {
        return fail(c, 422, 'bad_counter', 'Enter a valid value for the counter');
      }
      const value: number | string = isTime(field) ? new Date(n).toISOString() : n;
      if (String(value) === String(base.to)) return fail(c, 422, 'bad_counter', 'A counter has to differ from the proposal');
      const counter: Concession = { ...base, id: `${base.id}:counter`, to: value, rationale: 'Counter from the supplier.' };
      decision = { message: msg.id, accept: false, basis: 'seller-terminal', counter, reason: 'Counter proposed by the supplier.' };
    }
    const now = new Date().toISOString();
    const store = answers.get(k) ?? new Map<string, Answer>();
    store.set(p.termsHash, { termsHash: p.termsHash, action, decision, at: now });
    answers.set(k, store);
    pending.delete(k);
    ctx.store.emit(s.id, 'negotiation.decision', { ...decision, termsHash: p.termsHash, actor, label: TERMINAL_LABEL }, 'seller-terminal', { actor });

    const r = await guard(s.id, () => runNegotiation(s, {}));
    const resumed = r === 'busy' ? { busy: true } : 'awaiting' in r ? { awaiting: r.awaiting } : 'run' in r ? { outcome: r.run.outcome ?? null, planId: r.run.planId } : {};
    return c.json({ decision, label: TERMINAL_LABEL, resumed });
  });

  app.post('/api/markets/:id/seller/:actor/withdraw', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const actor = c.req.param('actor');
    const b = await body(c);
    const denied = authorize(c, b, s.id, actor);
    if (denied) return denied;
    const mine = ownOffers(s.world, actor);
    const offer = typeof b.offer === 'string' ? mine.find((o) => o.id === b.offer) : mine[0];
    if (!offer) return fail(c, 404, 'not_found', 'No such offer of yours');
    if (!s.agreement) return fail(c, 409, 'state', 'Nothing is committed yet, so there is nothing to withdraw from');
    if (typeof ctx.engine.disrupt !== 'function') return fail(c, 501, 'unavailable', 'Disruption handling is not available on this server');
    const wk = `${s.id}|${offer.id}`;
    if (withdrawn.has(wk)) return fail(c, 409, 'already_withdrawn', 'This offer was already withdrawn');
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 200) : 'The supplier withdrew from the terminal.';
    const now = new Date().toISOString();
    const d: Disruption = { id: `d-${randomUUID().slice(0, 8)}`, kind: 'withdraw', actor, offer: offer.id, detail: reason, at: now };
    const r = await ctx.engine.disrupt(s.agreement, s.world, d);
    withdrawn.add(wk);
    s.world = r?.world ?? s.world;
    s.disruptions.push(d);
    ctx.store.save(s);
    ctx.store.emit(s.id, 'negotiation.message', { type: 'Withdraw', id: `w-${d.id}`, from: actor, offer: offer.id, reason, at: now } satisfies NegotiationMessage, 'seller-terminal', { actor });
    ctx.store.emit(s.id, 'disruption.applied', { disruption: d, affected: (r?.affected ?? []).map((o: any) => o.id), label: TERMINAL_LABEL }, 'seller-terminal', { actor });
    return c.json({ disruption: d, affected: r?.affected ?? [], label: TERMINAL_LABEL });
  });
}
