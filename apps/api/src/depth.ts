import type { Context, Hono } from 'hono';
import type { Intent } from '@framvera/contracts';
import { need, type Engine } from './engine.ts';
import type { Session, Store } from './store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DepthCtx {
  engine: Engine;
  store: Store;
  session: (id: string) => Session;
  truthFor: (s: Session) => any;
  body: (c: Context) => Promise<any>;
  fail: (status: 400 | 403 | 404 | 409 | 422, code: string, message: string) => Error;
}

const int = (v: unknown, lo: number, hi: number, d: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v as number)) : d);

/** Market mechanisms and capacity options, each answering from the real session world. */
export function registerDepth(app: Hono, ctx: DepthCtx) {
  const { engine, store } = ctx;
  const mech = (name: string) => need(engine.mechanisms?.[name], 'market mechanisms');
  const opt = (name: string) => need(engine.options?.[name], 'capacity options');
  const remember = (s: Session, key: string, value: unknown) => {
    s.mechanisms = { ...(s.mechanisms ?? {}), [key]: value };
    store.save(s);
  };

  // ---------- mechanisms ----------
  app.post('/api/markets/:id/mechanisms/auction', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const b = await ctx.body(c);
    const levels = Array.isArray(b.levels) && b.levels.every((x: unknown) => typeof x === 'number' && x > 0 && x <= 1) ? b.levels.slice(0, 8) : undefined;
    const bids = mech('publishedBids')(s.world, s.intent, ...(levels ? [levels] : []));
    const result = await mech('runReverseAuction')(s.world, s.intent, bids, { timeLimitMs: 10_000 });
    const verification = engine.mechanisms?.verifyAuction ? engine.mechanisms.verifyAuction(result, s.world, s.intent, bids) : result.verification;
    remember(s, 'auction', { status: result.status, total: result.total ?? null, winners: result.winners?.length ?? 0 });
    if (result.plan) s.plans[result.plan.id] = result.plan;
    store.save(s);
    store.emit(s.id, 'solve.completed', { mechanism: result.mechanism, status: result.status, plan: result.plan?.id ?? null, total: result.total ?? null, bids: bids.length }, 'solver');
    return c.json({ bidsFrom: 'published offers', bids, result, verification });
  });

  app.post('/api/markets/:id/mechanisms/exchange', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const b = await ctx.body(c);
    const market = mech('exchangeMarket')(int(b.seed, 1, 1_000_000, s.seed ?? 1), int(b.firms, 3, 12, 8), s.world.currency);
    const result = await mech('findExchangeCycles')(market, { maxLength: int(b.maxLength, 2, 6, 4) });
    const verification = engine.mechanisms?.verifyExchange ? engine.mechanisms.verifyExchange(result, market) : undefined;
    remember(s, 'exchange', { cycles: result.cycles?.length ?? 0 });
    return c.json({ source: 'synthetic-market', market, result, verification });
  });

  /** The session buyer plus synthetic co-buyers who each consented to pooling; or orders supplied as quantities. */
  const ordersFor = (s: Session, b: any) => {
    const base = s.intent;
    const specs: { buyer: string; quantity: number; budgetShare: number }[] = Array.isArray(b.orders) && b.orders.length
      ? b.orders.slice(0, 6).map((o: any, i: number) => ({ buyer: typeof o.buyer === 'string' ? o.buyer.slice(0, 40) : `buyer-${i + 1}`, quantity: int(o.quantity, 1, 100_000, 100), budgetShare: 0 }))
      : [
          { buyer: 'buyer', quantity: base.quantity, budgetShare: 0 },
          { buyer: 'co-buyer-1', quantity: Math.max(50, Math.round(base.quantity * 0.4)), budgetShare: 0 },
          { buyer: 'co-buyer-2', quantity: Math.max(50, Math.round(base.quantity * 0.3)), budgetShare: 0 },
        ];
    const perUnit = base.budget.minor / Math.max(1, base.quantity);
    return specs.map((x) => {
      const intent: Intent = {
        ...base, id: `${base.id}:${x.buyer}`, quantity: x.quantity, text: `${x.quantity} units`,
        budget: { currency: base.budget.currency, minor: Math.round(perUnit * x.quantity) },
        authority: { ...base.authority, maxSpend: { currency: base.budget.currency, minor: Math.round(perUnit * x.quantity) } },
        provenance: { source: x.buyer === 'buyer' ? 'buyer' : 'synthetic-market', observedAt: base.provenance.observedAt },
      };
      return { buyer: x.buyer, intent, consent: { pool: true } };
    });
  };

  app.post('/api/markets/:id/mechanisms/aggregate', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const b = await ctx.body(c);
    const orders = ordersFor(s, b);
    const result = await mech('aggregateDemand')(s.world, orders, { timeLimitMs: 10_000 });
    const verification = engine.mechanisms?.verifyAggregation ? engine.mechanisms.verifyAggregation(result, s.world, orders) : undefined;
    remember(s, 'aggregate', { pools: result.pools?.length ?? 0 });
    return c.json({ orders: orders.map((o) => ({ buyer: o.buyer, quantity: o.intent.quantity, budget: o.intent.budget, source: o.intent.provenance.source, consent: o.consent })), result, verification });
  });

  app.post('/api/markets/:id/mechanisms/compare', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const b = await ctx.body(c);
    const result = await mech('compareMechanisms')(s.world, s.intent, ctx.truthFor(s), { trials: int(b.trials, 1, 40, 12), seed: int(b.seed, 1, 1_000_000, 1), timeLimitMs: 5_000 });
    remember(s, 'compare', { trials: result.trials?.length ?? null });
    return c.json(result);
  });

  // ---------- capacity options: standby capacity held for a fee, called only if a committed supplier fails ----------
  const held = (s: Session) => ((s.options as any) ?? {}) as { discovery?: any; options?: any[]; valuation?: any; exercise?: any };
  const committed = (s: Session) => {
    if (!s.agreement || !['COMMITTED', 'FULFILLING'].includes(s.agreement.state)) throw ctx.fail(409, 'state', 'Commit an agreement first');
    return s.agreement;
  };

  app.post('/api/markets/:id/options/discover', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const agreement = committed(s);
    const b = await ctx.body(c);
    const discovery = await opt('discoverOptions')(s.world, s.intent, agreement, { truth: ctx.truthFor(s), ...(Number.isInteger(b.maxTargets) ? { maxTargets: Math.min(5, b.maxTargets) } : {}) });
    s.options = { discovery: { ...discovery, options: undefined }, options: discovery.options };
    store.save(s);
    for (const o of discovery.options ?? []) for (const m of o.messages ?? []) store.emit(s.id, 'negotiation.message', { ...m, option: o.id }, m.type === 'RequestStandby' ? 'solver' : 'synthetic-market', { actor: m.from });
    return c.json(discovery);
  });

  app.post('/api/markets/:id/options/value', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const agreement = committed(s);
    const b = await ctx.body(c);
    const options = held(s).options;
    if (!options) throw ctx.fail(409, 'state', 'Look for standby capacity first');
    const valuation = await opt('valueOptions')(s.world, s.intent, agreement, options, { seed: int(b.seed, 1, 1_000_000, 1), ...(Number.isInteger(b.scenarios) ? { scenarios: Math.min(2000, b.scenarios) } : {}) });
    s.options = { ...held(s), valuation };
    store.save(s);
    return c.json(valuation);
  });

  /** The buyer chooses which quoted options to hold; only quotes the supplier already signed can be bought. */
  /** The buyer chooses which quoted options to hold; only quotes the supplier already signed can be bought. */
  const buy = (s: Session, b: any) => {
    const h = held(s);
    if (!h.options) throw ctx.fail(409, 'state', 'Look for standby capacity first');
    if (!s.intent.authority?.mayReserve) throw ctx.fail(403, 'scope', 'The buyer has not allowed reservations');
    const ids: string[] = Array.isArray(b.options) ? b.options.filter((x: unknown) => typeof x === 'string') : (h.valuation?.buy ?? []);
    // Fees are commitments too: the plan plus every held option fee must stay inside the budget and the spending limit.
    const a = s.agreement!;
    const planMinor = a.obligations.filter((o) => o.state !== 'CANCELLED' && o.state !== 'REPLACED').reduce((t, o) => t + o.amount.minor, 0);
    const feeOf = (o: any) => (o?.terms?.fee?.minor ?? 0) as number;
    const heldFees = h.options.filter((o: any) => o.status === 'purchased' || o.status === 'exercised').reduce((t: number, o: any) => t + feeOf(o), 0);
    const newFees = h.options.filter((o: any) => o.status === 'quoted' && ids.includes(o.id)).reduce((t: number, o: any) => t + feeOf(o), 0);
    const total = planMinor + heldFees + newFees;
    const caps = [s.intent.budget?.minor, s.intent.authority?.maxSpend?.minor].filter((x): x is number => typeof x === 'number');
    if (caps.some((cap) => total > cap)) throw ctx.fail(403, 'over_limit', 'These standby fees would take committed spending past the budget or the spending limit');
    const options = opt('acceptOptions')(h.options, ids, {});
    s.options = { ...h, options };
    store.save(s);
    const bought = options.filter((o: any) => o.status === 'purchased');
    for (const o of bought) {
      const causes = store.causal.get(s.id, [...(o.messages ?? []).map((m: any) => `msg:${m.id}`), 'agreement']);
      store.emit(s.id, 'agreement.state', { agreement: o.agreement, state: o.agreement.state, termsHash: o.agreement.termsHash, option: o.id }, 'buyer', { causes });
    }
    return { options, purchased: bought.map((o: any) => o.id) };
  };

  app.post('/api/markets/:id/options/buy', async (c) => {
    const s = ctx.session(c.req.param('id'));
    committed(s);
    return c.json(buy(s, await ctx.body(c)));
  });

  /** One call after commit: standby quotes from supplier policies and their value, keyed by the agreement. */
  const sessionOfAgreement = (agreementId: string, hint?: string) => {
    const s = hint ? ctx.session(hint) : [...store.sessions.values()].find((x) => x.agreement?.id === agreementId);
    if (!s || s.agreement?.id !== agreementId) throw ctx.fail(404, 'not_found', 'Agreement not found');
    return s;
  };

  app.post('/api/agreements/:id/options', async (c) => {
    const b = await ctx.body(c);
    const s = sessionOfAgreement(c.req.param('id'), typeof b.market === 'string' ? b.market : undefined);
    const agreement = committed(s);
    const discovery = await opt('discoverOptions')(s.world, s.intent, agreement, { truth: ctx.truthFor(s) });
    for (const o of discovery.options ?? []) for (const m of o.messages ?? []) store.emit(s.id, 'negotiation.message', { ...m, option: o.id }, m.type === 'RequestStandby' ? 'solver' : 'synthetic-market', { actor: m.from });
    const valuation = await opt('valueOptions')(s.world, s.intent, agreement, discovery.options ?? [], { seed: int(b.seed, 1, 1_000_000, 20261112), ...(Number.isInteger(b.scenarios) ? { scenarios: Math.min(2000, b.scenarios) } : {}) });
    s.options = { discovery: { ...discovery, options: undefined }, options: discovery.options, valuation };
    store.save(s);
    return c.json({ discovery, valuation });
  });

  app.post('/api/agreements/:id/options/accept', async (c) => {
    const b = await ctx.body(c);
    const s = sessionOfAgreement(c.req.param('id'), typeof b.market === 'string' ? b.market : undefined);
    committed(s);
    return c.json(buy(s, b));
  });

  app.post('/api/markets/:id/options/exercise', async (c) => {
    const s = ctx.session(c.req.param('id'));
    const agreement = committed(s);
    const b = await ctx.body(c);
    const options = held(s).options ?? [];
    const list = s.disruptions as any[];
    const d = list.find((x) => x.id === b.disruption) ?? list.at(-1);
    if (!d) throw ctx.fail(409, 'state', 'No disruption to answer');
    const ex = opt('exerciseOption')(agreement, s.world, s.intent, d, options, {});
    s.options = { ...held(s), options: ex.options ?? options, exercise: { exercised: ex.exercised, reason: ex.reason, absorbed: ex.absorbed } };
    if (ex.exercised && ex.recovery) {
      const rec = { ...ex.recovery, amendment: ex.amendment, plan: ex.plan, source: 'standby-option' };
      s.recoveries.push(rec);
      store.save(s);
      for (const m of ex.notices ?? []) store.emit(s.id, 'negotiation.message', m, 'buyer', { actor: m.from });
      store.emit(s.id, 'recovery.proposed', { recovery: rec }, 'solver');
    } else store.save(s);
    return c.json({ ...ex, world: undefined });
  });
}
