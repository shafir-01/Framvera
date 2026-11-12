import type {
  Agreement,
  Allocation,
  ClaimFinding,
  Coalition,
  Concession,
  Currency,
  Disruption,
  EventType,
  Id,
  InfeasibleCore,
  Intent,
  Intervention,
  Iso,
  MarketEvent,
  Money,
  NegotiationMessage,
  Obligation,
  PaymentIntent,
  Plan,
  Recovery,
  SolveReport,
  SupplierDecision,
  Verification,
  World,
} from '@framvera/contracts';

// ---------- Shapes the interface reads (normalised from the API's raw bodies) ----------

export interface ApiStatus {
  ok: boolean;
  paypal: { env: 'sandbox'; configured: boolean; clientId?: string; currency?: Currency };
  ai: { configured: boolean; enabled: boolean };
  services: Record<string, unknown>;
}

export interface MarketCreated {
  market: Id;
  world: World;
  intent: Intent;
}

export interface MarketSnapshot {
  market: Id;
  world: World;
  intent: Intent;
  plans: Plan[];
  agreement: Agreement | null;
  payments: PaymentIntent[];
  recoveries: RecoveryView[];
  run?: NegotiateResult;
}

export interface CompiledIntent {
  intent: Intent;
  questions: string[];
  model: string;
  live: boolean;
}

export interface AnalyzeResult {
  report: SolveReport;
}

export interface QuestionView {
  message: NegotiationMessage;
  voi: number;
  benefit?: string;
  concession?: Concession;
  buyerQuestion?: boolean;
}

export interface InventResult {
  interventions: Intervention[];
  coalitions: Coalition[];
  findings: (ClaimFinding & { kind?: string; records?: Id[] })[];
}

export interface NegotiateResult {
  outcome: string;
  messages: NegotiationMessage[];
  decisions: SupplierDecision[];
  texts: { message: Id; text: string; source: string }[];
  questions: QuestionView[];
  accepted: Concession[];
  rejected: Concession[];
  pendingBuyerQuestions: QuestionView[];
  interventions: Intervention[];
  before?: SolveReport;
  report?: SolveReport;
  verification?: Verification;
  world?: World;
  intent?: Intent;
  planId: Id | null;
  queriesUsed?: number;
  queryBudget?: number;
}

export interface AwaitingSeller {
  awaiting: { actor: Id; actorName: string; message: NegotiationMessage; termsHash: string; label: string };
}

export interface SeatLink {
  token: string;
  link: string;
  actor: Id;
  actorName: string;
  expiresAt: Iso;
}

export interface SeatInfo {
  actor: Id;
  actorName: string;
  seatedAt: Iso;
  label: string;
  awaiting: string | null;
}

export interface CommitResult {
  agreement: Agreement;
}

export interface PaymentApproval {
  approvalToken: string;
  expiresAt?: Iso;
  amount: Money;
}

export interface DisruptResult {
  disruption: Disruption;
  affected: Obligation[];
  atRisk: Obligation[];
  failed: Obligation[];
  world?: World;
}

export interface RecoveryView extends Omit<Recovery, 'rejected'> {
  rejected: { description: string; reason: string; extraCost?: Money; slipHours?: number }[];
  plan?: Plan;
  replacements?: { replaces: Id; allocation: Allocation }[];
  candidates?: { description: string; source: string; permissible: boolean; changed: number; extraCostMinor: number; slipHours: number; reasons: string[] }[];
  objective?: string;
  amendment?: Agreement;
  world?: World;
  payments?: { refunds: { payment: Id; amount: Money; reason: string }[]; voids: { payment: Id; reason: string }[]; reconcile: { payment: Id; reason: string }[]; orders: PaymentIntent[] };
}

export interface RecoverResult {
  recovery: RecoveryView;
  agreement?: Agreement;
}

export interface TraceResult {
  entity: Id;
  events: MarketEvent[];
}

export interface IntentDraft {
  text: string;
  budget: Money;
  deadline: Iso;
}

/** Body of POST /api/markets. */
export type MarketRequest = { flagship: true } | { seed: number; family: 'feasible' | 'salvageable' | 'impossible' } | { template: string; seed?: number; family?: string };

// ---------- Props for components mounted from their own folders ----------

/** <ScenarioGallery /> from apps/web/src/scenarios/index.tsx. The gallery creates the market and hands it over. */
export interface ScenarioGalleryProps {
  onPick: (started: { market: Id; world: World; intent: Intent; template: string; seed?: number }) => void;
  runSolve?: boolean;
}

/** <EvidenceTrail /> from apps/web/src/evidence/index.tsx: backwards provenance from an entity (e.g. a PayPal record) to the objective. */
export interface EvidenceTrailProps {
  market: Id;
  entity?: Id;
}

/** <Replay /> from apps/web/src/replay/index.tsx. */
export interface ReplayProps {
  market: Id;
  api: Api;
  world?: World;
  events?: MarketEvent[];
  agreement?: Agreement;
  recovery?: { recovery: Recovery; agreement?: Agreement };
  payments?: PaymentIntent[];
}

/** <Forge /> from apps/web/src/forge/index.tsx: build a coalition by hand with live feasibility. */
export interface ForgeProps {
  world: World;
  intent: Intent;
  onPropose?: (coalition: Coalition) => void;
}

/** <Surgery /> from apps/web/src/surgery/index.tsx: pick a blocking constraint and simulate a change. */
export interface SurgeryProps {
  world: World;
  intent: Intent;
  core: InfeasibleCore;
  interventions?: Intervention[];
  onCommitBranch?: (branch: { id: Id; label: string; concessions: readonly Concession[]; status: string; total?: Money }) => void;
  api?: Api;
  market?: Id;
}

/** <Observatory /> from apps/web/src/observatory/index.tsx. */
export interface ObservatoryProps {
  market: Id;
  api: Api;
  world: World;
  intent?: Intent;
  invention?: InventResult;
  negotiation?: NegotiateResult;
  agreement?: Agreement;
  payments: PaymentIntent[];
  recovery?: RecoverResult;
  events: MarketEvent[];
  theme: 'light' | 'dark';
}

/** <Schedule /> from apps/web/src/schedule/index.ts. */
export interface ScheduleProps {
  plan: Plan;
  agreement?: Agreement;
  recovery?: Recovery;
  world?: World;
  originalWorld?: World;
  deadline?: Iso;
  disruption?: Disruption;
  onAdjust?: (concession: Concession) => void;
}

// ---------- Client ----------

export interface Api {
  readonly mode: 'live' | 'fixture';
  status(): Promise<ApiStatus>;
  createMarket(req?: MarketRequest): Promise<MarketCreated>;
  market(market: Id): Promise<MarketSnapshot>;
  compileIntent(market: Id, draft: IntentDraft): Promise<CompiledIntent>;
  analyze(market: Id, intent: Intent): Promise<AnalyzeResult>;
  invent(market: Id): Promise<InventResult>;
  negotiate(market: Id, opts?: { interventions?: Intervention[] }): Promise<NegotiateResult | AwaitingSeller>;
  mintSeat(market: Id, actor: Id): Promise<SeatLink>;
  seats(market: Id): Promise<SeatInfo[]>;
  releaseSeat(market: Id, actor: Id): Promise<void>;
  verify(market: Id, plan: Id): Promise<Verification>;
  commit(market: Id, plan: Id): Promise<CommitResult>;
  approvePayment(market: Id, agreement: Agreement, payee: Id, amount: Money): Promise<PaymentApproval>;
  createOrder(market: Id, agreement: Id, approvalToken: string): Promise<PaymentIntent>;
  capture(payment: Id): Promise<PaymentIntent>;
  payment(payment: Id): Promise<PaymentIntent>;
  approveRefund(payment: Id, amount?: Money): Promise<PaymentApproval>;
  refund(payment: Id, approvalToken: string): Promise<PaymentIntent>;
  disrupt(market: Id, d: { kind: Disruption['kind']; actor?: Id; offer?: Id; detail?: string }): Promise<DisruptResult>;
  recover(market: Id, disruption?: Id): Promise<RecoverResult>;
  commitRecovery(market: Id, recovery: Id): Promise<{ agreement: Agreement; changed?: unknown }>;
  events(market: Id): Promise<MarketEvent[]>;
  subscribe(market: Id, onEvent: (e: MarketEvent) => void): () => void;
  trace(market: Id, entity: Id): Promise<TraceResult>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const EVENT_TYPES: EventType[] = [
  'world.created',
  'intent.compiled',
  'solve.completed',
  'intervention.found',
  'negotiation.message',
  'negotiation.decision',
  'offer.derived',
  'claim.challenged',
  'agreement.state',
  'obligation.state',
  'payment.state',
  'paypal.webhook',
  'disruption.applied',
  'recovery.proposed',
  'recovery.committed',
];

type Raw = Record<string, any>;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function normStatus(r: Raw): ApiStatus {
  const sv: Raw = r.services ?? {};
  const pp: Raw = r.paypal ?? {};
  return {
    ok: r.ok !== false,
    paypal: {
      env: 'sandbox',
      configured: Boolean(pp.configured ?? sv.paypalConfigured),
      clientId: typeof pp.clientId === 'string' && pp.clientId ? pp.clientId : typeof sv.paypalClientId === 'string' ? sv.paypalClientId : undefined,
      currency: pp.currency ?? sv.paypalCurrency,
    },
    ai: { configured: Boolean(sv.aiConfigured), enabled: Boolean(sv.aiEnabled && sv.aiBudgetLeft !== false) },
    services: sv,
  };
}

function normQuestion(q: Raw): QuestionView {
  const m = q.message as NegotiationMessage;
  const concession = q.concession ?? (m && 'question' in m ? m.question : m && 'concession' in m ? m.concession : undefined);
  return { message: m, voi: Number(q.voi ?? 0), benefit: q.benefit ?? (m && 'benefit' in m ? m.benefit : undefined), concession, buyerQuestion: q.buyerQuestion };
}

function normNegotiation(r: Raw): NegotiateResult {
  const after: SolveReport | undefined = r.after ?? r.report ?? (r.plan ? { status: 'feasible', solver: { name: 'solver', version: '', ms: 0 }, plan: r.plan } : undefined);
  return {
    outcome: r.outcome ?? (after?.plan ? 'feasible' : 'unknown'),
    messages: arr(r.messages),
    decisions: arr(r.decisions),
    texts: arr(r.texts),
    questions: arr<Raw>(r.questions).map(normQuestion),
    accepted: arr(r.accepted),
    rejected: arr(r.rejected),
    pendingBuyerQuestions: arr<Raw>(r.pendingBuyerQuestions).map(normQuestion),
    interventions: arr(r.interventions),
    before: r.before,
    report: after,
    verification: r.verification,
    world: r.world,
    intent: r.intentAfter ?? (typeof r.intent === 'object' ? r.intent : undefined),
    planId: r.planId ?? after?.plan?.id ?? null,
    queriesUsed: r.queriesUsed,
    queryBudget: r.queryBudget,
  };
}

function normDisrupt(r: Raw): DisruptResult {
  return { disruption: r.disruption, affected: arr(r.affected), atRisk: arr(r.atRisk), failed: arr(r.failed), world: r.world };
}

function normRecovery(r: Raw): RecoverResult {
  const rec: RecoveryView = r.recovery ?? r;
  return {
    recovery: { ...rec, kept: arr(rec.kept), amended: arr(rec.amended), cancelled: arr(rec.cancelled), added: arr(rec.added), rejected: arr(rec.rejected) },
    agreement: r.agreement ?? rec.amendment,
  };
}

export interface Transport {
  fetch: typeof fetch;
  subscribe?: (url: string, onEvent: (e: MarketEvent) => void, onReady?: () => void) => () => void;
}

function sseSubscribe(url: string, onEvent: (e: MarketEvent) => void, onReady?: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(url);
  const handle = (m: MessageEvent) => {
    try {
      const e = JSON.parse(m.data) as MarketEvent;
      if (e && typeof e.seq === 'number') onEvent(e);
    } catch {
      /* keep-alive */
    }
  };
  es.onmessage = handle;
  for (const t of EVENT_TYPES) es.addEventListener(t, handle as EventListener);
  es.addEventListener('ready', () => onReady?.());
  return () => es.close();
}

export const isAwaiting = (r: NegotiateResult | AwaitingSeller): r is AwaitingSeller => 'awaiting' in r;

export function httpApi(base = '', transport: Transport = { fetch: (...a) => fetch(...a) }): Api {
  const root = base.replace(/\/$/, '');
  const subscribeUrl = transport.subscribe ?? sseSubscribe;

  async function call<T = Raw>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 45000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await transport.fetch(root + path, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError(ctrl.signal.aborted ? 'The server took too long to answer.' : 'The server is not reachable.', 0, path, ctrl.signal.aborted ? 'timeout' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(res.ok ? 'The server sent an unreadable answer.' : `The server answered ${res.status}.`, res.status, path, 'unreadable');
      }
    }
    if (!res.ok) {
      const err = data?.error;
      const msg = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : `Request failed (${res.status}).`;
      throw new ApiError(msg, res.status, path, typeof err?.code === 'string' ? err.code : undefined);
    }
    return data as T;
  }

  const enc = encodeURIComponent;

  return {
    mode: 'live',
    status: async () => {
      const st = normStatus(await call('GET', '/api/status', undefined, 12000));
      if (st.paypal.configured && !st.paypal.clientId) {
        try {
          const cfg = await call('GET', '/api/config', undefined, 8000);
          const pp: Raw = cfg?.paypal ?? {};
          if (typeof pp.clientId === 'string' && pp.clientId) st.paypal.clientId = pp.clientId;
          if (typeof pp.currency === 'string') st.paypal.currency = pp.currency as Currency;
        } catch {
          /* buttons fall back to the order's approval link */
        }
      }
      return st;
    },
    createMarket: async (req = { flagship: true }) => {
      const r = await call('POST', '/api/markets', req, 60000);
      return { market: r.id ?? r.market, world: r.world, intent: r.intent };
    },
    market: async (market) => {
      const r = await call('GET', `/api/markets/${enc(market)}`);
      return { market: r.id ?? market, world: r.world, intent: r.intent, plans: arr(r.plans), agreement: r.agreement ?? null, payments: arr(r.payments), recoveries: arr(r.recoveries), run: r.run ? normNegotiation(r.run) : undefined };
    },
    compileIntent: (market, draft) => call<CompiledIntent>('POST', '/api/intents/compile', { market, ...draft }, 60000),
    analyze: async (market, intent) => {
      const r = await call('POST', `/api/markets/${enc(market)}/analyze`, { intent }, 60000);
      return { report: (r.report ?? r) as SolveReport };
    },
    invent: async (market) => {
      const r = await call('POST', `/api/markets/${enc(market)}/invent`, {}, 90000);
      return { interventions: arr(r.interventions), coalitions: arr(r.coalitions), findings: arr(r.findings) };
    },
    negotiate: async (market, opts) => {
      const r = await call('POST', `/api/markets/${enc(market)}/negotiate`, opts?.interventions ? { interventions: opts.interventions } : {}, 120000);
      return r && r.awaitingSeller ? { awaiting: r.awaitingSeller } : normNegotiation(r);
    },
    mintSeat: (market, actor) => call<SeatLink>('POST', `/api/markets/${enc(market)}/seats`, { actor }),
    seats: async (market) => arr<SeatInfo>((await call('GET', `/api/markets/${enc(market)}/seats`)).seats),
    releaseSeat: async (market, actor) => {
      await call('POST', `/api/markets/${enc(market)}/seats/release`, { actor });
    },
    verify: (market, plan) => call<Verification>('POST', `/api/plans/${enc(plan)}/verify`, { market }),
    commit: async (market, plan) => {
      const r = await call('POST', `/api/agreements/${enc(plan)}/commit`, { market });
      return { agreement: (r.agreement ?? r) as Agreement };
    },
    approvePayment: (market, agreement, payee, amount) => call<PaymentApproval>('POST', `/api/agreements/${enc(agreement.id)}/approve-payment`, { market, payee, termsHash: agreement.termsHash, amount }),
    createOrder: (market, agreement, approvalToken) => call<PaymentIntent>('POST', '/api/payments/orders', { market, agreementId: agreement, approvalToken }, 60000),
    capture: (payment) => call<PaymentIntent>('POST', `/api/payments/${enc(payment)}/capture`, {}, 60000),
    payment: (payment) => call<PaymentIntent>('GET', `/api/payments/${enc(payment)}`),
    approveRefund: (payment, amount) => call<PaymentApproval>('POST', `/api/payments/${enc(payment)}/approve-refund`, amount ? { amount } : {}),
    refund: (payment, approvalToken) => call<PaymentIntent>('POST', `/api/payments/${enc(payment)}/refund`, { approvalToken }, 60000),
    disrupt: async (market, d) => normDisrupt(await call('POST', `/api/markets/${enc(market)}/disrupt`, d)),
    recover: async (market, disruption) => normRecovery(await call('POST', `/api/markets/${enc(market)}/recover`, disruption ? { disruption } : {}, 120000)),
    commitRecovery: async (market, recovery) => {
      const r = await call('POST', `/api/markets/${enc(market)}/recover/commit`, { recovery }, 60000);
      return { agreement: (r.agreement ?? r) as Agreement, changed: r.changed };
    },
    events: (market) =>
      new Promise<MarketEvent[]>((resolve) => {
        const got = new Map<Id, MarketEvent>();
        let stop = () => {};
        const done = () => {
          stop();
          clearTimeout(timer);
          resolve([...got.values()].sort((a, b) => a.seq - b.seq));
        };
        const timer = setTimeout(done, 6000);
        stop = subscribeUrl(`${root}/api/markets/${enc(market)}/events`, (e) => got.set(e.id, e), done);
      }),
    subscribe: (market, onEvent) => subscribeUrl(`${root}/api/markets/${enc(market)}/events`, onEvent),
    trace: (market, entity) => call<TraceResult>('GET', `/api/markets/${enc(market)}/trace/${enc(entity)}`),
  };
}

export async function resolveApi(): Promise<Api> {
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURE === '1') {
    const dev = await import('./dev/fixtureApi.ts');
    return dev.fixtureApi();
  }
  return httpApi(import.meta.env.VITE_API_URL ?? '');
}
