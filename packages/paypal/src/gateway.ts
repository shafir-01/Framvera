import { createHash } from 'node:crypto';
import type { Id, Iso, Money, PayPalRecord, PaymentIntent } from '@framvera/contracts';

export type OrderIntent = 'CAPTURE' | 'AUTHORIZE';

/** One economic obligation billed as one PayPal item, quantity 1, exact amount. */
export interface OrderLine {
  obligation: Id;
  name: string;
  amount: Money;
}

export interface Payee {
  merchantId?: string;
  email?: string;
}

export interface CreateOrderOptions {
  intent?: OrderIntent;
  description?: string;
  lines?: OrderLine[];
  /** Only sent when it is a syntactically valid PayPal merchant id or email. */
  payee?: Payee;
  returnUrl?: string;
  cancelUrl?: string;
  brandName?: string;
  locale?: string;
}

export interface UnitResult {
  referenceId?: string;
  amount?: Money;
  payeeMerchantId?: string;
  captures: { id: string; status: string; reason?: string; amount?: Money; finalCapture?: boolean }[];
  authorizations: { id: string; status: string; amount?: Money; expiresAt?: Iso }[];
  refunds: { id: string; status: string; amount: Money }[];
}

/** PayPalRecord plus fields read verbatim from PayPal that the economic layer needs. */
export interface GatewayRecord extends PayPalRecord {
  intent?: OrderIntent;
  orderStatus?: string;
  captureStatus?: string;
  captureReason?: string;
  captured?: Money;
  authorizationId?: string;
  authorizationStatus?: string;
  authorizationExpiresAt?: Iso;
  payeeMerchantId?: string;
  units?: UnitResult[];
  /** PayPal error issue from the last mutating call, e.g. INSTRUMENT_DECLINED. */
  issue?: string;
  /** True when PayPal answered with the stored result of an earlier request with the same PayPal-Request-Id. */
  replayed?: boolean;
}

export interface CaptureView {
  id: string;
  status: string;
  reason?: string;
  amount: Money;
  finalCapture?: boolean;
  invoiceId?: string;
  customId?: string;
  debugIds: string[];
  fetchedAt: Iso;
}

export interface RefundView {
  id: string;
  status: string;
  amount: Money;
  invoiceId?: string;
  debugIds: string[];
  fetchedAt: Iso;
}

export interface WebhookVerification {
  verified: boolean;
  status: 'SUCCESS' | 'FAILURE' | 'NOT_CONFIGURED' | 'MISSING_HEADERS' | 'INVALID_BODY';
  eventId?: string;
  eventType?: string;
  resourceId?: string;
  debugIds: string[];
}

export interface RefundOptions {
  /** Distinguishes several refunds on one capture. Defaults to the number of refunds already recorded. */
  sequence?: number;
  note?: string;
}

/** Narrow server-side boundary for money movement. All mutating calls carry a PayPal-Request-Id derived from pi.operationKey. */
export interface PaymentsGateway {
  readonly kind: 'paypal-sandbox' | 'fake';
  createOrder(pi: PaymentIntent, opts?: CreateOrderOptions): Promise<GatewayRecord>;
  getOrder(orderId: string): Promise<GatewayRecord>;
  capture(pi: PaymentIntent): Promise<GatewayRecord>;
  authorize(pi: PaymentIntent): Promise<GatewayRecord>;
  captureAuthorization(pi: PaymentIntent): Promise<GatewayRecord>;
  voidAuthorization(pi: PaymentIntent): Promise<GatewayRecord>;
  refund(pi: PaymentIntent, amount?: Money, opts?: RefundOptions): Promise<GatewayRecord>;
  getCapture(captureId: string): Promise<CaptureView>;
  getRefund(refundId: string): Promise<RefundView>;
  verifyWebhook(headers: HeaderBag, rawBody: string): Promise<WebhookVerification>;
}

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export type Step = 'create' | 'capture' | 'authorize' | 'capture-authorization' | 'void' | `refund:${number}`;

/**
 * PayPal-Request-Id for one step of one payment operation.
 * Deterministic in (operationKey, step), so a retry after a crash or timeout reuses the same id,
 * and distinct per step, because PayPal scopes idempotency per call type and each partial refund
 * needs its own key. UUID-shaped to stay inside PayPal's 38 character guidance.
 */
export function requestIdFor(operationKey: string, step: Step): string {
  if (!operationKey) throw new Error('operationKey is required for every mutating PayPal call.');
  const h = createHash('sha256').update(`${operationKey}\u0000${step}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export function emptyRecord(): GatewayRecord {
  return { env: 'sandbox', refunds: [], debugIds: [] };
}

/** Merges a fresh PayPal view into what is already known, keeping every debug id and refund. */
export function mergeRecord(prev: PayPalRecord, next: Partial<GatewayRecord>): GatewayRecord {
  const refunds = [...prev.refunds];
  for (const r of next.refunds ?? []) {
    const i = refunds.findIndex((x) => x.id === r.id);
    if (i >= 0) refunds[i] = r;
    else refunds.push(r);
  }
  const debugIds = [...new Set([...prev.debugIds, ...(next.debugIds ?? [])])];
  const merged: GatewayRecord = { ...(prev as GatewayRecord), ...stripUndefined(next), refunds, debugIds };
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
