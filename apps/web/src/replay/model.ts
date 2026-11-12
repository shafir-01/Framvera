import type {
  Claim,
  ClaimFinding,
  Disruption,
  Id,
  Iso,
  MarketEvent,
  Money,
  ObligationState,
  Offer,
  PaymentState,
  Recovery,
  World,
} from '@framvera/contracts';

export type Chapter = 'Impossible' | 'Invention' | 'Agreement' | 'Payment' | 'Disruption' | 'Recovery';

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const words = (s: string | undefined) => (s ?? '').toLowerCase().replaceAll('_', ' ');

export function orderEvents(events: MarketEvent[]): MarketEvent[] {
  const seen = new Set<Id>();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.seq - b.seq);
}

/** Chapter of every event, decided from event types and what came before. */
export function chapterOf(events: MarketEvent[]): Chapter[] {
  const out: Chapter[] = [];
  let invented = false;
  let disrupted = false;
  let current: Chapter = 'Impossible';
  for (const e of events) {
    const d = rec(e.data);
    switch (e.type) {
      case 'world.created':
      case 'intent.compiled':
        current = invented ? current : 'Impossible';
        break;
      case 'solve.completed':
        if (!invented && str(d.status) !== 'infeasible' && !d.core && (d.verification || d.plan)) invented = true;
        current = invented ? (disrupted ? 'Recovery' : 'Invention') : 'Impossible';
        break;
      case 'intervention.found':
      case 'claim.challenged':
      case 'negotiation.message':
      case 'negotiation.decision':
      case 'offer.derived':
        invented = true;
        current = disrupted ? 'Recovery' : 'Invention';
        break;
      case 'agreement.state':
      case 'obligation.state':
        current = disrupted ? 'Recovery' : 'Agreement';
        break;
      case 'payment.state':
      case 'paypal.webhook':
        current = 'Payment';
        break;
      case 'disruption.applied':
        disrupted = true;
        current = 'Disruption';
        break;
      case 'recovery.proposed':
      case 'recovery.committed':
        disrupted = true;
        current = 'Recovery';
        break;
    }
    out.push(current);
  }
  return out;
}

export interface ChapterSpan {
  chapter: Chapter;
  from: number;
  to: number;
}

export function spans(chapters: Chapter[]): ChapterSpan[] {
  const out: ChapterSpan[] = [];
  chapters.forEach((c, i) => {
    const last = out[out.length - 1];
    if (last && last.chapter === c) last.to = i;
    else out.push({ chapter: c, from: i, to: i });
  });
  return out;
}

export interface KnownOffer {
  offer: Offer;
  derived: boolean;
}

export interface ObligationRow {
  id: Id;
  actor?: Id;
  state: ObligationState;
  changedAt: Iso;
}

export interface PaymentRow {
  id: Id;
  state?: PaymentState;
  /** PayPal's own status string as recorded in the log. */
  paypalStatus?: string | null;
  approved: boolean;
  at: Iso;
}

export interface Snapshot {
  index: number;
  event?: MarketEvent;
  offers: KnownOffer[];
  claims: Claim[];
  findings: ClaimFinding[];
  solve?: { status: string; summary?: string; verified?: boolean };
  obligations: ObligationRow[];
  agreement?: { state: string; id?: Id };
  payments: PaymentRow[];
  approvalIssued?: { payee?: Id; amount?: Money; at: Iso };
  disruption?: Disruption;
  recovery?: Recovery;
  recoveryReached: boolean;
}

/** Fold the log up to and including `index`. Nothing after the cursor is visible. */
export function snapshotAt(events: MarketEvent[], world: World | undefined, index: number): Snapshot {
  const snap: Snapshot = { index, offers: [], claims: [], findings: [], obligations: [], payments: [], recoveryReached: false };
  const obligations = new Map<Id, ObligationRow>();
  const payments = new Map<Id, PaymentRow>();
  let opened = false;
  let derivedVisible = false;
  for (let i = 0; i <= index && i < events.length; i++) {
    const e = events[i]!;
    const d = rec(e.data);
    snap.event = e;
    switch (e.type) {
      case 'world.created':
        opened = true;
        break;
      case 'solve.completed':
        if (str(d.status)) snap.solve = { status: str(d.status)!, summary: str(rec(d.core).summary) };
        else if (d.verification) snap.solve = { status: 'feasible', verified: Boolean(rec(d.verification).ok) };
        break;
      case 'negotiation.decision':
        if (d.accept === true) derivedVisible = true;
        break;
      case 'offer.derived':
        derivedVisible = true;
        break;
      case 'claim.challenged':
        snap.findings.push(...(Array.isArray(d.findings) ? (d.findings as ClaimFinding[]) : []));
        break;
      case 'agreement.state':
        snap.agreement = { state: str(d.state) ?? 'DRAFT', id: str(d.agreement) };
        break;
      case 'obligation.state': {
        const id = str(d.obligation);
        if (id) obligations.set(id, { id, actor: e.actor, state: (str(d.state) as ObligationState) ?? 'PENDING', changedAt: e.at });
        break;
      }
      case 'payment.state': {
        const id = str(d.payment);
        if (id) {
          const prev = payments.get(id) ?? { id, approved: false, at: e.at };
          payments.set(id, {
            ...prev,
            state: (str(d.state) as PaymentState) ?? prev.state,
            paypalStatus: 'paypalStatus' in d ? ((d.paypalStatus as string | null) ?? null) : prev.paypalStatus,
            approved: prev.approved || d.approvedBy === 'buyer',
            at: e.at,
          });
        } else if (d.approval === 'issued') {
          snap.approvalIssued = { payee: str(d.payee), amount: d.amount as Money | undefined, at: e.at };
        }
        break;
      }
      case 'disruption.applied': {
        snap.disruption = (d.disruption ?? (d.kind ? d : undefined)) as Disruption | undefined;
        for (const id of Array.isArray(d.affected) ? (d.affected as Id[]) : []) {
          const o = obligations.get(id);
          if (o && o.state !== 'BREACHED') obligations.set(id, { ...o, state: 'AT_RISK', changedAt: e.at });
        }
        break;
      }
      case 'recovery.proposed':
      case 'recovery.committed':
        snap.recoveryReached = true;
        if (Array.isArray(d.rejected)) snap.recovery = e.data as Recovery;
        break;
    }
  }
  if (world && opened) {
    const shown = world.offers.filter((o) => !o.derivedFrom || derivedVisible);
    snap.offers = shown.map((offer) => ({ offer, derived: Boolean(offer.derivedFrom) }));
    snap.claims = world.claims;
  }
  snap.obligations = [...obligations.values()];
  snap.payments = [...payments.values()];
  return snap;
}

export interface Cause {
  id: Id;
  index: number;
  type: MarketEvent['type'];
  sentence: string;
}

export interface Reason {
  /** True when the log names the causes; false when only the log order is known. */
  recorded: boolean;
  causes: Cause[];
  prior?: Cause;
}

export function describe(e: MarketEvent, world?: World): string {
  const d = rec(e.data);
  const who = (id?: Id) => world?.actors.find((a) => a.id === id)?.name ?? id ?? 'A party';
  switch (e.type) {
    case 'world.created':
      return `Market opened with ${d.offers ?? 'its'} published offers`;
    case 'intent.compiled':
      return 'The request was written down';
    case 'solve.completed':
      if (str(d.status) === 'infeasible') return str(rec(d.core).summary) ?? 'No combination of published offers works';
      if (d.verification) return rec(d.verification).ok ? 'The new plan passed the independent check' : 'The new plan failed the independent check';
      return `Solver finished: ${str(d.status) ?? 'done'}`;
    case 'intervention.found':
      return 'A change that would make the order possible was found';
    case 'claim.challenged':
      return 'Supplier claims were checked against the record';
    case 'negotiation.message': {
      const t = str(d.type);
      return `${who(str(d.from))} sent ${t ? t.replace(/([A-Z])/g, ' $1').trim().toLowerCase() : 'a message'}`;
    }
    case 'negotiation.decision':
      return `${d.accept ? 'Accepted' : 'Declined'}: ${str(d.reason) ?? 'no reason given'}`;
    case 'offer.derived':
      return 'A new offer exists because of an accepted change';
    case 'agreement.state':
      return `Agreement is ${words(str(d.state))}`;
    case 'obligation.state':
      return `${who(e.actor)}: obligation ${words(str(d.state))}`;
    case 'payment.state':
      return d.approval === 'issued' ? 'Payment approval issued to the buyer' : `Payment ${words(str(d.state))}`;
    case 'paypal.webhook':
      return 'PayPal reported a change';
    case 'disruption.applied':
      return str(rec(d.disruption).detail) ?? 'A supplier could no longer deliver';
    case 'recovery.proposed':
      return 'A recovery plan was chosen';
    case 'recovery.committed':
      return 'The recovery plan was committed';
  }
}

export function reasonFor(events: MarketEvent[], index: number, world?: World): Reason | undefined {
  if (!events[index]) return undefined;
  const at = new Map(events.map((x, i) => [x.id, i] as const));
  const cause = (i: number): Cause => ({ id: events[i]!.id, index: i, type: events[i]!.type, sentence: describe(events[i]!, world) });
  const causes = events[index]!.causes.flatMap((id) => (at.has(id) ? [cause(at.get(id)!)] : []));
  return { recorded: causes.length > 0, causes, prior: index > 0 ? cause(index - 1) : undefined };
}

export interface RejectedSide {
  description: string;
  reason: string;
  extraCost?: Money;
  slipHours?: number;
}

export interface Branch {
  rejected: RejectedSide[];
  committed: { extraCost: Money; slipHours: number; kept: number; amended: number; cancelled: number; added: number; feasible: boolean };
  /** True only when a rejected plan's cost is recorded and lower than the committed one. */
  cheaperRejected: boolean;
}

export function branchOf(r: Recovery | undefined): Branch | undefined {
  if (!r || !r.rejected?.length) return undefined;
  const rejected: RejectedSide[] = r.rejected.map((x) => {
    const extra = x as RejectedSide;
    return { description: x.description, reason: x.reason, extraCost: extra.extraCost, slipHours: extra.slipHours };
  });
  return {
    rejected,
    committed: {
      extraCost: r.extraCost,
      slipHours: r.slipHours,
      kept: r.kept.length,
      amended: r.amended.length,
      cancelled: r.cancelled.length,
      added: r.added.length,
      feasible: r.feasible,
    },
    cheaperRejected: rejected.some((x) => x.extraCost && x.extraCost.currency === r.extraCost.currency && x.extraCost.minor < r.extraCost.minor),
  };
}
