import type { Id, MarketEvent } from '@framvera/contracts';
import { planOf } from './chain.ts';
import type { Dossier, Trace, TraceNode } from './types.ts';

const SENSITIVE_KEY = /secret|token|authorization|password|passwd|email|approveurl|approval|signature|apikey|api_key|payer|cookie/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MASK = '[redacted]';

/** Deep copy with credentials, approval links, contact details and free supplier text removed. */
export function redact(value: unknown, key = ''): unknown {
  if (key === 'debugIds') return Array.isArray(value) ? value.map(() => MASK) : MASK;
  if (key === 'description') return '[omitted: untrusted supplier text]';
  if (SENSITIVE_KEY.test(key) && typeof value === 'string') return MASK;
  if (typeof value === 'string') return value.replace(BEARER, `Bearer ${MASK}`).replace(EMAIL, '[redacted-email]');
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

export interface AuditBundle {
  format: 'framvera.audit-bundle';
  version: 1;
  generatedAt: string;
  market: Id;
  entity?: { kind: string; id: Id };
  environment: { payments: 'PayPal Sandbox'; market: 'Synthetic market' };
  redactions: string[];
  objective: unknown;
  plan?: unknown;
  agreement?: unknown;
  payments: unknown[];
  chain: { direction: 'backward' | 'forward'; node: Omit<TraceNode, 'events'> & { eventIds: Id[] } }[];
  events: unknown[];
  offers: unknown[];
}

const strip = (n: TraceNode) => {
  const { events, ...rest } = n;
  return { ...rest, eventIds: events };
};

export function buildBundle(d: Dossier, trace: Trace, events: MarketEvent[], ledger: MarketEvent[], now = new Date().toISOString()): AuditBundle {
  const chain = [...trace.backward.map((node) => ({ direction: 'backward' as const, node: strip(node) })), ...trace.forward.map((node) => ({ direction: 'forward' as const, node: strip(node) }))];
  const wanted = new Set<Id>([...chain.flatMap((c) => c.node.eventIds), ...ledger.map((e) => e.id)]);
  const plan = planOf(d, d.agreement);
  const used = new Set(plan?.allocations.map((a) => a.offer) ?? []);
  const known = new Map(events.map((e) => [e.id, e]));
  for (const e of ledger) known.set(e.id, e);
  const picked = [...known.values()].filter((e) => wanted.has(e.id)).sort((a, b) => a.seq - b.seq);
  const bundle: AuditBundle = {
    format: 'framvera.audit-bundle',
    version: 1,
    generatedAt: now,
    market: d.id,
    entity: trace.entity ? { kind: trace.entity.kind, id: trace.entity.id } : undefined,
    environment: { payments: 'PayPal Sandbox', market: 'Synthetic market' },
    redactions: ['credentials and tokens', 'approval links', 'PayPal debug ids', 'contact details', 'free-text supplier descriptions'],
    objective: d.intent,
    plan,
    agreement: d.agreement,
    payments: d.payments,
    chain,
    events: picked,
    offers: d.world.offers.filter((o) => used.has(o.id)),
  };
  return redact(bundle) as AuditBundle;
}

export function bundleName(b: AuditBundle): string {
  return `framvera-audit-${b.market}-${b.entity?.id ?? 'market'}.json`.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function downloadBundle(b: AuditBundle): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = bundleName(b);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
