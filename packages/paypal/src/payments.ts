import { randomUUID } from 'node:crypto';
import type { Authority, Id, Money, PaymentIntent, PaymentState } from '@framvera/contracts';
import { checkCharge } from './body.ts';
import { PayPalApiError, PaymentInvariantError } from './errors.ts';
import { MoneyError, assertMinor, sameMoney } from './money.ts';
import { emptyRecord, mergeRecord, type CreateOrderOptions, type GatewayRecord, type PaymentsGateway, type RefundOptions } from './gateway.ts';

export function newPaymentIntent(input: {
  id?: Id;
  agreement: Id;
  obligations: Id[];
  payee: Id;
  amount: Money;
  charged?: Money;
  fx?: PaymentIntent['fx'];
  operationKey?: string;
}): PaymentIntent {
  return {
    id: input.id ?? `pay_${randomUUID()}`,
    operationKey: input.operationKey ?? randomUUID(),
    agreement: input.agreement,
    obligations: input.obligations,
    payee: input.payee,
    amount: input.amount,
    charged: input.charged ?? input.amount,
    fx: input.fx,
    state: 'PAYMENT_PROPOSED',
    paypal: emptyRecord(),
  };
}

export class AuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityError';
  }
}

/** Spending permission is checked in code from the buyer's recorded authority, never inferred from a proposal. */
export function assertMayPrepare(authority: Authority | undefined, pi: PaymentIntent): void {
  if (!authority?.mayPreparePayments) throw new AuthorityError('The buyer has not granted permission to prepare PayPal orders.');
  const cap = authority.maxSpend;
  const basis = cap.currency === pi.charged.currency ? pi.charged : pi.amount;
  if (basis.currency !== cap.currency) throw new AuthorityError(`Spending limit is in ${cap.currency}; payment is in ${basis.currency}.`);
  if (basis.minor > cap.minor) throw new AuthorityError(`Payment ${basis.minor} exceeds the buyer's limit of ${cap.minor} ${cap.currency}.`);
}

const rec = (pi: PaymentIntent) => pi.paypal as GatewayRecord;

/** Internal payment state from what PayPal reported. Refunds dominate captures, captures dominate the order. */
export function stateFromRecord(r: GatewayRecord): PaymentState {
  const last = r.refunds[r.refunds.length - 1];
  if (last) {
    if (last.status === 'COMPLETED') return 'REFUND_COMPLETED';
    if (last.status === 'PENDING') return 'REFUND_PENDING';
    return 'REFUND_DENIED';
  }
  if (r.captureStatus) {
    if (r.captureStatus === 'COMPLETED') return 'CAPTURE_COMPLETED';
    if (r.captureStatus === 'PENDING') return 'CAPTURE_PENDING';
    if (r.captureStatus === 'DECLINED' || r.captureStatus === 'FAILED') return 'CAPTURE_DENIED';
    if (r.captureStatus === 'REFUNDED' || r.captureStatus === 'PARTIALLY_REFUNDED') return 'REFUND_COMPLETED';
  }
  if (r.authorizationStatus === 'VOIDED' || r.orderStatus === 'VOIDED') return 'VOIDED';
  if (r.authorizationStatus === 'DENIED') return 'CAPTURE_DENIED';
  switch (r.orderStatus) {
    case 'CREATED':
    case 'PAYER_ACTION_REQUIRED':
      return r.approveUrl ? 'PAYER_ACTION_REQUIRED' : 'ORDER_CREATED';
    case 'APPROVED':
    case 'SAVED':
      return 'APPROVED';
    case 'COMPLETED':
      return r.authorizationId ? 'APPROVED' : 'CAPTURE_UNKNOWN';
    default:
      return r.orderId ? 'ORDER_CREATED' : 'PAYMENT_PROPOSED';
  }
}

function withRecord(pi: PaymentIntent, r: GatewayRecord, state?: PaymentState): PaymentIntent {
  return { ...pi, paypal: r, state: state ?? stateFromRecord(r) };
}

function withDebug(pi: PaymentIntent, e: unknown): PaymentIntent {
  const id = e instanceof PayPalApiError ? e.debugId : undefined;
  return id ? { ...pi, paypal: mergeRecord(pi.paypal, { debugIds: [id] }) } : pi;
}

const locks = new Map<string, Promise<unknown>>();

/** Serialises money operations per payment inside this process, so concurrent retries cannot race. */
export async function withPaymentLock<T>(paymentId: Id, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(paymentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(paymentId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(paymentId) === tail) locks.delete(paymentId);
  }
}

/**
 * Creates the PayPal order awaiting buyer approval. An unknown outcome is resolved by replaying the same
 * PayPal-Request-Id, which returns the order PayPal already created (Orders v2 has no lookup by invoice).
 */
export async function openOrder(
  pi: PaymentIntent,
  gw: PaymentsGateway,
  opts: CreateOrderOptions & { authority: Authority | undefined; attempts?: number },
): Promise<PaymentIntent> {
  assertMayPrepare(opts.authority, pi);
  checkCharge(pi);
  if (pi.paypal.orderId) return reconcile(pi, gw);
  return withPaymentLock(pi.id, async () => {
    const attempts = Math.max(1, opts.attempts ?? 2);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await gw.createOrder(pi, opts);
        return withRecord(pi, r);
      } catch (e) {
        last = e;
        pi = withDebug(pi, e);
        if (!(e instanceof PayPalApiError) || !(e.outcomeUnknown || e.kind === 'rate-limit')) throw e;
      }
    }
    throw last;
  });
}

const CAPTURABLE: ReadonlySet<PaymentState> = new Set(['ORDER_CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'CAPTURE_UNKNOWN']);

/**
 * Captures an approved order exactly once. A timeout or 5xx yields CAPTURE_UNKNOWN; the order is then
 * retrieved before any retry, and the retry reuses the same PayPal-Request-Id.
 */
export async function capturePayment(pi: PaymentIntent, gw: PaymentsGateway, opts: { attempts?: number } = {}): Promise<PaymentIntent> {
  return withPaymentLock(pi.id, async () => {
    if (!pi.paypal.orderId) throw new PaymentInvariantError('No PayPal order to capture.');
    if (!CAPTURABLE.has(pi.state)) throw new PaymentInvariantError(`Capture refused in state ${pi.state}.`);
    const attempts = Math.max(1, opts.attempts ?? 2);
    for (let i = 0; i < attempts; i++) {
      if (pi.state === 'CAPTURE_UNKNOWN') {
        pi = await reconcileUnlocked(pi, gw);
        if (pi.state !== 'APPROVED') return pi;
      }
      try {
        const r = await gw.capture(pi);
        const next = withRecord(pi, r);
        assertCapturedAmount(next);
        return next;
      } catch (e) {
        pi = withDebug(pi, e);
        if (!(e instanceof PayPalApiError)) throw e;
        if (e.outcomeUnknown) {
          pi = { ...pi, state: 'CAPTURE_UNKNOWN' };
          continue;
        }
        if (e.issue === 'INSTRUMENT_DECLINED' || e.issue === 'PAYMENT_DENIED' || e.issue === 'TRANSACTION_REFUSED') {
          return { ...pi, state: 'CAPTURE_DENIED', paypal: mergeRecord(pi.paypal, { issue: e.issue }) };
        }
        if (e.issue === 'ORDER_NOT_APPROVED' || e.issue === 'PAYER_ACTION_REQUIRED') {
          return { ...pi, state: 'PAYER_ACTION_REQUIRED', paypal: mergeRecord(pi.paypal, { issue: e.issue }) };
        }
        if (e.issue === 'ORDER_ALREADY_CAPTURED' || e.issue === 'DUPLICATE_REQUEST_ID') return reconcileUnlocked(pi, gw);
        throw e;
      }
    }
    if (pi.state !== 'CAPTURE_UNKNOWN') return pi;
    const after = await reconcileUnlocked(pi, gw);
    return after.state === 'APPROVED' ? { ...after, state: 'CAPTURE_UNKNOWN' } : after;
  });
}

function assertCapturedAmount(pi: PaymentIntent): void {
  const r = rec(pi);
  if (r.captured && !sameMoney(r.captured, pi.charged)) {
    throw new PaymentInvariantError(`PayPal captured ${r.captured.minor} ${r.captured.currency}, expected ${pi.charged.minor} ${pi.charged.currency}.`, pi);
  }
}

/** Amount still refundable: captured minus refunds that completed or may still complete. */
export function refundable(pi: PaymentIntent): Money {
  const r = rec(pi);
  const captured = r.captured ?? pi.charged;
  const committed = r.refunds.filter((x) => x.status === 'COMPLETED' || x.status === 'PENDING').reduce((s, x) => s + x.amount.minor, 0);
  return { currency: captured.currency, minor: Math.max(0, captured.minor - committed) };
}

const REFUNDABLE: ReadonlySet<PaymentState> = new Set(['CAPTURE_COMPLETED', 'REFUND_COMPLETED', 'REFUND_DENIED']);

/** Full refund when amount is omitted, otherwise partial. Bounds and currency are checked before PayPal is called. */
export async function refundPayment(
  pi: PaymentIntent,
  gw: PaymentsGateway,
  amount?: Money,
  opts: RefundOptions & { attempts?: number } = {},
): Promise<PaymentIntent> {
  return withPaymentLock(pi.id, async () => {
    if (pi.state === 'REFUND_UNKNOWN' || pi.state === 'REFUND_PENDING') pi = await reconcileUnlocked(pi, gw);
    if (!pi.paypal.captureId) throw new PaymentInvariantError('No PayPal capture to refund.');
    if (!REFUNDABLE.has(pi.state)) throw new PaymentInvariantError(`Refund refused in state ${pi.state}.`);
    const left = refundable(pi);
    if (amount) {
      assertMinor(amount, { positive: true });
      if (amount.currency !== left.currency) throw new MoneyError(`Refund currency ${amount.currency} does not match capture currency ${left.currency}.`);
      if (amount.minor > left.minor) throw new MoneyError(`Refund ${amount.minor} exceeds refundable ${left.minor} ${left.currency}.`);
    } else if (left.minor === 0) throw new MoneyError('Nothing left to refund.');
    const request = amount ?? left;
    const sequence = opts.sequence ?? pi.paypal.refunds.length;
    const attempts = Math.max(1, opts.attempts ?? 2);
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await gw.refund(pi, request, { ...opts, sequence });
        return withRecord(pi, r);
      } catch (e) {
        pi = withDebug(pi, e);
        if (!(e instanceof PayPalApiError)) throw e;
        if (e.outcomeUnknown) {
          const before = pi.paypal.refunds.length;
          pi = await reconcileUnlocked({ ...pi, state: 'REFUND_UNKNOWN' }, gw);
          if (pi.paypal.refunds.length > before) return pi;
          if (pi.state === 'REFUND_UNKNOWN') return pi;
          continue;
        }
        if (e.kind === 'unprocessable') return { ...pi, state: 'REFUND_DENIED', paypal: mergeRecord(pi.paypal, { issue: e.issue }) };
        throw e;
      }
    }
    return { ...pi, state: 'REFUND_UNKNOWN' };
  });
}

export async function authorizePayment(pi: PaymentIntent, gw: PaymentsGateway): Promise<PaymentIntent> {
  return withPaymentLock(pi.id, async () => {
    try {
      return withRecord(pi, await gw.authorize(pi));
    } catch (e) {
      pi = withDebug(pi, e);
      if (e instanceof PayPalApiError && e.outcomeUnknown) return reconcileUnlocked({ ...pi, state: 'CAPTURE_UNKNOWN' }, gw);
      throw e;
    }
  });
}

export async function captureAuthorizedPayment(pi: PaymentIntent, gw: PaymentsGateway): Promise<PaymentIntent> {
  return withPaymentLock(pi.id, async () => {
    try {
      const next = withRecord(pi, await gw.captureAuthorization(pi));
      assertCapturedAmount(next);
      return next;
    } catch (e) {
      pi = withDebug(pi, e);
      if (e instanceof PayPalApiError && e.outcomeUnknown) return reconcileUnlocked({ ...pi, state: 'CAPTURE_UNKNOWN' }, gw);
      throw e;
    }
  });
}

/** Releases an authorization hold that will not be captured. */
export async function voidPayment(pi: PaymentIntent, gw: PaymentsGateway): Promise<PaymentIntent> {
  return withPaymentLock(pi.id, async () => {
    if (rec(pi).captureId) throw new PaymentInvariantError('A captured payment is refunded, not voided.');
    try {
      return withRecord(pi, await gw.voidAuthorization(pi));
    } catch (e) {
      pi = withDebug(pi, e);
      if (e instanceof PayPalApiError && e.outcomeUnknown) return reconcileUnlocked(pi, gw);
      throw e;
    }
  });
}

/**
 * Re-reads the order from PayPal and derives state from that retrieval alone.
 * Used after any unknown outcome, on webhook hints, and before retries.
 */
export async function reconcile(pi: PaymentIntent, gw: PaymentsGateway): Promise<PaymentIntent> {
  return withPaymentLock(pi.id, () => reconcileUnlocked(pi, gw));
}

async function reconcileUnlocked(pi: PaymentIntent, gw: PaymentsGateway): Promise<PaymentIntent> {
  if (!pi.paypal.orderId) return pi;
  let fresh: GatewayRecord;
  try {
    fresh = await gw.getOrder(pi.paypal.orderId);
  } catch (e) {
    return withDebug(pi, e);
  }
  const merged = mergeRecord(pi.paypal, { ...fresh, refunds: fresh.refunds, debugIds: fresh.debugIds, issue: undefined, replayed: undefined });
  const next = withRecord(pi, merged);
  assertCapturedAmount(next);
  return next;
}
