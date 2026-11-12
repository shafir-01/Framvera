import type { HeaderBag } from './gateway.ts';

export interface WebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

function header(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function extractWebhookHeaders(h: HeaderBag): WebhookHeaders | undefined {
  const out = {
    transmissionId: header(h, 'paypal-transmission-id'),
    transmissionTime: header(h, 'paypal-transmission-time'),
    transmissionSig: header(h, 'paypal-transmission-sig'),
    certUrl: header(h, 'paypal-cert-url'),
    authAlgo: header(h, 'paypal-auth-algo'),
  };
  return Object.values(out).every((v) => typeof v === 'string' && v.length > 0) ? (out as WebhookHeaders) : undefined;
}

/**
 * verify-webhook-signature request body. PayPal requires webhook_event exactly as received,
 * so the raw body is embedded verbatim instead of being parsed and re-serialised.
 */
export function verifyRequestBody(h: WebhookHeaders, webhookId: string, rawBody: string): string {
  const head = JSON.stringify({
    auth_algo: h.authAlgo,
    cert_url: h.certUrl,
    transmission_id: h.transmissionId,
    transmission_sig: h.transmissionSig,
    transmission_time: h.transmissionTime,
    webhook_id: webhookId,
  });
  return `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
}

export interface SeenStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string): void | Promise<void>;
}

/** Idempotent intake: PayPal redelivers until it gets a 2xx, so the same event id may arrive many times. */
export class WebhookInbox {
  private readonly store: SeenStore;
  constructor(store?: SeenStore) {
    const mem = new Set<string>();
    this.store = store ?? { has: (id) => mem.has(id), add: (id) => void mem.add(id) };
  }

  async accept(eventId: string | undefined): Promise<'new' | 'duplicate' | 'invalid'> {
    if (!eventId) return 'invalid';
    if (await this.store.has(eventId)) return 'duplicate';
    await this.store.add(eventId);
    return 'new';
  }
}

export interface WebhookHint {
  eventId?: string;
  eventType?: string;
  orderId?: string;
  captureId?: string;
  refundId?: string;
  authorizationId?: string;
}

/**
 * Which PayPal objects a verified event concerns. A hint only: the payment record is updated from a fresh
 * API retrieval (reconcile), so delayed, duplicate or out-of-order events cannot move money state backwards.
 */
export function webhookHint(event: any): WebhookHint {
  const type: string = event?.event_type ?? '';
  const r = event?.resource ?? {};
  const related = r.supplementary_data?.related_ids ?? {};
  const hint: WebhookHint = { eventId: event?.id, eventType: type };
  if (type.startsWith('CHECKOUT.ORDER.')) hint.orderId = r.id;
  else if (type.startsWith('PAYMENT.CAPTURE.')) {
    if (type === 'PAYMENT.CAPTURE.REFUNDED') {
      hint.refundId = r.id;
      hint.captureId = related.capture_id ?? captureFromLinks(r.links);
    } else hint.captureId = r.id;
    hint.orderId = related.order_id;
  } else if (type.startsWith('PAYMENT.AUTHORIZATION.')) {
    hint.authorizationId = r.id;
    hint.orderId = related.order_id;
  } else if (type.startsWith('PAYMENT.REFUND.')) hint.refundId = r.id;
  return hint;
}

function captureFromLinks(links: any): string | undefined {
  if (!Array.isArray(links)) return undefined;
  const up = links.find((l: any) => l.rel === 'up' && typeof l.href === 'string');
  return up ? /captures\/([A-Z0-9]+)/.exec(up.href)?.[1] : undefined;
}
