import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Agreement, EventType, Intent, MarketEvent, PaymentIntent, Plan, Source, World } from '@framvera/contracts';
import type { Engine } from './engine.ts';

export interface Session {
  id: string;
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
  payments: Record<string, PaymentIntent>;
  approvals: { spent: number; used: string[] };
  recoveries: unknown[];
  disruptions: unknown[];
}

interface LedgerLike {
  append(e: MarketEvent): unknown;
  events(market: string): MarketEvent[];
}

class MemoryLedger implements LedgerLike {
  private log = new Map<string, MarketEvent[]>();
  append(e: MarketEvent) {
    const l = this.log.get(e.market) ?? [];
    l.push(e);
    this.log.set(e.market, l);
    return e;
  }
  events(market: string) {
    return [...(this.log.get(market) ?? [])];
  }
}

type Listener = (e: MarketEvent) => void;

export class Store {
  ledger: LedgerLike;
  durable = false;
  sessions = new Map<string, Session>();
  private listeners = new Map<string, Set<Listener>>();
  private seqs = new Map<string, number>();

  constructor(engine: Engine, dataDir: string | ':memory:') {
    this.ledger = new MemoryLedger();
    if (engine.Ledger) {
      try {
        if (dataDir !== ':memory:') {
          mkdirSync(dataDir, { recursive: true });
        }
        this.ledger = new engine.Ledger(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'framvera.sqlite')) as LedgerLike;
        this.durable = true;
      } catch {
        this.ledger = new MemoryLedger();
      }
    }
  }

  events(market: string): MarketEvent[] {
    try {
      return this.ledger.events(market) ?? [];
    } catch {
      return [];
    }
  }

  emit<T>(market: string, type: EventType, data: T, source: Source, opts: { actor?: string; causes?: string[] } = {}): MarketEvent<T> {
    const seq = (this.seqs.get(market) ?? this.events(market).length) + 1;
    this.seqs.set(market, seq);
    const ev: MarketEvent<T> = { id: randomUUID(), seq, market, at: new Date().toISOString(), type, actor: opts.actor, data, causes: opts.causes ?? [], source };
    let stored: MarketEvent = ev as MarketEvent;
    try {
      const r = this.ledger.append(ev as MarketEvent);
      if (r && typeof r === 'object' && 'id' in (r as object)) stored = r as MarketEvent;
    } catch {
      /* ledger rejected the event shape; the in-process stream still carries it */
    }
    this.listeners.get(market)?.forEach((l) => l(stored));
    return stored as MarketEvent<T>;
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
      this.ledger.append({
        id: randomUUID(),
        seq: 0,
        market: `session:${s.id}`,
        at: new Date().toISOString(),
        type: 'world.created',
        data: s,
        causes: [],
        source: 'solver',
      });
    } catch {
      /* in-memory only */
    }
  }

  load(id: string): Session | undefined {
    const hit = this.sessions.get(id);
    if (hit) return hit;
    const evs = this.events(`session:${id}`);
    const last = evs[evs.length - 1];
    if (!last) return undefined;
    const s = last.data as Session;
    this.sessions.set(id, s);
    return s;
  }
}
