import type { Agreement, Disruption, EventType, Id, Iso, MarketEvent, Obligation, PaymentIntent, Recovery, Source } from '@framvera/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { canAgreement, canObligation, LIVE_OBLIGATION } from './agreement.ts';
import { ObligationError, canonical, clone, sha256 } from './util.ts';

type SqliteModule = typeof import('node:sqlite');

/** Loads node:sqlite while keeping its experimental notice out of the output. */
function loadSqlite(): SqliteModule {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning.message;
    const first = rest[0];
    const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
    if ((type === 'ExperimentalWarning' || (warning as Error).name === 'ExperimentalWarning') && /sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

let sqlite: SqliteModule | null = null;

export interface AgreementEventData {
  agreement: Agreement;
}
export interface ObligationEventData {
  obligation: Obligation;
  reason?: string;
}
export interface PaymentEventData {
  payment: PaymentIntent;
  event?: string;
}
export interface DisruptionEventData {
  disruption: Disruption;
  affected: Id[];
  atRisk?: Id[];
}
export interface RecoveryEventData {
  recovery: Recovery;
}

export interface LedgerState {
  market: Id;
  seq: number;
  head: string;
  agreements: Record<Id, Agreement>;
  history: Record<Id, Agreement[]>;
  obligations: Record<Id, Obligation>;
  payments: Record<Id, PaymentIntent>;
  reservations: Record<Id, number>;
  disruptions: Disruption[];
  recoveries: { recovery: Recovery; committed: boolean }[];
  counts: Partial<Record<EventType, number>>;
}

export type EventInput<T = unknown> = Omit<MarketEvent<T>, 'seq' | 'causes' | 'at' | 'source'> & {
  causes?: Id[];
  at?: Iso;
  source?: Source;
};

export const emptyState = (market: Id): LedgerState => ({
  market,
  seq: 0,
  head: '',
  agreements: {},
  history: {},
  obligations: {},
  payments: {},
  reservations: {},
  disruptions: [],
  recoveries: [],
  counts: {},
});

/** Pure fold of one event into the replay state. Unknown event types only advance the sequence. */
export function reduce(state: LedgerState, e: MarketEvent, hash = state.head): LedgerState {
  const s: LedgerState = { ...state, seq: e.seq, head: hash, counts: { ...state.counts, [e.type]: (state.counts[e.type] ?? 0) + 1 } };
  switch (e.type) {
    case 'agreement.state': {
      const a = (e.data as AgreementEventData).agreement;
      const latest = s.agreements[a.id];
      if (!latest || a.version >= latest.version) s.agreements = { ...s.agreements, [a.id]: a };
      const prior = (s.history[a.id] ?? []).filter((x) => x.version !== a.version);
      s.history = { ...s.history, [a.id]: [...prior, a].sort((x, y) => x.version - y.version) };
      const obligations = { ...s.obligations };
      for (const o of a.obligations) {
        const known = obligations[o.id];
        if (!known || (known.state === 'PENDING' && o.state === 'ACTIVE')) obligations[o.id] = o;
      }
      s.obligations = obligations;
      break;
    }
    case 'obligation.state': {
      const o = (e.data as ObligationEventData).obligation;
      s.obligations = { ...s.obligations, [o.id]: o };
      break;
    }
    case 'payment.state': {
      const p = (e.data as PaymentEventData).payment;
      s.payments = { ...s.payments, [p.id]: p };
      break;
    }
    case 'disruption.applied':
      s.disruptions = [...s.disruptions, (e.data as DisruptionEventData).disruption];
      break;
    case 'recovery.proposed':
      s.recoveries = [...s.recoveries, { recovery: (e.data as RecoveryEventData).recovery, committed: false }];
      break;
    case 'recovery.committed': {
      const r = (e.data as RecoveryEventData).recovery;
      s.recoveries = [...s.recoveries.filter((x) => x.recovery.id !== r.id), { recovery: r, committed: true }];
      break;
    }
    default:
      return s;
  }
  s.reservations = reservationsOf(s);
  return s;
}

function reservationsOf(s: LedgerState): Record<Id, number> {
  const out: Record<Id, number> = {};
  const binding = new Set(Object.values(s.agreements).filter((a) => ['ACCEPTED_BY_PARTIES', 'COMMITTED', 'FULFILLING'].includes(a.state)).map((a) => a.id));
  for (const a of Object.values(s.agreements)) {
    if (!binding.has(a.id)) continue;
    for (const ref of a.obligations) {
      const o = s.obligations[ref.id] ?? ref;
      if (LIVE_OBLIGATION.includes(o.state)) out[o.offer] = (out[o.offer] ?? 0) + o.qty;
    }
  }
  return out;
}

interface Row {
  id: string;
  market: string;
  seq: number;
  at: string;
  type: string;
  actor: string | null;
  data: string;
  causes: string;
  source: string;
  hash: string;
}

const fromRow = (r: Row): MarketEvent => ({
  id: r.id,
  seq: Number(r.seq),
  market: r.market,
  at: r.at,
  type: r.type as EventType,
  ...(r.actor ? { actor: r.actor } : {}),
  data: JSON.parse(r.data),
  causes: JSON.parse(r.causes),
  source: r.source as Source,
});

const content = (e: { market: Id; type: string; actor?: Id; data: unknown; causes: Id[]; source: string }) =>
  canonical({ market: e.market, type: e.type, actor: e.actor ?? null, data: e.data, causes: e.causes, source: e.source });

/**
 * Append-only market ledger on node:sqlite. One writer per database (BEGIN IMMEDIATE), WAL journal, per-market
 * sequence numbers, idempotent append by event id, causes that must already exist, a hash chain per market,
 * and snapshots that speed up replay to any sequence number.
 */
export class Ledger {
  private db: DatabaseSync;
  private heads = new Map<Id, LedgerState>();
  readonly journal: string;

  constructor(path: string = ':memory:') {
    sqlite ??= loadSqlite();
    this.db = new sqlite.DatabaseSync(path);
    const mode = this.db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string };
    this.journal = mode.journal_mode;
    this.db.exec(`
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, market TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
        actor TEXT, data TEXT NOT NULL, causes TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL,
        UNIQUE(market, seq));
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TABLE IF NOT EXISTS snapshots (market TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (market, seq));
    `);
  }

  append<T>(input: EventInput<T>): MarketEvent<T> {
    const causes = input.causes ?? [];
    const source = input.source ?? 'solver';
    const draft = { market: input.market, type: input.type, actor: input.actor, data: input.data, causes, source };
    const existing = this.db.prepare('SELECT * FROM events WHERE id = ?').get(input.id) as Row | undefined;
    if (existing) {
      const prior = fromRow(existing);
      if (content(prior) !== content(draft)) throw new ObligationError('event-conflict', `Event ${input.id} already exists with different content.`);
      return prior as MarketEvent<T>;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of causes) {
        const hit = this.db.prepare('SELECT market FROM events WHERE id = ?').get(c) as { market: string } | undefined;
        if (!hit) throw new ObligationError('unknown-cause', `Cause ${c} is not in the ledger.`);
      }
      const head = this.state(input.market);
      const e: MarketEvent<T> = {
        id: input.id,
        seq: head.seq + 1,
        market: input.market,
        at: input.at ?? new Date().toISOString(),
        type: input.type,
        ...(input.actor ? { actor: input.actor } : {}),
        data: clone(input.data),
        causes: [...causes],
        source,
      };
      guard(head, e);
      const hash = sha256(head.head + content(draft) + e.seq + e.at);
      this.db
        .prepare('INSERT INTO events (id, market, seq, at, type, actor, data, causes, source, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e.id, e.market, e.seq, e.at, e.type, e.actor ?? null, JSON.stringify(e.data), JSON.stringify(e.causes), e.source, hash);
      this.db.exec('COMMIT');
      this.heads.set(e.market, reduce(head, e, hash));
      return e;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  events(market: Id, opts: { after?: number; upTo?: number } = {}): MarketEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE market = ? AND seq > ? AND seq <= ? ORDER BY seq')
      .all(market, opts.after ?? 0, opts.upTo ?? Number.MAX_SAFE_INTEGER) as unknown as Row[];
    return rows.map(fromRow);
  }

  event(id: Id): MarketEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  /** Current replay state at the head of a market. */
  state(market: Id): LedgerState {
    let s = this.heads.get(market);
    if (!s) {
      s = this.stateAt(market);
      this.heads.set(market, s);
    }
    return s;
  }

  /** Agreement, obligation and payment state as it was right after event `seq` (head when omitted). */
  stateAt(market: Id, seq?: number): LedgerState {
    const upTo = seq ?? Number.MAX_SAFE_INTEGER;
    const snap = this.db
      .prepare('SELECT seq, state FROM snapshots WHERE market = ? AND seq <= ? ORDER BY seq DESC LIMIT 1')
      .get(market, upTo) as { seq: number; state: string } | undefined;
    let s = snap ? (JSON.parse(snap.state) as LedgerState) : emptyState(market);
    const rows = this.db
      .prepare('SELECT * FROM events WHERE market = ? AND seq > ? AND seq <= ? ORDER BY seq')
      .all(market, s.seq, upTo) as unknown as Row[];
    for (const r of rows) s = reduce(s, fromRow(r), r.hash);
    return s;
  }

  /** Persists a snapshot of the head state for faster replay and returns it. */
  snapshot(market: Id): LedgerState {
    const s = this.state(market);
    if (s.seq > 0) this.db.prepare('INSERT OR IGNORE INTO snapshots (market, seq, state, at) VALUES (?, ?, ?, ?)').run(market, s.seq, JSON.stringify(s), new Date().toISOString());
    return s;
  }

  /** Recomputes the hash chain from the stored events. */
  verifyChain(market: Id): { ok: boolean; seq: number; head: string } {
    const rows = this.db.prepare('SELECT * FROM events WHERE market = ? ORDER BY seq').all(market) as unknown as Row[];
    let head = '';
    let expect = 1;
    for (const r of rows) {
      const e = fromRow(r);
      const h = sha256(head + content(e) + e.seq + e.at);
      if (h !== r.hash || e.seq !== expect) return { ok: false, seq: e.seq, head };
      head = h;
      expect++;
    }
    return { ok: true, seq: expect - 1, head };
  }

  /** A what-if branch from a sequence number. Its events live only in memory; the ledger is never touched. */
  branch(market: Id, atSeq?: number): Branch {
    return new Branch(this, market, this.stateAt(market, atSeq));
  }

  close(): void {
    this.db.close();
  }
}

export class Branch {
  private extra: MarketEvent[] = [];
  private s: LedgerState;
  constructor(
    private base: Ledger,
    readonly market: Id,
    from: LedgerState,
  ) {
    this.s = clone(from);
  }

  get forkedAt(): number {
    return this.s.seq - this.extra.length;
  }

  append<T>(input: EventInput<T>): MarketEvent<T> {
    if (input.market !== this.market) throw new ObligationError('branch-market', 'A branch only accepts events for its own market.');
    const known = (id: Id) => this.extra.some((x) => x.id === id) || (this.base.event(id)?.seq ?? Infinity) <= this.forkedAt;
    if (this.extra.some((x) => x.id === input.id) || this.base.event(input.id)) throw new ObligationError('event-conflict', `Event ${input.id} already exists.`);
    for (const c of input.causes ?? []) if (!known(c)) throw new ObligationError('unknown-cause', `Cause ${c} is not visible in this branch.`);
    const e: MarketEvent<T> = {
      id: input.id,
      seq: this.s.seq + 1,
      market: this.market,
      at: input.at ?? new Date().toISOString(),
      type: input.type,
      ...(input.actor ? { actor: input.actor } : {}),
      data: clone(input.data),
      causes: [...(input.causes ?? [])],
      source: input.source ?? 'solver',
    };
    guard(this.s, e);
    this.extra.push(e);
    this.s = reduce(this.s, e, sha256(`branch:${this.s.head}:${e.id}`));
    return e;
  }

  state(_market?: Id): LedgerState {
    return clone(this.s);
  }

  events(): MarketEvent[] {
    return [...this.base.events(this.market, { upTo: this.forkedAt }), ...this.extra.map(clone)];
  }
}

/** Storage-level rules: agreement terms are immutable per version, lifecycle moves are legal, money is conserved. */
function guard(s: LedgerState, e: MarketEvent): void {
  if (e.type === 'agreement.state') {
    const a = (e.data as AgreementEventData).agreement;
    const prior = s.history[a.id]?.find((x) => x.version === a.version);
    if (prior) {
      if (prior.termsHash !== a.termsHash) throw new ObligationError('immutable-terms', `Agreement ${a.id} v${a.version} terms are immutable; amend with a new version.`);
      if (prior.state !== a.state && !canAgreement(prior.state, a.state)) throw new ObligationError('agreement-transition', `Agreement ${a.id} cannot move from ${prior.state} to ${a.state}.`);
    } else {
      const latest = s.agreements[a.id];
      if (latest && a.version !== latest.version + 1) throw new ObligationError('version', `Agreement ${a.id} v${a.version} does not follow v${latest.version}.`);
    }
  }
  if (e.type === 'obligation.state') {
    const o = (e.data as ObligationEventData).obligation;
    const prior = s.obligations[o.id];
    if (prior) {
      const terms = (x: Obligation) => canonical({ ...x, state: undefined });
      if (terms(prior) !== terms(o)) throw new ObligationError('immutable-terms', `Obligation ${o.id} terms are immutable; replace it instead.`);
      if (prior.state !== o.state && !canObligation(prior.state, o.state)) throw new ObligationError('obligation-transition', `Obligation ${o.id} cannot move from ${prior.state} to ${o.state}.`);
    }
  }
  if (e.type === 'payment.state') {
    const p = (e.data as PaymentEventData).payment;
    const prior = s.payments[p.id];
    if (prior?.paypal.captureId && p.paypal.captureId !== prior.paypal.captureId) throw new ObligationError('duplicate-capture', `Payment ${p.id} already has capture ${prior.paypal.captureId}.`);
    const refunded = p.paypal.refunds.filter((r) => r.status.toUpperCase() === 'COMPLETED').reduce((sum, r) => sum + r.amount.minor, 0);
    if (refunded > 0 && (!p.paypal.captureId || refunded > p.charged.minor)) throw new ObligationError('refund-exceeds', `Payment ${p.id} refunds exceed its capture.`);
  }
}

/** Convenience writers with deterministic ids, so retries are idempotent. */
export const record = {
  agreement(l: Ledger | Branch, market: Id, agreement: Agreement, causes: Id[] = [], at?: Iso): MarketEvent {
    return l.append<AgreementEventData>({
      id: `agreement:${agreement.id}:v${agreement.version}:${agreement.state}:${agreement.acceptances.length}`,
      market,
      type: 'agreement.state',
      data: { agreement },
      causes,
      at,
      source: 'solver',
    });
  },
  obligation(l: Ledger | Branch, market: Id, obligation: Obligation, causes: Id[] = [], reason?: string, at?: Iso): MarketEvent {
    return l.append<ObligationEventData>({
      id: `obligation:${obligation.id}:${obligation.state}`,
      market,
      type: 'obligation.state',
      actor: obligation.actor,
      data: reason ? { obligation, reason } : { obligation },
      causes,
      at,
      source: 'solver',
    });
  },
  payment(l: Ledger | Branch, market: Id, payment: PaymentIntent, causes: Id[] = [], event?: string, at?: Iso): MarketEvent {
    const n = payment.paypal.refunds.length;
    return l.append<PaymentEventData>({
      id: `payment:${payment.id}:${payment.state}:${payment.paypal.captureId ?? '-'}:${n}`,
      market,
      type: 'payment.state',
      actor: payment.payee,
      data: event ? { payment, event } : { payment },
      causes,
      at,
      source: payment.paypal.lastFetchedAt ? 'paypal-sandbox' : 'solver',
    });
  },
  disruption(l: Ledger | Branch, market: Id, disruption: Disruption, affected: Id[], atRisk: Id[] = [], causes: Id[] = []): MarketEvent {
    return l.append<DisruptionEventData>({
      id: `disruption:${disruption.id}`,
      market,
      type: 'disruption.applied',
      actor: disruption.actor,
      data: { disruption, affected, atRisk },
      causes,
      at: disruption.at,
      source: 'synthetic-market',
    });
  },
  /** The disruption plus the resulting obligation states (failed, must-change and at-risk). */
  impact(l: Ledger | Branch, market: Id, d: Disruption, impact: { failed: Obligation[]; mustChange: Obligation[]; atRisk: Obligation[] }, causes: Id[] = []): MarketEvent[] {
    const ev = record.disruption(l, market, d, [...impact.failed, ...impact.mustChange].map((o) => o.id), impact.atRisk.map((o) => o.id), causes);
    const out = [ev];
    for (const o of [...impact.failed, ...impact.mustChange, ...impact.atRisk]) {
      const cur = l.state(market).obligations[o.id];
      if (cur && cur.state === o.state) continue;
      out.push(record.obligation(l, market, o, [ev.id], d.detail, d.at));
    }
    return out;
  },
  /** A committed recovery: new agreement version, superseded original, and obligation moves. */
  recoveryCommit(
    l: Ledger | Branch,
    market: Id,
    recovery: Recovery,
    done: { original: Agreement; amended: Agreement; obligations: Obligation[] },
    causes: Id[] = [],
  ): MarketEvent[] {
    const v2 = record.agreement(l, market, done.amended, causes);
    const v1 = record.agreement(l, market, done.original, [v2.id]);
    const moves = done.obligations.map((o) => record.obligation(l, market, o, [v2.id]));
    return [v2, v1, ...moves, record.recovery(l, market, recovery, true, [v2.id])];
  },
  recovery(l: Ledger | Branch, market: Id, full: Recovery, committed: boolean, causes: Id[] = []): MarketEvent {
    const { world: _w, amendment: _a, ...recovery } = full as Recovery & { world?: unknown; amendment?: unknown };
    return l.append<RecoveryEventData>({
      id: `recovery:${recovery.id}:${committed ? 'committed' : 'proposed'}`,
      market,
      type: committed ? 'recovery.committed' : 'recovery.proposed',
      data: { recovery },
      causes,
      source: 'solver',
    });
  },
};
