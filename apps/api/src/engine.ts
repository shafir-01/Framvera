import type { Agreement, Disruption, Intent, NegotiationMessage, Obligation, Offer, Plan, World } from '@framvera/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (...a: any[]) => any;
export type Template = 'flagship' | 'exhibition' | 'circular' | 'unseen';
export interface MarketSpec {
  template: Template;
  seed: number | null;
  family: string;
}
export interface Bundle {
  world: World;
  intent: Intent;
  truth: any;
}

/** The surface the API calls. Real modules are adapted into these shapes by loadEngine; tests pass stubs. */
export interface Engine {
  flagshipWorld?: () => Bundle;
  generateWorld?: (seed: number, family: string) => Bundle;
  createMarket?: (spec: MarketSpec) => Bundle;
  templates?: () => Template[];
  solve?: (...a: any[]) => Promise<any>;
  explainInfeasible?: (...a: any[]) => Promise<any>;
  findInterventions?: (...a: any[]) => Promise<any>;
  synthesizeCoalitions?: (...a: any[]) => any;
  applyConcessions?: (...a: any[]) => any;
  verifyPlan?: (...a: any[]) => any;
  negotiate?: (...a: any[]) => Promise<any>;
  challengeClaims?: (...a: any[]) => any;
  compileIntent?: (...a: any[]) => Promise<any>;
  commit?: (...a: any[]) => any;
  /** Signs an agreement on behalf of parties whose terms match their standing offers, then commits when all signed. */
  sign?: (agreement: Agreement, world: World, truth: any, plan?: Plan, intent?: Intent) => { agreement: Agreement; accepts: NegotiationMessage[]; declined: { actor: string; reason: string }[] };
  disrupt?: (...a: any[]) => any;
  recover?: (...a: any[]) => Promise<any>;
  commitRecovery?: (...a: any[]) => { original: Agreement; amended: Agreement; obligations: Obligation[] };
  Ledger?: new (path: string) => any;
  PayPalSandboxAdapter?: new (...a: any[]) => any;
  FakeGateway?: new (...a: any[]) => any;
  hashTerms?: (o: unknown) => string;
  paymentState?: (r: any) => string;
  /** Money operations with reconcile-before-retry semantics from the payments module. */
  payments?: { open?: Fn; capture?: Fn; refund?: Fn; reconcile?: Fn; refundable?: Fn };
  mechanisms?: Record<string, Fn>;
  options?: Record<string, Fn>;
}

export class Unavailable extends Error {
  constructor(public what: string) {
    super(`${what} is not available`);
  }
}

export function need<T>(fn: T | undefined, what: string): T {
  if (typeof fn !== 'function') throw new Unavailable(what);
  return fn;
}

const CORE = ['contracts', 'market', 'solver', 'negotiation', 'obligations', 'paypal'] as const;
const DEPTH = ['mechanisms', 'options'] as const;

async function load(name: string): Promise<Record<string, any>> {
  try {
    return { ...(await import(/* @vite-ignore */ `@framvera/${name}`)) };
  } catch {
    try {
      return { ...(await import(/* @vite-ignore */ new URL(`../../../packages/${name}/src/index.ts`, import.meta.url).href)) };
    } catch {
      return {};
    }
  }
}

const fn = (m: Record<string, any>, ...names: string[]): Fn | undefined => {
  for (const n of names) if (typeof m[n] === 'function') return m[n];
  return undefined;
};

const priceOf = (offer: Offer, qty: number): number => {
  const tiers = [...offer.tiers].sort((a, b) => a.minQty - b.minQty);
  let unit = tiers[0]?.unit.minor ?? 0;
  for (const t of tiers) if (qty >= t.minQty) unit = t.unit.minor;
  return unit * qty + offer.setupFee.minor;
};

/** A supplier signs only terms it already stands behind: its own (possibly derived) offer, inside capacity, minimum, price and window. */
export function standingTermsProblem(o: Obligation, offer: Offer | undefined): string | null {
  if (!offer) return `offer ${o.offer} is no longer standing`;
  if (offer.actor !== o.actor) return 'offer belongs to another supplier';
  if (o.qty > offer.capacity) return `quantity ${o.qty} is above capacity ${offer.capacity}`;
  if (o.qty < offer.minQty) return `quantity ${o.qty} is below the minimum ${offer.minQty}`;
  if (o.amount.minor !== priceOf(offer, o.qty)) return 'amount differs from the offer price';
  const start = Date.parse(o.start);
  const work = Math.ceil((o.qty / offer.ratePerHour) * 60) * 60_000;
  if (start + 1000 < Date.parse(offer.window.start) || start + work > Date.parse(offer.window.end) + 1000) return 'schedule is outside the offer window';
  return null;
}

const fmtMinor = (minor: number, currency: string): string => {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = abs % 100 ? `,${String(abs % 100).padStart(2, '0')}` : '';
  return `${minor < 0 ? '-' : ''}${whole}${frac} ${currency === 'SEK' ? 'kr' : currency}`;
};
let contractsFmt: ((m: { currency: string; minor: number }) => string) | undefined;

/** Plain-language amounts in reasons shown to people: raw minor units become formatted money. */
export function moneyText(currency: string) {
  const f = (minor: number) => (contractsFmt ? contractsFmt({ currency, minor }) : fmtMinor(minor, currency));
  return (t: string) =>
    t
      .replace(/Costs (-?\d+), above the budget of (-?\d+)\./g, (_, a, b) => `Costs ${f(Number(a))}, above the budget of ${f(Number(b))}.`)
      .replace(/costs (-?\d+) more in minor units\./g, (_, a) => `costs ${f(Number(a))} more.`);
}

export async function loadEngine(): Promise<Engine> {
  const raw: Record<string, Record<string, any>> = {};
  for (const m of [...CORE, ...DEPTH]) raw[m] = await load(m);
  const all: Record<string, any> = Object.assign({}, ...CORE.map((m) => raw[m]));
  const { market, solver, negotiation, obligations, paypal } = raw as Record<(typeof CORE)[number], Record<string, any>>;
  const e: Engine = {};

  // ---------- market ----------
  const flagship = fn(market!, 'flagshipWorld');
  const generate = fn(market!, 'generateWorld');
  const tpl: Record<string, Fn | undefined> = {
    flagship,
    exhibition: fn(market!, 'exhibitionWorld', 'exhibitionMarket'),
    circular: fn(market!, 'circularWorld', 'circularMarket'),
  };
  const registry = market!.TEMPLATES ?? market!.templates;
  if (registry && typeof registry === 'object') {
    for (const [k, v] of Object.entries(registry)) if (!tpl[k] && typeof v === 'function') tpl[k] = v as Fn;
    for (const [k, v] of Object.entries(registry)) if (!tpl[k] && typeof (v as any)?.build === 'function') tpl[k] = (v as any).build;
  }
  const unseen = fn(market!, 'unseenWorld', 'generateUnseen');
  if (flagship) e.flagshipWorld = () => flagship();
  if (generate) e.generateWorld = (seed, family) => generate(seed, family);
  if (flagship || generate) {
    e.createMarket = ({ template, seed, family }) => {
      if (template === 'unseen') {
        if (unseen) return unseen(seed ?? 0, family);
        return need(generate, 'market generator')(seed ?? 0, family);
      }
      if (template === 'flagship' && seed !== null && !tpl.flagship) return need(generate, 'market generator')(seed, family);
      const t = tpl[template];
      if (!t) throw new Unavailable(`${template} market`);
      return t.length > 0 && seed !== null ? t(seed) : t();
    };
    e.templates = () => ([...(['flagship', 'exhibition', 'circular'] as const).filter((k) => tpl[k]), ...(generate || unseen ? (['unseen'] as const) : [])]);
  }

  // ---------- solver ----------
  for (const k of ['solve', 'explainInfeasible', 'findInterventions', 'synthesizeCoalitions', 'applyConcessions', 'verifyPlan'] as const) {
    const f = fn(solver!, k);
    if (f) (e as any)[k] = f;
  }

  // ---------- negotiation ----------
  const negotiate = fn(negotiation!, 'negotiate');
  if (negotiate) {
    e.negotiate = async (world: World, intent: Intent, truth: any, opts: any = {}) => {
      // A buyer-chosen what-if set replaces the search: the loop negotiates exactly these interventions.
      const chosen = Array.isArray(opts.chosen) && e.solve && e.applyConcessions && e.verifyPlan
        ? { solver: { solve: e.solve, applyConcessions: e.applyConcessions, verifyPlan: e.verifyPlan, findInterventions: async () => opts.chosen } }
        : {};
      const run = await negotiate(world, intent, truth, {
        ...chosen,
        ...(opts.maxQuestions ? { budget: opts.maxQuestions } : {}),
        ...(opts.terminal ? { terminal: opts.terminal } : {}),
        ...(opts.buyerConsent ? { buyerConsent: opts.buyerConsent } : {}),
      });
      const report = run.after ?? undefined;
      const plan: Plan | undefined = report?.plan && run.verification?.ok ? report.plan : undefined;
      // A concession and its attached charge stand or fall together, so each group is left out as one.
      let unlockedBy: string[] | undefined;
      if (plan && run.accepted?.length && e.applyConcessions && e.solve && opts.explain !== false) {
        const groups = new Map<string, any[]>();
        for (const c of run.accepted) groups.set(String(c.id).split(':')[0]!, [...(groups.get(String(c.id).split(':')[0]!) ?? []), c]);
        unlockedBy = [];
        for (const [, g] of groups) {
          const rest = run.accepted.filter((x: any) => !g.includes(x));
          try {
            const next = e.applyConcessions(world, intent, rest);
            const r = await e.solve(next.world, next.intent, { timeLimitMs: 5000 });
            if (r.status === 'infeasible') unlockedBy.push(...g.map((c: any) => c.id));
          } catch {
            unlockedBy.push(...g.map((c: any) => c.id));
          }
        }
      }
      return { ...run, intent: run.intentAfter, report, plan, ...(unlockedBy ? { unlockedBy } : {}) };
    };
  }
  const compile = fn(negotiation!, 'compileIntent');
  if (compile) e.compileIntent = (text: string, world: World, opts: { live?: boolean } = {}) => compile(text, world, opts.live ? {} : { client: null });
  const claims = fn(negotiation!, 'challengeClaims');
  if (claims) e.challengeClaims = (world: World, plan: Plan | null, opts?: any) => claims(world, plan ?? undefined, opts);

  // ---------- obligations ----------
  const commit = fn(obligations!, 'commit');
  if (commit) e.commit = (plan: Plan, intent: Intent, decisions: unknown[] = [], opts: any = {}) => commit(plan, intent, decisions, opts);
  const acceptMessage = fn(obligations!, 'acceptMessage');
  const accept = fn(obligations!, 'accept');
  const commitAgreement = fn(obligations!, 'commitAgreement');
  const buyerId: string = typeof obligations!.BUYER === 'string' ? obligations!.BUYER : 'buyer';
  const ownSign = fn(obligations!, 'sign');
  if (ownSign) e.sign = (agreement, world, truth) => ownSign(agreement, world, truth);
  else if (acceptMessage && accept && commitAgreement) {
    e.sign = (agreement, world, truth) => {
      let a = agreement;
      const accepts: NegotiationMessage[] = [];
      const declined: { actor: string; reason: string }[] = [];
      if (a.state !== 'PROPOSED') return { agreement: a, accepts, declined };
      const offers = new Map(world.offers.map((o) => [o.id, o]));
      const at = new Date().toISOString();
      for (const party of a.parties) {
        if (a.acceptances.some((x) => x.actor === party && x.termsHash === a.termsHash)) continue;
        const isBuyer = party === buyerId;
        if (!isBuyer) {
          if (!truth?.policies?.[party]) {
            declined.push({ actor: party, reason: 'no answer from this supplier' });
            continue;
          }
          const problem = a.obligations.filter((o) => o.actor === party).map((o) => standingTermsProblem(o, offers.get(o.offer))).find(Boolean);
          if (problem) {
            declined.push({ actor: party, reason: problem });
            continue;
          }
        }
        const msg = acceptMessage(a, party, `prop:${a.id}:v${a.version}`, at) as Extract<NegotiationMessage, { type: 'Accept' }>;
        a = accept(a, { ...msg, basis: isBuyer ? 'buyer' : 'synthetic-policy' }, buyerId);
        accepts.push(msg);
      }
      if (a.state === 'ACCEPTED_BY_PARTIES') a = commitAgreement(a);
      return { agreement: a, accepts, declined };
    };
  }
  const disrupt = fn(obligations!, 'disrupt');
  if (disrupt) e.disrupt = (agreement: Agreement, world: World, d: Disruption, opts: any = {}) => disrupt(agreement, world, d, opts);
  const recover = fn(obligations!, 'recover');
  if (recover) {
    e.recover = async (agreement: Agreement, world: World, intent: Intent, d: Disruption, opts: any = {}) => {
      const r = await recover(agreement, world, intent, d, opts);
      const cands: any[] = Array.isArray(r.candidates) ? r.candidates.filter((c: any) => !c.permissible) : [];
      const currency = intent.budget.currency;
      const text = moneyText(currency);
      r.rejected = (r.rejected ?? []).map((x: any) => {
        const c = cands.find((y) => y.description === x.description);
        const reason = text(String(x.reason ?? ''));
        if (!c || x.extraCost) return { ...x, reason };
        return { ...x, reason, extraCost: { currency, minor: c.extraCostMinor }, slipHours: c.slipHours };
      });
      if (Array.isArray(r.candidates)) r.candidates = r.candidates.map((c: any) => ({ ...c, reasons: (c.reasons ?? []).map((t: string) => text(t)) }));
      if (r.counterfactual?.text) r.counterfactual = { ...r.counterfactual, text: text(r.counterfactual.text) };
      return r;
    };
  }
  const commitRecovery = fn(obligations!, 'commitRecovery');
  if (commitRecovery) e.commitRecovery = commitRecovery;
  if (typeof obligations!.Ledger === 'function') e.Ledger = obligations!.Ledger;

  // ---------- payments ----------
  if (typeof paypal!.PayPalSandboxAdapter === 'function') e.PayPalSandboxAdapter = paypal!.PayPalSandboxAdapter;
  if (typeof paypal!.FakeGateway === 'function') e.FakeGateway = paypal!.FakeGateway;
  const pstate = fn(paypal!, 'stateFromRecord');
  if (pstate) e.paymentState = pstate;
  const capture = fn(paypal!, 'capturePayment');
  if (capture) e.payments = { open: fn(paypal!, 'openOrder'), capture, refund: fn(paypal!, 'refundPayment'), reconcile: fn(paypal!, 'reconcile'), refundable: fn(paypal!, 'refundable') };
  const fmt = fn(all, 'fmt');
  if (fmt) contractsFmt = fmt;
  const hash = fn(all, 'hashTerms');
  if (hash) e.hashTerms = hash;

  // ---------- depth modules ----------
  const pick = (m: Record<string, any>) => Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'function' && !/^[A-Z]/.test(v.name ?? ''))) as Record<string, Fn>;
  if (Object.keys(raw.mechanisms!).length) e.mechanisms = pick(raw.mechanisms!);
  if (Object.keys(raw.options!).length) e.options = pick(raw.options!);
  return e;
}

export function availability(e: Engine) {
  const has = (...k: (keyof Engine)[]) => k.every((x) => typeof e[x] === 'function');
  return {
    market: has('flagshipWorld') || has('createMarket'),
    templates: e.templates?.() ?? (has('flagshipWorld') ? ['flagship'] : []),
    solver: has('solve', 'verifyPlan'),
    inverse: has('findInterventions'),
    negotiation: has('negotiate'),
    obligations: has('commit', 'recover', 'Ledger'),
    paypalAdapter: has('PayPalSandboxAdapter'),
    mechanisms: Object.keys(e.mechanisms ?? {}).length > 0,
    options: Object.keys(e.options ?? {}).length > 0,
  };
}
