import type { Agreement, ClaimFinding, Concession, Disruption, Id, MarketEvent, NegotiationMessage, Obligation, PaymentIntent, Plan, SolveReport, SupplierDecision } from '@framvera/contracts';
import { concessionSentence, money, shortHash } from '../lib/format.ts';
import type { Candidate, Dossier, EntityKind, Fact, Headline, Trace, TraceItem, TraceNode } from './types.ts';

const live = (o: Obligation) => o.state !== 'REPLACED' && o.state !== 'CANCELLED';

const name = (d: Dossier, id: Id | undefined) => (id ? (d.world.actors.find((a) => a.id === id)?.name ?? id) : '–');

function typed<T>(events: MarketEvent[], type: MarketEvent['type']): { e: MarketEvent; data: T }[] {
  return events.filter((e) => e.type === type).map((e) => ({ e, data: e.data as T }));
}

function disruptionOf(e: MarketEvent): Disruption | undefined {
  const d = e.data as ({ disruption?: Disruption } & Partial<Disruption>) | null;
  const x = d?.disruption ?? (d?.kind ? (d as Disruption) : undefined);
  return x && x.id ? x : undefined;
}

function concessionsIn(events: MarketEvent[]): Map<Id, Concession> {
  const out = new Map<Id, Concession>();
  for (const { data: m } of typed<NegotiationMessage>(events, 'negotiation.message')) {
    if (m.type === 'Propose' || m.type === 'CounterOffer') out.set(m.concession.id, m.concession);
    if (m.type === 'AskPreference') out.set(m.question.id, m.question);
  }
  for (const { data } of typed<{ concessions?: Concession[] }>(events, 'intervention.found')) for (const c of data.concessions ?? []) if (!out.has(c.id)) out.set(c.id, c);
  return out;
}

export function planOf(d: Dossier, a: Agreement | null | undefined): Plan | undefined {
  return a ? d.plans.find((p) => p.id === a.plan) : undefined;
}

/** Concession ids carried by the offers a plan actually uses. */
export function derivedConcessions(d: Dossier, plan: Plan | undefined): Id[] {
  if (!plan) return [];
  const used = new Set(plan.allocations.map((a) => a.offer));
  const ids = new Set<Id>();
  for (const o of d.world.offers) if (used.has(o.id)) for (const c of o.derivedFrom?.concessions ?? []) ids.add(c);
  return [...ids];
}

/** A mismatch between the local ledger and PayPal's own status, to be reconciled before continuing. */
export function paypalDivergence(p: PaymentIntent): string | undefined {
  const s = p.paypal.status;
  if (!p.paypal.orderId) return undefined;
  if (p.state === 'CAPTURE_COMPLETED' && s && s !== 'COMPLETED') return `The ledger says captured but PayPal reports ${s}.`;
  if (s === 'COMPLETED' && !['CAPTURE_COMPLETED', 'REFUND_PENDING', 'REFUND_COMPLETED', 'REFUND_DENIED', 'REFUND_UNKNOWN'].includes(p.state)) return `PayPal reports COMPLETED but the ledger says ${p.state}.`;
  return undefined;
}

function findingsFor(events: MarketEvent[], claim: Id): ClaimFinding[] {
  return typed<{ findings?: ClaimFinding[] }>(events, 'claim.challenged')
    .flatMap((x) => x.data.findings ?? [])
    .filter((f) => f.claim === claim);
}

const isBad = (f: ClaimFinding) => f.verdict === 'contradicted' || f.verdict === 'expired';

function resolve(d: Dossier, events: MarketEvent[], id: Id): { kind: EntityKind; id: Id; label: string } | undefined {
  const pay = d.payments.find((p) => p.id === id || p.operationKey === id || p.paypal.orderId === id || p.paypal.captureId === id || p.paypal.refunds.some((r) => r.id === id));
  if (pay) return { kind: 'payment', id: pay.id, label: `Payment ${pay.id}` };
  if (d.agreement?.id === id) return { kind: 'agreement', id, label: `Agreement ${id}` };
  const ob = d.agreement?.obligations.find((o) => o.id === id);
  if (ob) return { kind: 'obligation', id, label: `${name(d, ob.actor)} obligation ${id}` };
  if (d.world.claims.some((c) => c.id === id)) return { kind: 'claim', id, label: `Claim ${id}` };
  const offer = d.world.offers.find((o) => o.id === id);
  if (offer) return { kind: 'offer', id, label: `${name(d, offer.actor)} offer` };
  const actor = d.world.actors.find((a) => a.id === id);
  if (actor) return { kind: 'actor', id, label: actor.name };
  if (typed<unknown>(events, 'disruption.applied').some((x) => disruptionOf(x.e)?.id === id)) return { kind: 'disruption', id, label: `Disruption ${id}` };
  return undefined;
}

function candidates(d: Dossier, events: MarketEvent[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of d.payments) out.push({ id: p.id, kind: 'payment', label: `${name(d, p.payee)} ${money(p.amount)}`, group: 'Payments' });
  if (d.agreement) out.push({ id: d.agreement.id, kind: 'agreement', label: `Agreement v${d.agreement.version}`, group: 'Agreement' });
  const seen = new Set<Id>();
  for (const { e } of typed<unknown>(events, 'disruption.applied')) {
    const x = disruptionOf(e);
    if (x && !seen.has(x.id)) {
      seen.add(x.id);
      out.push({ id: x.id, kind: 'disruption', label: x.detail || `${x.kind} by ${name(d, x.actor)}`, group: 'Failed or contradicted' });
    }
  }
  for (const c of d.world.claims) {
    if (c.contradictedBy?.length || findingsFor(events, c.id).some(isBad)) out.push({ id: c.id, kind: 'claim', label: `${name(d, c.actor)}: ${c.assertion}`, group: 'Failed or contradicted' });
  }
  for (const a of d.world.actors) if (!a.active && a.kind !== 'buyer') out.push({ id: a.id, kind: 'actor', label: `${a.name} is no longer active`, group: 'Failed or contradicted' });
  return out;
}


function obligationsOf(d: Dossier, p: PaymentIntent): Obligation[] {
  return (d.agreement?.obligations ?? []).filter((o) => p.obligations.includes(o.id));
}

function paypalNode(p: PaymentIntent): TraceNode {
  const r = p.paypal;
  const divergence = paypalDivergence(p);
  const facts: Fact[] = [];
  if (!r.orderId) facts.push({ label: 'Order', value: 'No PayPal order exists yet' });
  facts.push({ label: 'PayPal status', value: r.status ?? 'Not reported', mono: true });
  facts.push({ label: 'Fetched from PayPal', value: r.lastFetchedAt ?? 'Not fetched yet' });
  if (divergence) facts.push({ label: 'Reconcile', value: divergence, tone: 'bad' });
  const ids = [r.orderId && { label: 'Order id', value: r.orderId }, r.captureId && { label: 'Capture id', value: r.captureId }, ...r.refunds.map((x) => ({ label: 'Refund id', value: x.id }))].filter(Boolean) as { label: string; value: string }[];
  return {
    key: 'paypal',
    kind: 'What PayPal processed',
    title: r.captureId ? 'Capture recorded in the PayPal Sandbox' : r.orderId ? 'Order recorded in the PayPal Sandbox' : 'Nothing sent to PayPal yet',
    source: 'paypal-sandbox',
    at: r.lastFetchedAt,
    ids,
    facts,
    items: r.refunds.map((x) => ({ title: `Refund ${money(x.amount)}`, meta: x.status, source: 'paypal-sandbox' as const })),
    events: [],
  };
}

function paymentNode(d: Dossier, p: PaymentIntent, events: MarketEvent[]): TraceNode {
  const mine = obligationsOf(d, p).filter(live);
  const sum = mine.reduce((s, o) => s + o.amount.minor, 0);
  const facts: Fact[] = [
    { label: 'Payee', value: name(d, p.payee) },
    { label: 'Agreed amount', value: money(p.amount) },
    { label: 'Sent to PayPal', value: money(p.charged) },
  ];
  if (p.fx) facts.push({ label: 'Conversion', value: `${p.fx.rate} (${p.fx.source}) at ${p.fx.at}` });
  facts.push({ label: 'Ledger state', value: p.state, mono: true });
  if (mine.length) {
    const ok = sum === p.amount.minor && mine.every((o) => o.amount.currency === p.amount.currency);
    const total = money({ currency: p.amount.currency, minor: sum });
    facts.push({ label: 'Matches obligations', value: ok ? `Yes, ${total}` : `No, obligations sum to ${total}`, tone: ok ? 'ok' : 'bad' });
  }
  const evs = events.filter((e) => e.type === 'payment.state' && (e.data as { payment?: Id } | null)?.payment === p.id);
  const approval = events.find((e) => e.type === 'payment.state' && (e.data as { approval?: string } | null)?.approval === 'issued');
  return {
    key: 'payment',
    kind: 'Payment intent',
    title: `${money(p.amount)} to ${name(d, p.payee)}`,
    source: 'solver',
    at: approval?.at ?? evs[0]?.at,
    ids: [
      { label: 'Payment id', value: p.id },
      { label: 'Operation key', value: p.operationKey },
    ],
    facts,
    items: [],
    events: [...(approval ? [approval.id] : []), ...evs.map((e) => e.id)],
  };
}

function obligationItem(d: Dossier, o: Obligation): TraceItem {
  return {
    title: `${name(d, o.actor)}, ${o.qty} ${d.world.stages.find((s) => s.id === o.stage)?.unit ?? 'units'}`,
    meta: `${o.state}${o.replaces ? `, replaces ${o.replaces}` : ''}`,
    facts: [
      { label: 'Obligation id', value: o.id, copy: true, mono: true },
      { label: 'Amount', value: money(o.amount) },
      { label: 'Due', value: o.due },
    ],
    follow: o.id,
    tone: o.state === 'AT_RISK' || o.state === 'BREACHED' ? 'broken' : o.replaces ? 'new' : undefined,
  };
}

function obligationsNode(d: Dossier, list: Obligation[], title: string): TraceNode {
  return { key: 'obligations', kind: 'Obligations', title, source: 'solver', at: list[0]?.start, ids: [], facts: [], items: list.map((o) => obligationItem(d, o)), events: [] };
}

function agreementNodes(d: Dossier, a: Agreement, events: MarketEvent[]): TraceNode[] {
  const ev = typed<{ agreement?: Id }>(events, 'agreement.state').filter((x) => x.data.agreement === a.id);
  return [
    {
      key: 'agreement',
      kind: 'Agreement',
      title: `Agreement v${a.version}, ${a.state.toLowerCase().replace(/_/g, ' ')}`,
      source: 'solver',
      at: a.createdAt,
      ids: [
        { label: 'Agreement id', value: a.id },
        { label: 'Terms hash', value: a.termsHash },
      ],
      facts: [
        { label: 'Parties', value: a.parties.map((p) => name(d, p)).join(', ') },
        { label: 'Plan', value: a.plan, mono: true },
      ],
      items: [],
      events: ev.map((x) => x.e.id),
    },
    {
      key: 'acceptances',
      kind: 'Acceptances',
      title: `${a.acceptances.length} of ${a.parties.length} parties accepted`,
      source: 'solver',
      at: a.createdAt,
      ids: [],
      facts: [],
      items: a.acceptances.map((x) => ({
        title: name(d, x.actor),
        source: x.basis === 'synthetic-policy' ? ('supplier-policy' as const) : x.basis === 'seller-terminal' ? ('seller-terminal' as const) : ('buyer' as const),
        facts: [
          { label: 'Message', value: x.message, copy: true, mono: true },
          { label: 'Signed the agreement hash', value: x.termsHash === a.termsHash ? 'Yes' : `No, signed ${shortHash(x.termsHash)}`, tone: x.termsHash === a.termsHash ? ('ok' as const) : ('bad' as const) },
        ],
      })),
      events: [],
    },
  ];
}

function negotiationNode(d: Dossier, a: Agreement | null, events: MarketEvent[]): { node: TraceNode; headline?: Headline } {
  const derived = derivedConcessions(d, planOf(d, a));
  const all = concessionsIn(events);
  const msgs = typed<NegotiationMessage>(events, 'negotiation.message');
  const decisions = typed<SupplierDecision>(events, 'negotiation.decision');
  const carries = (m: NegotiationMessage): Id | undefined => (m.type === 'Propose' || m.type === 'CounterOffer' ? m.concession.id : m.type === 'AskPreference' ? m.question.id : undefined);
  const items: TraceItem[] = [];
  const changes: Headline['changes'] = [];
  for (const cid of derived) {
    const c = all.get(cid);
    const sentence = c ? concessionSentence(c, d.world) : `Accepted change ${cid}`;
    const related = msgs.filter(({ data: m }) => carries(m) === cid);
    const relatedIds = new Set(related.map((x) => x.data.id));
    const replies = msgs.filter(({ data: m }) => (m.type === 'Accept' || m.type === 'Reject' || m.type === 'CounterOffer') && relatedIds.has(m.replyTo) && carries(m) !== cid);
    const rows = [...related, ...replies].sort((x, y) => x.e.seq - y.e.seq);
    const decs = decisions.filter((x) => rows.some((r) => r.data.id === x.data.message));
    items.push({
      title: sentence,
      
      tone: 'new',
      source: 'solver',
      facts: [
        { label: 'Change id', value: cid, copy: true, mono: true },
        ...(c ? [{ label: 'Estimated cost to the supplier', value: money(c.estimate), estimate: true } as Fact] : []),
        ...rows.map(({ e, data: m }) => ({ label: m.type, value: `${name(d, 'from' in m ? m.from : undefined)} to ${name(d, 'to' in m ? m.to : undefined)} (${m.id}) at ${e.at}`, mono: true })),
        ...decs.map(({ data: x }) => ({ label: 'Supplier decision', value: `${x.accept ? 'Accepted' : 'Declined'} by ${x.basis === 'seller-terminal' ? 'seller terminal' : 'supplier policy'}: ${x.reason}`, tone: x.accept ? ('ok' as const) : undefined })),
      ],
    });
    changes.push({ id: cid, text: sentence, estimate: c ? money(c.estimate) : undefined });
  }
  const node: TraceNode = {
    key: 'changes',
    kind: 'Accepted changes',
    title: derived.length ? `${derived.length} accepted ${derived.length === 1 ? 'change' : 'changes'} behind the plan` : 'The plan uses published offers only',
    source: 'solver',
    at: msgs[0]?.e.at,
    ids: [],
    facts: [],
    items,
    tone: derived.length ? 'new' : undefined,
    events: [...msgs.map((x) => x.e.id), ...decisions.map((x) => x.e.id)],
  };
  return {
    node,
    headline: derived.length
      ? { title: 'What made this deal possible', changes, caveat: 'These are the accepted changes the plan relies on. Whether any one was strictly necessary is established only by solving again without it.' }
      : undefined,
  };
}

type SolveData = { status?: string; plan?: Id | null; solver?: SolveReport['solver']; core?: SolveReport['core'] | string[] | null; verification?: { ok: boolean; checks: { ok: boolean }[] } };

function reportItem(label: string, e: MarketEvent, data: SolveData, plan?: Plan): TraceItem {
  const core = data.core && !Array.isArray(data.core) ? data.core : undefined;
  const coreIds = Array.isArray(data.core) ? data.core : core?.constraints.map((c) => c.id);
  const facts: Fact[] = [{ label: 'Status', value: data.status ?? 'unknown', mono: true }];
  if (data.solver) facts.push({ label: 'Solver', value: `${data.solver.name} ${data.solver.version}, ${data.solver.ms} ms${data.solver.gap !== undefined ? `, gap ${data.solver.gap}` : ''}` });
  if (core) {
    facts.push({ label: 'Blocking core', value: core.summary });
    facts.push({ label: 'Core is', value: `${core.proven ? 'proven infeasible' : 'not proven'}${core.minimal ? ', minimal by deletion filter' : ''}` });
  }
  if (coreIds?.length) facts.push({ label: 'Blocking constraints', value: coreIds.join(', '), mono: true });
  if (plan) {
    facts.push({ label: 'Objective', value: plan.objective });
    facts.push({ label: 'Plan total', value: money(plan.total) });
    facts.push({ label: 'Plan id', value: plan.id, copy: true, mono: true });
  }
  return { title: label, meta: data.status, source: 'solver', at: e.at, facts };
}

function solverNode(d: Dossier, a: Agreement | null, events: MarketEvent[]): TraceNode | undefined {
  const plan = planOf(d, a);
  const solves = typed<SolveData>(events, 'solve.completed');
  const reports = solves.filter((x) => x.data.status);
  const after = (plan && reports.find((x) => x.data.plan === plan.id)) || (plan ? reports.filter((x) => x.data.status !== 'infeasible').at(-1) : undefined);
  const before = reports.filter((x) => x.data.status === 'infeasible' && (!after || x.e.seq < after.e.seq)).at(-1);
  const check = plan ? solves.find((x) => x.data.verification && x.data.plan === plan.id) : undefined;
  const items: TraceItem[] = [];
  if (before) items.push(reportItem('Before the accepted changes', before.e, before.data));
  if (after) items.push(reportItem('After the accepted changes', after.e, after.data, plan));
  else if (plan) {
    items.push({
      title: 'Plan on record',
      source: 'solver',
      facts: [
        { label: 'Plan id', value: plan.id, copy: true, mono: true },
        { label: 'Objective', value: plan.objective },
        { label: 'Plan total', value: money(plan.total) },
      ],
    });
  }
  if (check?.data.verification) {
    const v = check.data.verification;
    items.push({ title: 'Independent re-check', meta: v.ok ? 'passed' : 'failed', source: 'solver', at: check.e.at, facts: [{ label: 'Checks passed', value: `${v.checks.filter((c) => c.ok).length} of ${v.checks.length}`, tone: v.ok ? 'ok' : 'bad' }] });
  }
  if (!items.length) return undefined;
  return {
    key: 'solver',
    kind: 'Solver reports',
    title: before && after ? 'Infeasible before, a plan after' : 'Solver result',
    source: 'solver',
    at: (after ?? before)?.e.at,
    ids: [],
    facts: [],
    items,
    events: [before?.e.id, after?.e.id, check?.e.id].filter(Boolean) as Id[],
  };
}

function objectiveNode(d: Dossier, events: MarketEvent[]): TraceNode {
  const i = d.intent;
  const compiled = typed<{ live?: boolean; model?: string }>(events, 'intent.compiled').at(-1);
  return {
    key: 'objective',
    kind: 'Original objective',
    title: i.text,
    source: i.provenance.source,
    at: i.provenance.observedAt,
    ids: [{ label: 'Intent id', value: i.id }],
    facts: [
      { label: 'Quantity', value: String(i.quantity) },
      { label: 'Budget cap', value: money(i.budget) },
      { label: 'Deadline', value: i.deadline },
      ...(compiled?.data.live ? [{ label: 'Read by', value: `${compiled.data.model ?? 'a model'}, then validated` }] : []),
    ],
    items: [],
    events: compiled ? [compiled.e.id] : [],
  };
}

function backward(d: Dossier, events: MarketEvent[], p?: PaymentIntent, obligation?: Obligation): { nodes: TraceNode[]; headline?: Headline } {
  const nodes: TraceNode[] = [];
  if (p) nodes.push(paypalNode(p), paymentNode(d, p, events), obligationsNode(d, obligationsOf(d, p), 'Obligations this payment settles'));
  else if (obligation) nodes.push(obligationsNode(d, [obligation], 'The obligation'));
  if (d.agreement) nodes.push(...agreementNodes(d, d.agreement, events));
  const neg = negotiationNode(d, d.agreement, events);
  nodes.push(neg.node);
  const solver = solverNode(d, d.agreement, events);
  if (solver) nodes.push(solver);
  nodes.push(objectiveNode(d, events));
  return { nodes, headline: neg.headline };
}

function disruptionNode(d: Dossier, x: Disruption, e: MarketEvent | undefined): TraceNode {
  return {
    key: `disruption:${x.id}`,
    kind: 'Disruption',
    title: x.detail || x.kind,
    source: e?.source ?? 'synthetic-market',
    at: x.at,
    ids: [{ label: 'Disruption id', value: x.id }],
    facts: [{ label: 'Kind', value: x.kind, mono: true }, ...(x.actor ? [{ label: 'Supplier', value: name(d, x.actor) }] : [])],
    items: [],
    tone: 'broken',
    events: e ? [e.id] : [],
  };
}

function forward(d: Dossier, seed: { offers: Id[]; actors: Id[]; obligations: Id[]; head: TraceNode }): TraceNode[] {
  const offers = new Set(seed.offers);
  const hit = (d.agreement?.obligations ?? []).filter((o) => seed.obligations.includes(o.id) || offers.has(o.offer) || seed.actors.includes(o.actor));
  const nodes: TraceNode[] = [seed.head];
  if (offers.size) {
    nodes.push({
      key: 'offers',
      kind: 'Offers that depend on it',
      title: `${offers.size} ${offers.size === 1 ? 'offer' : 'offers'}`,
      source: 'synthetic-market',
      ids: [],
      facts: [],
      items: [...offers].map((id) => {
        const o = d.world.offers.find((x) => x.id === id);
        return { title: o ? `${name(d, o.actor)}, ${d.world.stages.find((s) => s.id === o.stage)?.name ?? o.stage}` : id, facts: [{ label: 'Offer id', value: id, copy: true, mono: true }], follow: id };
      }),
      events: [],
    });
  }
  if (!hit.length) {
    nodes.push({ key: 'none', kind: 'Endangered obligations', title: d.agreement ? 'No committed obligation depends on it' : 'Nothing is committed yet', source: 'solver', ids: [], facts: [], items: [], events: [] });
    return nodes;
  }
  const open = hit.filter(live);
  nodes.push(obligationsNode(d, hit, `${open.length} endangered ${open.length === 1 ? 'obligation' : 'obligations'}`));
  const ids = new Set(hit.map((o) => o.id));
  const pays = d.payments.filter((p) => p.obligations.some((x) => ids.has(x)));
  nodes.push({
    key: 'payments',
    kind: 'Payments exposed',
    title: pays.length ? `${pays.length} ${pays.length === 1 ? 'payment involves' : 'payments involve'} these obligations` : 'No payment has been prepared for them',
    source: pays.length ? 'paypal-sandbox' : 'solver',
    at: pays[0]?.paypal.lastFetchedAt,
    ids: [],
    facts: [],
    items: pays.map((p) => ({
      title: `${money(p.amount)} to ${name(d, p.payee)}`,
      meta: p.paypal.status ? `PayPal Sandbox: ${p.paypal.status}` : `Ledger: ${p.state}`,
      source: 'paypal-sandbox' as const,
      at: p.paypal.lastFetchedAt,
      facts: [{ label: 'Payment id', value: p.id, copy: true, mono: true }, ...(p.paypal.captureId ? [{ label: 'Capture id', value: p.paypal.captureId, copy: true, mono: true }] : [])],
      follow: p.id,
    })),
    events: [],
  });
  const recs = d.recoveries.filter((r) => [...r.kept, ...r.amended, ...r.cancelled].some((x) => ids.has(x)));
  if (recs.length) {
    nodes.push({
      key: 'recovery',
      kind: 'Recovery on record',
      title: `${recs.length} ${recs.length === 1 ? 'recovery' : 'recoveries'}`,
      source: 'solver',
      ids: [],
      facts: [],
      items: recs.map((r) => ({
        title: r.feasible ? `Feasible: ${r.kept.length} kept, ${r.cancelled.length} replaced` : 'No permissible recovery',
        meta: `extra ${money(r.extraCost)}`,
        source: 'solver' as const,
        facts: [{ label: 'Recovery id', value: r.id, copy: true, mono: true }, ...r.rejected.map((x) => ({ label: 'Rejected', value: `${x.description} ${x.reason}` }))],
        tone: 'new' as const,
      })),
      events: [],
    });
  }
  return nodes;
}

/** Build the evidence chain for one entity. Pure: same inputs, same trace. */
export function buildTrace(d: Dossier, events: MarketEvent[], entityId?: Id): Trace {
  const cands = candidates(d, events);
  const id = entityId ?? d.payments.at(-1)?.id ?? d.agreement?.id;
  if (!id) return { backward: [], forward: [], candidates: cands, notFound: Boolean(entityId) };
  const sorted = [...events].sort((x, y) => x.seq - y.seq);
  const ent = resolve(d, sorted, id);
  if (!ent) return { backward: [], forward: [], candidates: cands, notFound: true };

  if (ent.kind === 'payment') {
    const b = backward(d, sorted, d.payments.find((x) => x.id === ent.id));
    return { entity: ent, headline: b.headline, backward: b.nodes, forward: [], candidates: cands };
  }
  if (ent.kind === 'agreement' || ent.kind === 'obligation') {
    const b = backward(d, sorted, undefined, d.agreement?.obligations.find((x) => x.id === ent.id));
    const scope = ent.kind === 'obligation' ? [ent.id] : (d.agreement?.obligations ?? []).map((x) => x.id);
    const pays = d.payments.filter((p) => p.obligations.some((x) => scope.includes(x)));
    const fwd: TraceNode[] = pays.length
      ? [
          {
            key: 'payments',
            kind: 'Payments that settle it',
            title: `${pays.length} ${pays.length === 1 ? 'payment' : 'payments'}`,
            source: 'paypal-sandbox',
            ids: [],
            facts: [],
            events: [],
            items: pays.map((p) => ({ title: `${money(p.amount)} to ${name(d, p.payee)}`, meta: p.paypal.status ? `PayPal Sandbox: ${p.paypal.status}` : `Ledger: ${p.state}`, source: 'paypal-sandbox' as const, at: p.paypal.lastFetchedAt, follow: p.id })),
          },
        ]
      : [];
    return { entity: ent, headline: b.headline, backward: b.nodes, forward: fwd, candidates: cands };
  }
  if (ent.kind === 'disruption') {
    const hit = typed<unknown>(sorted, 'disruption.applied')
      .map((x) => ({ e: x.e, x: disruptionOf(x.e) }))
      .find((y) => y.x?.id === ent.id);
    if (hit?.x) {
      const offers = hit.x.offer ? [hit.x.offer] : [];
      const affected = ((hit.e.data as { affected?: Id[] } | null)?.affected ?? []) as Id[];
      return { entity: ent, backward: [], forward: forward(d, { offers, actors: !offers.length && hit.x.actor ? [hit.x.actor] : [], obligations: affected, head: disruptionNode(d, hit.x, hit.e) }), candidates: cands };
    }
  }
  if (ent.kind === 'actor') {
    const a = d.world.actors.find((x) => x.id === ent.id)!;
    const head: TraceNode = {
      key: 'actor',
      kind: 'Supplier',
      title: a.name,
      source: 'synthetic-market',
      ids: [{ label: 'Actor id', value: a.id }],
      facts: [{ label: 'Status', value: a.active ? 'Active' : 'No longer active', tone: a.active ? 'ok' : 'bad' }, { label: 'City', value: a.city }],
      items: [],
      tone: a.active ? undefined : 'broken',
      events: [],
    };
    return { entity: ent, backward: [], forward: forward(d, { offers: [], actors: [a.id], obligations: [], head }), candidates: cands };
  }
  if (ent.kind === 'claim') {
    const c = d.world.claims.find((x) => x.id === ent.id)!;
    const finds = findingsFor(sorted, c.id);
    const offers = d.world.offers.filter((o) => o.claims.includes(c.id) || c.subject.endsWith(`:${o.id}`)).map((o) => o.id);
    const head: TraceNode = {
      key: 'claim',
      kind: 'Claim',
      title: `${name(d, c.actor)}: ${c.assertion}`,
      source: c.provenance.source,
      at: c.provenance.observedAt,
      ids: [{ label: 'Claim id', value: c.id }],
      facts: [
        { label: 'Evidence tier', value: c.tier, mono: true },
        ...(c.contradictedBy?.length ? [{ label: 'Contradicted by', value: c.contradictedBy.join(', '), mono: true, tone: 'bad' as const }] : []),
        ...finds.map((f) => ({ label: 'Finding', value: `${f.verdict}: ${f.text}`, tone: f.verdict === 'consistent' ? ('ok' as const) : ('bad' as const) })),
      ],
      items: [],
      tone: c.contradictedBy?.length || finds.some(isBad) ? 'broken' : undefined,
      events: [],
    };
    return { entity: ent, backward: [], forward: forward(d, { offers, actors: [], obligations: [], head }), candidates: cands };
  }
  if (ent.kind === 'offer') {
    const o = d.world.offers.find((x) => x.id === ent.id)!;
    const head: TraceNode = {
      key: 'offer',
      kind: 'Offer',
      title: `${name(d, o.actor)}, ${d.world.stages.find((s) => s.id === o.stage)?.name ?? o.stage}`,
      source: o.provenance.source,
      at: o.provenance.observedAt,
      ids: [{ label: 'Offer id', value: o.id }],
      facts: [{ label: 'Version', value: String(o.version) }, { label: 'Claimed capacity', value: String(o.capacity) }, ...(o.derivedFrom ? [{ label: 'Derived from', value: o.derivedFrom.concessions.join(', '), mono: true }] : [])],
      items: [],
      tone: o.derivedFrom ? 'new' : undefined,
      events: [],
    };
    return { entity: ent, backward: [], forward: forward(d, { offers: [o.id], actors: [], obligations: [], head }), candidates: cands };
  }
  return { entity: ent, backward: [], forward: [], candidates: cands, notFound: true };
}
