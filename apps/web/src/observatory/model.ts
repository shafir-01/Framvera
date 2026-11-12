import type {
  Actor,
  Claim,
  ClaimFinding,
  Coalition,
  Concession,
  ConstraintRef,
  EvidenceTier,
  Id,
  Money,
  NegotiationMessage,
  Obligation,
  Offer,
  PaymentIntent,
  PriceTier,
  Stage,
  SupplierDecision,
} from '@framvera/contracts';
import { clock, concessionSentence, fieldWord, money, stamp, when } from '../lib/format.ts';
import { latestOffers } from '../lib/world.ts';
import type { QuestionView } from '../api.ts';
import type { ObservatoryMarket, TabId } from './types.ts';

export type OfferStatus = 'published' | 'derived' | 'in-plan' | 'challenged';
export const STATUS_LABEL: Record<OfferStatus, string> = {
  published: 'Published',
  derived: 'Derived from concession',
  'in-plan': 'Used in plan',
  challenged: 'Challenged',
};

export const TIER_LABEL: Record<EvidenceTier, string> = {
  verified: 'Verified',
  corroborated: 'Corroborated',
  'single-claim': 'Single claim',
  'simulation-only': 'Simulation only',
};

export type Verdict = ClaimFinding['verdict'] | 'unchecked';
export const VERDICT_LABEL: Record<Verdict, string> = {
  consistent: 'Consistent',
  contradicted: 'Contradicted',
  unverifiable: 'Unverifiable',
  expired: 'Expired',
  unchecked: 'Not checked',
};

export interface OfferRow {
  kind: 'offer';
  rowId: string;
  offer: Offer;
  actor: string;
  stageName: string;
  unit: string;
  firstUnitMinor: number;
  tiersText: string;
  capacityClaim?: Claim;
  capacityTier?: EvidenceTier;
  windowText: string;
  negotiableText: string;
  statuses: OfferStatus[];
  blocking: boolean;
}

export interface GroupRow {
  kind: 'group';
  rowId: string;
  stage: Stage;
  count: number;
  capacity: number;
  needed?: number;
  blocking: number;
  derived: number;
  expanded: boolean;
}

export type OfferGridRow = OfferRow | GroupRow;

export interface Index {
  m: ObservatoryMarket;
  actors: Map<Id, Actor>;
  stages: Map<Id, Stage>;
  claims: Map<Id, Claim>;
  offers: Offer[];
  offerById: Map<Id, Offer>;
  findings: Map<Id, ClaimFinding>;
  planOffers: Set<Id>;
  core: ConstraintRef[];
  concessions: { c: Concession; state: 'accepted' | 'proposed' }[];
  obligations: Obligation[];
  payments: PaymentIntent[];
}

export function concessionOf(msg: NegotiationMessage): Concession | undefined {
  if (msg.type === 'AskPreference') return msg.question;
  if (msg.type === 'Propose' || msg.type === 'CounterOffer') return msg.concession;
  return undefined;
}

export function indexMarket(m: ObservatoryMarket): Index {
  const offers = latestOffers(m.world.offers);
  const findings = new Map<Id, ClaimFinding>();
  for (const e of m.events ?? []) {
    if (e.type !== 'claim.challenged') continue;
    const d = e.data as { findings?: ClaimFinding[]; claim?: Id } | undefined;
    const list = Array.isArray(d?.findings) ? d.findings : d && typeof d.claim === 'string' ? [d as unknown as ClaimFinding] : [];
    for (const f of list) if (f && typeof f.claim === 'string') findings.set(f.claim, f);
  }
  const plan = m.negotiation?.report?.plan;
  for (const f of m.invention?.findings ?? []) findings.set(f.claim, f);
  const seen = new Map<Id, { c: Concession; state: 'accepted' | 'proposed' }>();
  const add = (c: Concession | undefined, state: 'accepted' | 'proposed') => {
    if (!c) return;
    const cur = seen.get(c.id);
    if (!cur || (state === 'accepted' && cur.state === 'proposed')) seen.set(c.id, { c, state });
  };
  for (const c of m.negotiation?.accepted ?? []) add(c, 'accepted');
  for (const i of [...(m.invention?.interventions ?? []), ...(m.negotiation?.interventions ?? [])]) i.concessions.forEach((c) => add(c, 'proposed'));
  for (const q of m.negotiation?.questions ?? []) add(q.concession ?? concessionOf(q.message), 'proposed');
  for (const x of m.negotiation?.messages ?? []) add(concessionOf(x), 'proposed');
  return {
    m,
    actors: new Map(m.world.actors.map((a) => [a.id, a])),
    stages: new Map(m.world.stages.map((s) => [s.id, s])),
    claims: new Map(m.world.claims.map((c) => [c.id, c])),
    offers,
    offerById: new Map(offers.map((o) => [o.id, o])),
    findings,
    planOffers: new Set((plan?.allocations ?? []).map((a) => a.offer)),
    core: m.core,
    concessions: [...seen.values()],
    obligations: m.agreement?.obligations ?? [],
    payments: m.payments,
  };
}

const actorName = (ix: Index, id: Id | undefined) => (id ? (ix.actors.get(id)?.name ?? id) : '–');
const unitOf = (ix: Index, stage: Id) => ix.stages.get(stage)?.unit ?? 'units';

export function priceAt(tiers: PriceTier[], qty: number): Money {
  let best = tiers[0]!;
  for (const t of tiers) if (t.minQty <= qty && t.minQty >= best.minQty) best = t;
  return best.unit;
}

export function tiersText(o: Offer): string {
  if (!o.tiers.length) return '–';
  return o.tiers.map((t) => (t.minQty <= 0 || o.tiers.length === 1 ? money(t.unit) : `${money(t.unit)} from ${t.minQty}`)).join(' · ');
}

export function claimVerdict(ix: Index, c: Claim, now: number): Verdict {
  const f = ix.findings.get(c.id);
  if (f) return f.verdict;
  if (c.contradictedBy?.length) return 'contradicted';
  if (c.expiresAt && Date.parse(c.expiresAt) < now) return 'expired';
  return 'unchecked';
}

export function offerClaims(ix: Index, o: Offer): Claim[] {
  return o.claims.map((id) => ix.claims.get(id)).filter((c): c is Claim => !!c);
}

export function capacityClaim(ix: Index, o: Offer): Claim | undefined {
  const cs = offerClaims(ix, o);
  return cs.find((c) => c.subject === `capacity:${o.id}`) ?? cs.find((c) => c.subject.startsWith('capacity'));
}

/** Core constraints that name this offer directly, or its stage or supplier. */
export function constraintsFor(ix: Index, o: Offer): { c: ConstraintRef; direct: boolean }[] {
  const out: { c: ConstraintRef; direct: boolean }[] = [];
  for (const c of ix.core) {
    const direct = c.subject === o.id || c.id.endsWith(`:${o.id}`);
    if (direct || c.subject === o.stage || c.subject === o.actor) out.push({ c, direct });
  }
  return out;
}

export function offerStatuses(ix: Index, o: Offer, now: number): OfferStatus[] {
  const challenged = offerClaims(ix, o).some((c) => {
    const v = claimVerdict(ix, c, now);
    return v === 'contradicted' || v === 'expired';
  });
  const s: OfferStatus[] = [];
  if (o.derivedFrom) s.push('derived');
  if (ix.planOffers.has(o.id)) s.push('in-plan');
  if (challenged) s.push('challenged');
  if (!o.derivedFrom && !ix.planOffers.has(o.id)) s.unshift('published');
  return s;
}

function dayKey(iso: string) {
  return when(iso).split(' ').slice(0, 3).join(' ');
}

export function buildOfferRows(ix: Index, now: number): OfferRow[] {
  const order = new Map(ix.m.world.stages.map((s, i) => [s.id, i]));
  const rows = ix.offers.map((o): OfferRow => {
    const cc = capacityClaim(ix, o);
    return {
      kind: 'offer',
      rowId: o.id,
      offer: o,
      actor: actorName(ix, o.actor),
      stageName: ix.stages.get(o.stage)?.name ?? o.stage,
      unit: unitOf(ix, o.stage),
      firstUnitMinor: o.tiers[0]?.unit.minor ?? 0,
      tiersText: tiersText(o),
      capacityClaim: cc,
      capacityTier: cc?.tier,
      windowText: `${when(o.window.start)} to ${dayKey(o.window.start) === dayKey(o.window.end) ? clock(o.window.end) : when(o.window.end)}`,
      negotiableText: o.negotiable.length ? o.negotiable.map(fieldWord).join(', ') : 'Fixed',
      statuses: offerStatuses(ix, o, now),
      blocking: constraintsFor(ix, o).some((x) => x.direct),
    };
  });
  rows.sort((a, b) => (order.get(a.offer.stage) ?? 0) - (order.get(b.offer.stage) ?? 0) || a.firstUnitMinor - b.firstUnitMinor);
  return rows;
}

export function groupOfferRows(ix: Index, rows: OfferRow[], collapsed: ReadonlySet<Id>): OfferGridRow[] {
  const out: OfferGridRow[] = [];
  const qty = ix.m.intent?.quantity;
  for (const stage of ix.m.world.stages) {
    const inStage = rows.filter((r) => r.offer.stage === stage.id);
    if (!inStage.length) continue;
    const open = !collapsed.has(stage.id);
    out.push({
      kind: 'group',
      rowId: `group:${stage.id}`,
      stage,
      count: inStage.length,
      capacity: inStage.reduce((n, r) => n + r.offer.capacity, 0),
      needed: qty === undefined ? undefined : Math.ceil(qty * stage.perOutcome),
      blocking: inStage.filter((r) => r.blocking).length,
      derived: inStage.filter((r) => r.statuses.includes('derived')).length,
      expanded: open,
    });
    if (open) out.push(...inStage);
  }
  return out;
}

// ---------- Coalitions ----------
export interface CoalitionRow {
  rowId: string;
  coalition: Coalition;
  members: string;
  output: string;
  inputCost?: Money;
  payout?: Money;
  rational: 'yes' | 'no' | 'unchecked';
  state: 'In plan' | 'Proposed';
}

export function collectCoalitions(m: ObservatoryMarket): Coalition[] {
  const seen = new Map<Id, Coalition>();
  const add = (c?: Coalition) => {
    if (c && !seen.has(c.id)) seen.set(c.id, c);
  };
  m.invention?.coalitions.forEach(add);
  m.invention?.interventions.forEach((i) => add(i.coalition));
  m.negotiation?.interventions.forEach((i) => add(i.coalition));
  return [...seen.values()];
}

export function buildCoalitionRows(ix: Index): CoalitionRow[] {
  const inPlan = new Set<Id>();
  const accepted = new Set((ix.m.negotiation?.accepted ?? []).map((c) => c.id));
  for (const i of ix.m.negotiation?.interventions ?? []) {
    if (i.coalition && i.concessions.length > 0 && i.concessions.every((c) => accepted.has(c.id))) inPlan.add(i.coalition.id);
  }
  for (const o of ix.offers) if (o.derivedFrom?.coalition) inPlan.add(o.derivedFrom.coalition);
  const cur = ix.m.world.currency;
  return collectCoalitions(ix.m).map((c) => {
    const costMinor = c.inputs.reduce((n, i) => {
      const o = ix.offerById.get(i.offer);
      return o ? n + priceAt(o.tiers, i.qty).minor * i.qty : n;
    }, 0);
    return {
      rowId: c.id,
      coalition: c,
      members: c.members.map((id) => actorName(ix, id)).join(', '),
      output: `${c.output.qty} ${unitOf(ix, c.output.stage)} of ${(ix.stages.get(c.output.stage)?.name ?? c.output.stage).toLowerCase()}`,
      inputCost: c.inputs.length ? { currency: cur, minor: costMinor } : undefined,
      payout: c.split.length ? { currency: cur, minor: c.split.reduce((n, s) => n + s.share.minor, 0) } : undefined,
      rational: c.rationality.length ? (c.rationality.every((r) => r.ok) ? 'yes' : 'no') : 'unchecked',
      state: inPlan.has(c.id) ? 'In plan' : 'Proposed',
    };
  });
}

// ---------- Questions ----------
export type PolicyOutcome = 'Accepted' | 'Rejected' | 'Countered' | 'Awaiting answer';
const BASIS_LABEL = { 'synthetic-policy': 'Synthetic policy', 'seller-terminal': 'Seller terminal' } as const;

export interface QuestionRow {
  rowId: string;
  message: Extract<NegotiationMessage, { type: 'AskPreference' | 'Propose' }>;
  to: string;
  ask: string;
  benefit: string;
  voi?: number;
  voiShare?: number;
  outcome: PolicyOutcome;
  decision?: SupplierDecision;
  counter: string;
  basis: string;
}

export function buildQuestionRows(ix: Index): QuestionRow[] {
  const voi = new Map<Id, number>();
  const msgs = new Map<Id, QuestionRow['message']>();
  const keep = (x: NegotiationMessage) => {
    if (x.type === 'AskPreference' || x.type === 'Propose') msgs.set(x.id, x);
  };
  const views = new Map<Id, QuestionView>();
  for (const q of [...(ix.m.negotiation?.questions ?? []), ...(ix.m.negotiation?.pendingBuyerQuestions ?? [])]) {
    keep(q.message);
    voi.set(q.message.id, q.voi);
    views.set(q.message.id, q);
  }
  (ix.m.negotiation?.messages ?? []).forEach(keep);
  const decisions = new Map((ix.m.negotiation?.decisions ?? []).map((d) => [d.message, d]));
  const max = Math.max(0, ...voi.values());
  return [...msgs.values()]
    .map((message): QuestionRow => {
      const d = decisions.get(message.id);
      const view = views.get(message.id);
      const c = view?.concession ?? concessionOf(message)!;
      const v = voi.get(message.id);
      return {
        rowId: message.id,
        message,
        to: actorName(ix, message.to),
        ask: concessionSentence(c, ix.m.world),
        benefit: view?.benefit ?? (message.type === 'AskPreference' ? message.benefit : c.rationale),
        voi: v,
        voiShare: v !== undefined && max > 0 ? v / max : undefined,
        outcome: !d ? 'Awaiting answer' : d.accept ? 'Accepted' : d.counter ? 'Countered' : 'Rejected',
        decision: d,
        counter: d?.counter ? concessionSentence(d.counter, ix.m.world) : '',
        basis: d ? BASIS_LABEL[d.basis] : '',
      };
    })
    .sort((a, b) => (b.voi ?? -1) - (a.voi ?? -1));
}

// ---------- Claims ----------
export interface ClaimRow {
  rowId: string;
  claim: Claim;
  actor: string;
  verdict: Verdict;
  finding?: ClaimFinding;
  relied: Offer[];
}

export function buildClaimRows(ix: Index, now: number): ClaimRow[] {
  return ix.m.world.claims.map((claim) => ({
    rowId: claim.id,
    claim,
    actor: actorName(ix, claim.actor),
    verdict: claimVerdict(ix, claim, now),
    finding: ix.findings.get(claim.id),
    relied: ix.offers.filter((o) => o.claims.includes(claim.id)),
  }));
}

// ---------- Payments ----------
export interface PaymentRow {
  rowId: string;
  payment: PaymentIntent;
  payee: string;
  fetched: boolean;
}

export function buildPaymentRows(ix: Index): PaymentRow[] {
  return ix.payments.map((p) => ({ rowId: p.id, payment: p, payee: actorName(ix, p.payee), fetched: !!p.paypal.lastFetchedAt }));
}

// ---------- Provenance detail ----------
export type Tone = 'neutral' | 'bad' | 'good' | 'warn';
export interface DetailItem {
  text: string;
  note?: string;
  badge?: string;
  tone?: Tone;
  link?: { tab: TabId; id: Id; label: string };
}
export interface DetailSection {
  heading: string;
  empty: string;
  /** Show the empty message instead of hiding the section. */
  keep?: boolean;
  items: DetailItem[];
}
export interface Detail {
  title: string;
  subtitle: string;
  sections: DetailSection[];
}

const verdictTone = (v: Verdict): Tone => (v === 'contradicted' || v === 'expired' ? 'bad' : v === 'consistent' ? 'good' : 'neutral');

export function offerDetail(ix: Index, o: Offer, now: number): Detail {
  const cons = constraintsFor(ix, o);
  const concessions = ix.concessions.filter(({ c }) => c.target.kind === 'offer' && c.target.offer === o.id);
  for (const id of o.derivedFrom?.concessions ?? []) {
    const hit = ix.concessions.find((x) => x.c.id === id);
    if (hit && !concessions.includes(hit)) concessions.push(hit);
  }
  const obligations = ix.obligations.filter((b) => b.offer === o.id);
  const alloc = ix.m.negotiation?.report?.plan?.allocations.find((a) => a.offer === o.id);
  const pays = ix.payments.filter((p) => p.obligations.some((id) => obligations.some((b) => b.id === id)));
  return {
    title: `${actorName(ix, o.actor)}, ${ix.stages.get(o.stage)?.name ?? o.stage}`,
    subtitle: `Offer ${o.id}, version ${o.version}. Source: ${o.provenance.source}.`,
    sections: [
      {
        heading: 'Constraints it appears in',
        keep: true,
        empty: ix.core.length ? 'No blocking constraint names this offer or its stage.' : 'No constraint set has been computed yet.',
        items: cons.map(({ c, direct }) => ({ text: c.text, note: `${c.kind} constraint ${c.id}`, badge: direct ? 'Blocking' : 'Stage-wide', tone: direct ? 'bad' : 'warn' })),
      },
      {
        heading: 'Concessions that changed it',
        keep: !!o.derivedFrom,
        empty: o.derivedFrom ? 'The concessions behind this offer are not in this session.' : 'No concession targets this offer.',
        items: concessions.map(({ c, state }) => ({
          text: concessionSentence(c, ix.m.world),
          note: c.rationale,
          badge: state === 'accepted' ? 'Accepted' : 'Proposed',
          tone: state === 'accepted' ? 'good' : 'neutral',
        })),
      },
      {
        heading: 'Claims it depends on',
        empty: 'This offer has no recorded claims.',
        items: offerClaims(ix, o).map((c) => {
          const v = claimVerdict(ix, c, now);
          return { text: c.assertion, note: `${TIER_LABEL[c.tier]} evidence`, badge: VERDICT_LABEL[v], tone: verdictTone(v), link: { tab: 'claims', id: c.id, label: 'Open claim' } };
        }),
      },
      {
        heading: 'Plan allocation',
        empty: 'Not used in the current plan.',
        items: alloc ? [{ text: `${alloc.qty} ${unitOf(ix, alloc.stage)} for ${money(alloc.cost)}`, note: `${when(alloc.start)} to ${when(alloc.finish)}` }] : [],
      },
      {
        heading: 'Obligations',
        empty: 'No obligation has been committed for this offer.',
        items: obligations.map((b) => ({
          text: `${b.qty} ${unitOf(ix, b.stage)} for ${money(b.amount)}, due ${when(b.due)}`,
          note: `Obligation ${b.id}${b.replaces ? `, replaces ${b.replaces}` : ''}`,
          badge: b.state.replace('_', ' ').toLowerCase(),
          tone: b.state === 'BREACHED' ? 'bad' : b.state === 'FULFILLED' ? 'good' : b.state === 'AT_RISK' ? 'warn' : 'neutral',
        })),
      },
      {
        heading: 'PayPal records (Sandbox)',
        keep: obligations.length > 0,
        empty: obligations.length ? 'No payment has been prepared for these obligations.' : 'Appears once an obligation has a payment.',
        items: pays.map((p) => ({
          text: `${money(p.amount)} to ${actorName(ix, p.payee)}`,
          note: p.paypal.lastFetchedAt ? `PayPal status ${p.paypal.status ?? 'unknown'}, fetched ${stamp(p.paypal.lastFetchedAt)}` : 'PayPal state not fetched yet',
          badge: 'Sandbox',
          link: { tab: 'payments', id: p.id, label: 'Open payment' },
        })),
      },
    ],
  };
}

export function coalitionDetail(ix: Index, row: CoalitionRow): Detail {
  const c = row.coalition;
  const cur = ix.m.world.currency;
  return {
    title: `Coalition of ${c.members.length}`,
    subtitle: `${row.members}. Creates ${row.output}.`,
    sections: [
      {
        heading: 'Cost breakdown by input',
        empty: 'No inputs recorded.',
        items: c.inputs.map((i) => {
          const o = ix.offerById.get(i.offer);
          const unit = o ? priceAt(o.tiers, i.qty) : undefined;
          return {
            text: `${i.qty} ${o ? unitOf(ix, o.stage) : 'units'} from ${actorName(ix, o?.actor)}`,
            note: unit ? `${money(unit)} each, ${money({ currency: cur, minor: unit.minor * i.qty })}` : `Offer ${i.offer} not found`,
            link: o ? { tab: 'offers', id: o.id, label: 'Open offer' } : undefined,
          };
        }),
      },
      {
        heading: 'Payment split',
        empty: 'No split proposed yet.',
        items: c.split.map((s) => {
          const r = c.rationality.find((x) => x.actor === s.actor);
          return {
            text: `${actorName(ix, s.actor)} receives ${money(s.share)}`,
            note: r ? `${s.reason}. Outside option ${money(r.outside)}.` : s.reason,
            badge: r ? (r.ok ? 'Beats outside option' : 'Below outside option') : undefined,
            tone: r ? (r.ok ? 'good' : 'bad') : undefined,
          };
        }),
      },
    ],
  };
}

export function questionDetail(row: QuestionRow): Detail {
  const d = row.decision;
  return {
    title: row.ask,
    subtitle: `Asked of ${row.to}. ${row.message.type === 'AskPreference' ? 'Preference question' : 'Proposal'} ${row.message.id}, sent ${stamp(row.message.at)}.`,
    sections: [
      { heading: 'Why ask', empty: '', items: [{ text: row.benefit }] },
      {
        heading: 'Value of information',
        empty: 'No value was computed for this message.',
        items: row.voi === undefined ? [] : [{ text: row.voi.toFixed(2), note: 'Ranking score from the question selector. Higher means a better question to ask next.' }],
      },
      {
        heading: 'Policy decision',
        keep: true,
        empty: 'The supplier has not answered yet.',
        items: d ? [{ text: d.reason, note: `Decided by ${row.basis.toLowerCase()}.`, badge: row.outcome, tone: row.outcome === 'Accepted' ? 'good' : row.outcome === 'Rejected' ? 'bad' : 'warn' }] : [],
      },
      {
        heading: 'Counter',
        empty: 'No counter was made.',
        items: d?.counter ? [{ text: row.counter, note: d.counter.rationale }] : [],
      },
    ],
  };
}

export function claimDetail(ix: Index, row: ClaimRow): Detail {
  const c = row.claim;
  return {
    title: c.assertion,
    subtitle: `${row.actor}. ${c.subject}. ${TIER_LABEL[c.tier]} evidence. Source: ${c.provenance.source}.`,
    sections: [
      {
        heading: 'Finding',
        keep: true,
        empty: 'This claim has not been checked.',
        items: row.finding ? [{ text: row.finding.text, badge: VERDICT_LABEL[row.finding.verdict], tone: verdictTone(row.finding.verdict) }] : [],
      },
      {
        heading: 'Contradicted by',
        empty: 'Nothing contradicts this claim.',
        items: (c.contradictedBy ?? []).map((id) => {
          const other = ix.claims.get(id);
          return {
            text: other ? other.assertion : `Record ${id}`,
            note: other ? `${actorName(ix, other.actor)}, ${TIER_LABEL[other.tier]} evidence` : undefined,
            tone: 'bad' as Tone,
            link: other ? { tab: 'claims' as TabId, id, label: 'Open claim' } : undefined,
          };
        }),
      },
      {
        heading: 'Offers relying on it',
        empty: 'No offer relies on this claim.',
        items: row.relied.map((o) => ({ text: `${actorName(ix, o.actor)}, ${ix.stages.get(o.stage)?.name ?? o.stage}`, note: `Offer ${o.id}`, link: { tab: 'offers' as TabId, id: o.id, label: 'Open offer' } })),
      },
    ],
  };
}

export function paymentDetail(ix: Index, row: PaymentRow): Detail {
  const p = row.payment;
  const r = p.paypal;
  const converted = p.charged.currency !== p.amount.currency || p.charged.minor !== p.amount.minor;
  return {
    title: `Payment to ${row.payee}`,
    subtitle: `${money(p.amount)}${converted ? `, charged ${money(p.charged)}` : ''}. PayPal Sandbox.`,
    sections: [
      {
        heading: 'PayPal record (Sandbox)',
        empty: '',
        items: [
          { text: `Status ${r.status ?? 'not reported'}`, note: r.lastFetchedAt ? `Fetched from PayPal ${stamp(r.lastFetchedAt)}` : 'Not fetched from PayPal yet', badge: 'Sandbox' },
          ...(r.orderId ? [{ text: `Order ${r.orderId}` }] : []),
          ...(r.captureId ? [{ text: `Capture ${r.captureId}` }] : []),
          ...r.refunds.map((x) => ({ text: `Refund ${x.id}, ${money(x.amount)}`, note: `Status ${x.status}` })),
          ...r.debugIds.map((id) => ({ text: `Debug id ${id}` })),
        ],
      },
      {
        heading: 'Obligations paid',
        empty: 'No obligations recorded.',
        items: ix.obligations
          .filter((b) => p.obligations.includes(b.id))
          .map((b) => ({ text: `${actorName(ix, b.actor)}, ${b.qty} ${unitOf(ix, b.stage)}, ${money(b.amount)}`, note: `Obligation ${b.id}`, link: { tab: 'offers' as TabId, id: b.offer, label: 'Open offer' } })),
      },
      ...(p.fx ? [{ heading: 'Currency conversion', empty: '', items: [{ text: `Rate ${p.fx.rate}`, note: `${p.fx.source}, ${stamp(p.fx.at)}` }] }] : []),
    ],
  };
}

export function summary(rows: OfferRow[], ix: Index, now: number) {
  return {
    offers: rows.length,
    blocking: rows.filter((r) => r.blocking).length,
    derived: rows.filter((r) => r.statuses.includes('derived')).length,
    contradicted: ix.m.world.claims.filter((c) => claimVerdict(ix, c, now) === 'contradicted').length,
  };
}
