import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Agreement, EventType, Intent, MarketEvent, PaymentIntent, Plan, Source, World } from '@framvera/contracts';
import type { Engine, Template } from './engine.ts';
import { CausalIndex } from './causal.ts';

export interface Session {
  id: string;
  template?: Template;
  seed: number | null;
  family: string;
  world: World;
  intent: Intent;
  report?: unknown;
  interventions?: unknown;
  coalitions?: unknown;
  findings?: unknown;
  run?: unknown;
  decisions: unknown[];
  plans: Record<string, Plan>;
  verified: Record<string, boolean>;
  agreement?: Agreement;
  history?: Agreement[];
  payments: Record<string, PaymentIntent>;
  approvals: { spent: number; used: string[] };
  recoveries: unknown[];
  disruptions: unknown[];
  options?: unknown;
  mechanisms?: Record<string, unknown>;
}

interface LedgerLike {
  append(e: MarketEvent): unknown;
  events(market: string): MarketEvent[];
}

type Listener = (e: MarketEvent) => void;

/** Events record the value at emit time; later changes to the same object never rewrite history. */
const snapshot = <T>(v: T): T => {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v ?? null)) as T;
  }
};

/**
 * Market events live in process memory for streaming and tracing, and are appended to the durable ledger when one is
 * available. Causes are always earlier events of the same market; only causes the ledger already holds are sent to it.
 */
export class Store {
  ledger: LedgerLike | null = null;
  durable = false;
  sessions = new Map<string, Session>();
  causal = new CausalIndex();
  private log = new Map<string, MarketEvent[]>();
  private persisted = new Set<string>();
  private listeners = new Map<string, Set<Listener>>();

  constructor(engine: Engine, dataDir: string | ':memory:') {
    if (engine.Ledger) {
      try {
        if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
        this.ledger = new engine.Ledger(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'framvera.sqlite')) as LedgerLike;
        this.durable = true;
      } catch {
        this.ledger = null;
      }
    }
  }

  events(market: string): MarketEvent[] {
    const mem = this.log.get(market);
    if (mem?.length) return [...mem];
    try {
      return this.ledger?.events(market) ?? [];
    } catch {
      return [];
    }
  }

  emit<T>(market: string, type: EventType, data: T, source: Source, opts: { actor?: string; causes?: string[] } = {}): MarketEvent<T> {
    let mem = this.log.get(market);
    if (!mem) {
      mem = this.events(market);
      for (const e of mem) this.persisted.add(e.id);
      this.log.set(market, mem);
    }
    data = snapshot(data);
    const known = new Set(mem.map((e) => e.id));
    const causes = (opts.causes ?? this.causal.causes(market, type, data)).filter((c) => known.has(c));
    const ev: MarketEvent<T> = {
      id: randomUUID(), seq: (mem.at(-1)?.seq ?? 0) + 1, market, at: new Date().toISOString(), type,
      ...(opts.actor ? { actor: opts.actor } : {}), data, causes, source,
    };
    if (this.ledger) {
      try {
        this.ledger.append({ ...ev, causes: causes.filter((c) => this.persisted.has(c)) } as MarketEvent);
        this.persisted.add(ev.id);
      } catch {
        /* the ledger refused this event; it still streams and traces from memory */
      }
    }
    mem.push(ev as MarketEvent);
    this.causal.register(market, type, data, ev.id);
    this.listeners.get(market)?.forEach((l) => l(ev as MarketEvent));
    return ev;
  }

  subscribe(market: string, l: Listener): () => void {
    const set = this.listeners.get(market) ?? new Set();
    set.add(l);
    this.listeners.set(market, set);
    return () => set.delete(l);
  }

  /** Persist the full session so a restart can rebuild it from the ledger. */
  save(s: Session) {
    this.sessions.set(s.id, s);
    try {
      this.ledger?.append({ id: randomUUID(), seq: 0, market: `session:${s.id}`, at: new Date().toISOString(), type: 'world.created', data: s, causes: [], source: 'solver' });
    } catch {
      /* in-memory only */
    }
  }

  load(id: string): Session | undefined {
    const hit = this.sessions.get(id);
    if (hit) return hit;
    let evs: MarketEvent[] = [];
    try {
      evs = this.ledger?.events(`session:${id}`) ?? [];
    } catch {
      evs = [];
    }
    const last = evs[evs.length - 1];
    if (!last) return undefined;
    const s = last.data as Session;
    this.sessions.set(id, s);
    return s;
  }
}
