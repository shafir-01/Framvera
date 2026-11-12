import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { Agreement, Id, Intent, MarketEvent, Money, Obligation, PaymentIntent, World } from '@framvera/contracts';
import {
  ApiError,
  isAwaiting,
  type AnalyzeResult,
  type Api,
  type ApiStatus,
  type AwaitingSeller,
  type CompiledIntent,
  type DisruptResult,
  type IntentDraft,
  type InventResult,
  type MarketCreated,
  type MarketRequest,
  type NegotiateResult,
  type RecoverResult,
} from './api.ts';

export type Step = 'market' | 'compile' | 'analyze' | 'invent' | 'negotiate' | 'commit' | 'pay' | 'capture' | 'refresh' | 'refund' | 'disrupt' | 'recover';
export type ServerPhase = 'checking' | 'waking' | 'ready' | 'down';

export interface Session {
  draft: IntentDraft;
  request: MarketRequest;
  scenario?: string;
  server: ServerPhase;
  status?: ApiStatus;
  statusError?: string;
  market?: MarketCreated;
  compiled?: CompiledIntent;
  intent?: Intent;
  analysis?: AnalyzeResult;
  invention?: InventResult;
  awaiting?: AwaitingSeller['awaiting'];
  negotiation?: NegotiateResult;
  agreement?: Agreement;
  committed?: Agreement;
  payments: Record<Id, PaymentIntent>;
  disruption?: DisruptResult;
  recovery?: RecoverResult;
  events: MarketEvent[];
  busy?: Step;
  busyKey?: string;
  error?: { step: Step; message: string };
  run: number;
}

type Action =
  | { type: 'patch'; patch: Partial<Session> }
  | { type: 'busy'; step?: Step; key?: string }
  | { type: 'error'; step: Step; message: string }
  | { type: 'reset' }
  | { type: 'payment'; payment: PaymentIntent }
  | { type: 'events'; events: MarketEvent[] };

function reducer(s: Session, a: Action): Session {
  switch (a.type) {
    case 'patch':
      return { ...s, ...a.patch };
    case 'busy':
      return { ...s, busy: a.step, busyKey: a.key, error: a.step ? undefined : s.error };
    case 'error':
      return { ...s, busy: undefined, busyKey: undefined, error: { step: a.step, message: a.message } };
    case 'reset':
      return { draft: s.draft, request: s.request, scenario: s.scenario, server: s.server, status: s.status, statusError: s.statusError, events: [], payments: {}, run: s.run + 1 };
    case 'payment':
      return { ...s, payments: { ...s.payments, [a.payment.id]: a.payment } };
    case 'events': {
      const mine = a.events.filter((e) => !s.market || e.market === s.market.market);
      if (!mine.length) return s;
      const known = new Map(s.events.map((e) => [e.id, e]));
      for (const e of mine) known.set(e.id, e);
      return { ...s, events: [...known.values()].sort((x, y) => x.seq - y.seq) };
    }
  }
}

export interface Payee {
  actor: Id;
  amount: Money;
  obligations: Obligation[];
}

const LIVE: Obligation['state'][] = ['PENDING', 'ACTIVE', 'AT_RISK', 'FULFILLED'];

export function payeesOf(agreement: Agreement | undefined): Payee[] {
  if (!agreement) return [];
  const by = new Map<Id, Payee>();
  for (const o of agreement.obligations) {
    if (!LIVE.includes(o.state)) continue;
    const p = by.get(o.actor) ?? { actor: o.actor, amount: { currency: o.amount.currency, minor: 0 }, obligations: [] };
    p.amount = { currency: p.amount.currency, minor: p.amount.minor + o.amount.minor };
    p.obligations.push(o);
    by.set(o.actor, p);
  }
  return [...by.values()];
}

export interface Started {
  market: Id;
  world: World;
  intent: Intent;
  template: string;
  seed?: number;
}

const TEMPLATE_TITLE: Record<string, string> = { flagship: 'Promotional kits', exhibition: 'Exhibition stand', circular: 'Circular exchange', unseen: 'Unseen market' };

export interface Actions {
  setDraft(d: IntentDraft): void;
  startWith(started: Started): Promise<void>;
  start(): Promise<void>;
  ask(): Promise<void>;
  commit(): Promise<void>;
  startPayment(payee: Id): Promise<PaymentIntent | undefined>;
  capture(payment: Id): Promise<PaymentIntent | undefined>;
  refreshPayment(payment: Id): Promise<void>;
  refund(payment: Id): Promise<void>;
  breakDeal(): Promise<void>;
  reset(): void;
  retryStatus(): void;
}

interface Ctx {
  api: Api;
  s: Session;
  act: Actions;
  world?: World;
}

const StoreCtx = createContext<Ctx | null>(null);

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function StoreProvider({ api, initialDraft, children }: { api: Api; initialDraft: IntentDraft; children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, { draft: initialDraft, request: { flagship: true }, server: 'checking', events: [], payments: {}, run: 0 });
  const ref = useRef(s);
  ref.current = s;
  const runId = useRef(0);
  const statusRun = useRef(0);
  const initial = useRef(initialDraft);

  const loadStatus = useCallback(() => {
    const mine = ++statusRun.current;
    const started = Date.now();
    dispatch({ type: 'patch', patch: { server: 'checking', statusError: undefined } });
    const slow = setTimeout(() => {
      if (statusRun.current === mine && ref.current.server === 'checking') dispatch({ type: 'patch', patch: { server: 'waking' } });
    }, 3500);
    const attempt = async (): Promise<void> => {
      try {
        const status = await api.status();
        if (statusRun.current !== mine) return;
        clearTimeout(slow);
        dispatch({ type: 'patch', patch: { status, server: 'ready', statusError: undefined } });
      } catch (e) {
        if (statusRun.current !== mine) return;
        if (Date.now() - started < 95_000) {
          if (Date.now() - started > 2500) dispatch({ type: 'patch', patch: { server: 'waking' } });
          await pause(3000);
          return attempt();
        }
        clearTimeout(slow);
        dispatch({ type: 'patch', patch: { server: 'down', statusError: errorText(e) } });
      }
    };
    void attempt();
  }, [api]);

  useEffect(loadStatus, [loadStatus]);

  const marketId = s.market?.market;
  useEffect(() => {
    if (!marketId) return;
    let buf: MarketEvent[] = [];
    let t: ReturnType<typeof setTimeout> | undefined;
    const stop = api.subscribe(marketId, (e) => {
      buf.push(e);
      t ??= setTimeout(() => {
        dispatch({ type: 'events', events: buf });
        buf = [];
        t = undefined;
      }, 60);
    });
    return () => {
      stop();
      if (t) clearTimeout(t);
    };
  }, [api, marketId]);

  const step = useCallback(async <T,>(name: Step, fn: () => Promise<T>, run?: number, key?: string): Promise<T | undefined> => {
    dispatch({ type: 'busy', step: name, key });
    try {
      const v = await fn();
      if (run !== undefined && run !== runId.current) return undefined;
      return v;
    } catch (e) {
      if (run === undefined || run === runId.current) dispatch({ type: 'error', step: name, message: errorText(e) });
      return undefined;
    }
  }, []);

  const settleNegotiation = useCallback((n: NegotiateResult) => {
    const cur = ref.current;
    dispatch({ type: 'patch', patch: { negotiation: n, awaiting: undefined, intent: n.intent ?? cur.intent, busy: undefined, busyKey: undefined } });
  }, []);

  // While a person answers at the seller terminal, follow the market until the run settles.
  const awaitingHash = s.awaiting?.termsHash;
  useEffect(() => {
    if (!awaitingHash || !marketId) return;
    let alive = true;
    let asked = false;
    const tick = async () => {
      while (alive) {
        await pause(2000);
        if (!alive) return;
        try {
          const snap = await api.market(marketId);
          if (!alive) return;
          if (snap.run && (snap.run.planId || snap.run.outcome !== 'unknown')) {
            settleNegotiation(snap.run);
            return;
          }
          const answered = ref.current.events.some((e) => e.type === 'negotiation.decision' && e.source === 'seller-terminal' && (e.data as { termsHash?: string })?.termsHash === awaitingHash);
          if (answered && snap.run === undefined && !asked) {
            asked = true;
            const r = await api.negotiate(marketId);
            if (!alive) return;
            if (isAwaiting(r)) dispatch({ type: 'patch', patch: { awaiting: r.awaiting } });
            else settleNegotiation(r);
            return;
          }
          const seats = await api.seats(marketId);
          const next = seats.find((x) => x.awaiting && x.awaiting !== awaitingHash);
          if (next && alive) {
            const msg = [...ref.current.events].reverse().find((e) => e.type === 'negotiation.message' && (e.data as { to?: string })?.to === next.actor);
            if (msg) dispatch({ type: 'patch', patch: { awaiting: { actor: next.actor, actorName: next.actorName, message: msg.data as never, termsHash: next.awaiting!, label: next.label } } });
          }
        } catch {
          /* keep following */
        }
      }
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [api, awaitingHash, marketId, settleNegotiation]);

  const act = useMemo<Actions>(() => {
    const dwell = (ms: number) => (reduced() ? Promise.resolve() : pause(ms));
    const explore = async (market: MarketCreated, intent: Intent, run: number) => {
      const analysis = await step('analyze', () => api.analyze(market.market, intent), run);
      if (!analysis) return;
      dispatch({ type: 'patch', patch: { analysis } });
      if (analysis.report.status !== 'infeasible') {
        dispatch({ type: 'busy' });
        return;
      }
      await dwell(1200);
      if (run !== runId.current) return;
      const invention = await step('invent', () => api.invent(market.market), run);
      if (!invention) return;
      dispatch({ type: 'patch', patch: { invention } });
      dispatch({ type: 'busy' });
    };
    const refreshEvents = (market: string) => {
      api
        .events(market)
        .then((events) => dispatch({ type: 'events', events }))
        .catch(() => {});
    };
    return {
      setDraft: (draft) => dispatch({ type: 'patch', patch: { draft } }),
      retryStatus: loadStatus,
      reset: () => {
        runId.current += 1;
        dispatch({ type: 'reset' });
        window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
      },
      start: async () => {
        const run = ++runId.current;
        dispatch({ type: 'reset' });
        const { draft, request } = ref.current;
        const market = await step('market', () => api.createMarket(request), run);
        if (!market) return;
        dispatch({ type: 'patch', patch: { market } });
        const i0 = initial.current;
        const untouched = draft.text.trim() === i0.text.trim() && draft.budget.minor === i0.budget.minor && draft.deadline === i0.deadline && 'flagship' in request;
        if (untouched) {
          dispatch({ type: 'patch', patch: { intent: market.intent } });
          await explore(market, market.intent, run);
          return;
        }
        const compiled = await step('compile', () => api.compileIntent(market.market, draft), run);
        if (!compiled) return;
        dispatch({ type: 'patch', patch: { compiled, intent: compiled.intent } });
        await explore(market, compiled.intent, run);
      },
      startWith: async (st) => {
        const run = ++runId.current;
        dispatch({ type: 'reset' });
        const market = { market: st.market, world: st.world, intent: st.intent };
        dispatch({
          type: 'patch',
          patch: {
            market,
            intent: st.intent,
            scenario: TEMPLATE_TITLE[st.template] ?? st.template,
            request: st.seed !== undefined ? { scenario: st.template, seed: st.seed } : { scenario: st.template },
            draft: { text: st.intent.text, budget: st.intent.budget, deadline: st.intent.deadline },
          },
        });
        window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
        await explore(market, st.intent, run);
      },
      ask: async () => {
        const cur = ref.current;
        if (!cur.market) return;
        const run = runId.current;
        const r = await step('negotiate', () => api.negotiate(cur.market!.market), run);
        if (!r) return;
        if (isAwaiting(r)) {
          dispatch({ type: 'patch', patch: { awaiting: r.awaiting, busy: undefined } });
          return;
        }
        settleNegotiation(r);
      },
      commit: async () => {
        const cur = ref.current;
        const plan = cur.negotiation?.report?.plan ?? cur.analysis?.report.plan;
        if (!cur.market || !plan) return;
        const r = await step('commit', () => api.commit(cur.market!.market, plan.id));
        if (!r) return;
        dispatch({ type: 'patch', patch: { agreement: r.agreement, committed: r.agreement, busy: undefined } });
      },
      startPayment: async (payee) => {
        const cur = ref.current;
        const ag = cur.agreement;
        if (!cur.market || !ag) return undefined;
        const due = payeesOf(ag).find((p) => p.actor === payee);
        if (!due) return undefined;
        const existing = Object.values(cur.payments).find((p) => p.payee === payee && p.agreement === ag.id && !['VOIDED', 'CAPTURE_DENIED'].includes(p.state));
        if (existing) return existing;
        const pi = await step(
          'pay',
          async () => {
            const approval = await api.approvePayment(cur.market!.market, ag, payee, due.amount);
            return api.createOrder(cur.market!.market, ag.id, approval.approvalToken);
          },
          undefined,
          payee,
        );
        if (!pi) return undefined;
        dispatch({ type: 'payment', payment: pi });
        dispatch({ type: 'busy' });
        return pi;
      },
      capture: async (payment) => {
        const r = await step('capture', () => api.capture(payment), undefined, payment);
        if (!r) return undefined;
        dispatch({ type: 'payment', payment: r });
        dispatch({ type: 'busy' });
        return r;
      },
      refreshPayment: async (payment) => {
        const r = await step('refresh', () => api.payment(payment), undefined, payment);
        if (!r) return;
        dispatch({ type: 'payment', payment: r });
        dispatch({ type: 'busy' });
      },
      refund: async (payment) => {
        const r = await step(
          'refund',
          async () => {
            const approval = await api.approveRefund(payment);
            return api.refund(payment, approval.approvalToken);
          },
          undefined,
          payment,
        );
        if (!r) return;
        dispatch({ type: 'payment', payment: r });
        dispatch({ type: 'busy' });
      },
      breakDeal: async () => {
        const cur = ref.current;
        if (!cur.market || !cur.agreement) return;
        const market = cur.market.market;
        const world = cur.negotiation?.world ?? cur.market.world;
        const target = disruptionTarget(cur.agreement, world);
        if (!target) return;
        const name = world.actors.find((a) => a.id === target.actor)?.name ?? target.actor;
        const disruption = await step('disrupt', () => api.disrupt(market, { kind: 'withdraw', actor: target.actor, offer: target.offer, detail: `${name} withdrew from the agreement.` }));
        if (!disruption) return;
        dispatch({ type: 'patch', patch: { disruption } });
        if (!disruption.world) {
          api
            .market(market)
            .then((snap) => {
              if (ref.current.disruption && !ref.current.disruption.world) dispatch({ type: 'patch', patch: { disruption: { ...ref.current.disruption, world: snap.world } } });
            })
            .catch(() => {});
        }
        await dwell(1600);
        const recovery = await step('recover', () => api.recover(market, disruption.disruption.id));
        if (!recovery) return;
        dispatch({ type: 'patch', patch: { recovery, agreement: recovery.agreement ?? ref.current.agreement, busy: undefined } });
        refreshEvents(market);
      },
    };
  }, [api, loadStatus, settleNegotiation, step]);

  const world = s.recovery?.recovery.world ?? s.disruption?.world ?? s.negotiation?.world ?? s.market?.world;
  const value = useMemo(() => ({ api, s, act, world }), [api, s, act, world]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

/** The supplier whose loss tests the agreement hardest: the last stage of the chain (typically the courier). */
export function disruptionTarget(agreement: Agreement, world: World): { actor: Id; offer: Id } | undefined {
  const live = agreement.obligations.filter((o) => LIVE.includes(o.state));
  const feeds = new Set(world.stages.flatMap((st) => st.after));
  const sinks = live.filter((o) => !feeds.has(o.stage));
  const pick = sinks[0] ?? live.at(-1);
  return pick ? { actor: pick.actor, offer: pick.offer } : undefined;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('StoreProvider missing');
  return c;
}
