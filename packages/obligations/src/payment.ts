import type { Agreement, Id, Intent, Money, Obligation, PaymentIntent, PaymentState } from '@framvera/contracts';
import { sumMoney } from './util.ts';

export type PaymentEvent =
  | { type: 'ORDER_CREATED'; orderId: string; approveUrl?: string; status?: string }
  | { type: 'PAYER_ACTION_REQUIRED'; approveUrl?: string; status?: string }
  | { type: 'APPROVED'; status?: string }
  | { type: 'CAPTURE_REQUESTED' }
  | { type: 'CAPTURE_COMPLETED'; captureId: string; amount: Money; status?: string }
  | { type: 'CAPTURE_DENIED'; captureId?: string; reason?: string; status?: string }
  | { type: 'TIMEOUT'; operation: 'create' | 'capture' | 'refund' }
  | { type: 'VOID'; reason?: string }
  | { type: 'REFUND_REQUESTED'; operationKey: string; amount: Money }
  | { type: 'REFUND_COMPLETED'; refundId: string; operationKey?: string; amount: Money; status?: string }
  | { type: 'REFUND_DENIED'; operationKey?: string; refundId?: string; reason?: string; status?: string }
  | {
      type: 'RECONCILED';
      orderStatus?: string;
      capture?: { id: string; status: string; amount: Money };
      refunds?: { id: string; status: string; amount: Money }[];
    };

export interface PaymentRuleError {
  error: string;
  message: string;
}
export const isPaymentError = (x: unknown): x is PaymentRuleError => typeof x === 'object' && x !== null && 'error' in x;

const fail = (error: string, message: string): PaymentRuleError => ({ error, message });

const CAPTURED: PaymentState[] = ['CAPTURE_COMPLETED', 'REFUND_PENDING', 'REFUND_COMPLETED', 'REFUND_DENIED', 'REFUND_UNKNOWN'];
const VOIDABLE: PaymentState[] = ['PAYMENT_PROPOSED', 'ORDER_CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'];
const REFUNDABLE_FROM: PaymentState[] = ['CAPTURE_COMPLETED', 'REFUND_COMPLETED', 'REFUND_DENIED'];
const DEAD_REFUND = new Set(['FAILED', 'CANCELLED', 'DENIED', 'DECLINED']);
const PENDING_REQUEST = 'REQUESTED';

/** State rules alone. Amount, id and idempotency rules live in `apply`. */
export function transition(state: PaymentState, ev: PaymentEvent): PaymentState | PaymentRuleError {
  switch (ev.type) {
    case 'ORDER_CREATED':
      return state === 'PAYMENT_PROPOSED' || state === 'ORDER_CREATED' ? 'ORDER_CREATED' : fail('order-state', `No new order from ${state}.`);
    case 'PAYER_ACTION_REQUIRED':
      return state === 'ORDER_CREATED' || state === 'PAYER_ACTION_REQUIRED' ? 'PAYER_ACTION_REQUIRED' : fail('order-state', `Approval link not expected in ${state}.`);
    case 'APPROVED':
      return state === 'ORDER_CREATED' || state === 'PAYER_ACTION_REQUIRED' || state === 'APPROVED'
        ? 'APPROVED'
        : fail('approval-state', `Approval not expected in ${state}.`);
    case 'CAPTURE_REQUESTED':
      if (state === 'CAPTURE_UNKNOWN') return fail('unknown-outcome', 'A previous capture has an unknown outcome; retrieve it before retrying.');
      if (CAPTURED.includes(state) || state === 'CAPTURE_PENDING') return fail('duplicate-capture', 'This payment already has a capture.');
      return state === 'APPROVED' ? 'CAPTURE_PENDING' : fail('not-approved', `Capture needs payer approval; state is ${state}.`);
    case 'CAPTURE_COMPLETED':
      if (state === 'CAPTURE_COMPLETED') return state;
      return state === 'CAPTURE_PENDING' || state === 'CAPTURE_UNKNOWN' ? 'CAPTURE_COMPLETED' : fail('capture-state', `Capture result not expected in ${state}.`);
    case 'CAPTURE_DENIED':
      if (state === 'CAPTURE_DENIED') return state;
      return state === 'CAPTURE_PENDING' || state === 'CAPTURE_UNKNOWN' ? 'CAPTURE_DENIED' : fail('capture-state', `Capture denial not expected in ${state}.`);
    case 'TIMEOUT':
      if (ev.operation === 'capture') return state === 'CAPTURE_PENDING' || state === 'CAPTURE_UNKNOWN' ? 'CAPTURE_UNKNOWN' : fail('timeout-state', `No capture in flight in ${state}.`);
      if (ev.operation === 'refund') return state === 'REFUND_PENDING' || state === 'REFUND_UNKNOWN' ? 'REFUND_UNKNOWN' : fail('timeout-state', `No refund in flight in ${state}.`);
      return state === 'PAYMENT_PROPOSED' ? state : fail('timeout-state', `No order creation in flight in ${state}.`);
    case 'VOID':
      if (state === 'VOIDED') return state;
      return VOIDABLE.includes(state) ? 'VOIDED' : fail('void-state', `Cannot void in ${state}; money has moved or may have moved.`);
    case 'REFUND_REQUESTED':
      if (state === 'REFUND_UNKNOWN') return fail('unknown-outcome', 'A previous refund has an unknown outcome; retrieve it before retrying.');
      if (state === 'REFUND_PENDING') return fail('refund-in-flight', 'A refund is already in flight.');
      return REFUNDABLE_FROM.includes(state) ? 'REFUND_PENDING' : fail('not-captured', `Nothing captured to refund in ${state}.`);
    case 'REFUND_COMPLETED':
      if (state === 'REFUND_COMPLETED') return state;
      return state === 'REFUND_PENDING' || state === 'REFUND_UNKNOWN' ? 'REFUND_COMPLETED' : fail('refund-state', `Refund result not expected in ${state}.`);
    case 'REFUND_DENIED':
      if (state === 'REFUND_DENIED') return state;
      return state === 'REFUND_PENDING' || state === 'REFUND_UNKNOWN' ? 'REFUND_DENIED' : fail('refund-state', `Refund denial not expected in ${state}.`);
    case 'RECONCILED':
      return state;
  }
}

export const capturedMinor = (pi: PaymentIntent): number => (pi.paypal.captureId && CAPTURED.includes(pi.state) ? pi.charged.minor : 0);

/** Captured minus every refund that is completed, pending or requested. */
export function refundable(pi: PaymentIntent): number {
  const held = pi.paypal.refunds.filter((r) => !DEAD_REFUND.has(r.status.toUpperCase())).reduce((s, r) => s + r.amount.minor, 0);
  return capturedMinor(pi) - held;
}

export const refundedMinor = (pi: PaymentIntent): number =>
  pi.paypal.refunds.filter((r) => r.status.toUpperCase() === 'COMPLETED').reduce((s, r) => s + r.amount.minor, 0);

const settledState = (pi: PaymentIntent): PaymentState => (refundedMinor(pi) > 0 ? 'REFUND_COMPLETED' : 'CAPTURE_COMPLETED');

export type ApplyResult = { ok: true; pi: PaymentIntent } | ({ ok: false } & PaymentRuleError);

/** Full rules: preconditions, amount and currency checks, idempotent replays, no duplicate capture, bounded refunds. */
export function apply(pi: PaymentIntent, ev: PaymentEvent): ApplyResult {
  const bad = (e: PaymentRuleError): ApplyResult => ({ ok: false, ...e });
  const next = (state: PaymentState, paypal: Partial<PaymentIntent['paypal']> = {}): ApplyResult => ({
    ok: true,
    pi: { ...pi, state, paypal: { ...pi.paypal, ...paypal } },
  });
  const sameMoney = (m: Money) => m.currency === pi.charged.currency;

  if (ev.type === 'RECONCILED') return reconcileWith(pi, ev);

  const to = transition(pi.state, ev);
  if (isPaymentError(to)) return bad(to);

  switch (ev.type) {
    case 'ORDER_CREATED':
      if (pi.paypal.orderId && pi.paypal.orderId !== ev.orderId) return bad(fail('duplicate-order', `Order ${pi.paypal.orderId} already exists for this payment.`));
      return next(to, { orderId: ev.orderId, approveUrl: ev.approveUrl ?? pi.paypal.approveUrl, status: ev.status ?? pi.paypal.status });
    case 'PAYER_ACTION_REQUIRED':
      return next(to, { approveUrl: ev.approveUrl ?? pi.paypal.approveUrl, status: ev.status ?? pi.paypal.status });
    case 'APPROVED':
      if (!pi.paypal.orderId) return bad(fail('no-order', 'Approval without a PayPal order.'));
      return next(to, { status: ev.status ?? pi.paypal.status });
    case 'CAPTURE_REQUESTED':
      if (pi.paypal.captureId) return bad(fail('duplicate-capture', `Capture ${pi.paypal.captureId} already exists.`));
      return next(to);
    case 'CAPTURE_COMPLETED':
      if (pi.paypal.captureId && pi.paypal.captureId !== ev.captureId) return bad(fail('duplicate-capture', `A second capture ${ev.captureId} conflicts with ${pi.paypal.captureId}.`));
      if (!sameMoney(ev.amount) || ev.amount.minor !== pi.charged.minor) return bad(fail('amount-mismatch', 'Captured amount differs from the approved charge.'));
      return next(to, { captureId: ev.captureId, status: ev.status ?? pi.paypal.status });
    case 'CAPTURE_DENIED':
      return next(to, { status: ev.status ?? pi.paypal.status });
    case 'TIMEOUT':
    case 'VOID':
      return next(to);
    case 'REFUND_REQUESTED': {
      if (!sameMoney(ev.amount)) return bad(fail('currency', 'Refund currency differs from the capture.'));
      if (ev.amount.minor <= 0) return bad(fail('refund-amount', 'Refund must be positive.'));
      if (pi.paypal.refunds.some((r) => r.id === `op:${ev.operationKey}`)) return bad(fail('duplicate-refund', 'This refund operation was already requested.'));
      const room = refundable(pi);
      if (ev.amount.minor > room) return bad(fail('refund-exceeds', `Refund ${ev.amount.minor} exceeds the refundable ${room}.`));
      return next(to, { refunds: [...pi.paypal.refunds, { id: `op:${ev.operationKey}`, amount: ev.amount, status: PENDING_REQUEST }] });
    }
    case 'REFUND_COMPLETED': {
      if (!sameMoney(ev.amount)) return bad(fail('currency', 'Refund currency differs from the capture.'));
      const known = pi.paypal.refunds.find((r) => r.id === ev.refundId);
      if (known && known.status.toUpperCase() === 'COMPLETED') return { ok: true, pi };
      const opId = ev.operationKey ? `op:${ev.operationKey}` : undefined;
      const pending = pi.paypal.refunds.find((r) => r.id === opId) ?? pi.paypal.refunds.find((r) => r.status === PENDING_REQUEST);
      const others = pi.paypal.refunds.filter((r) => r !== pending && r !== known);
      const held = others.filter((r) => !DEAD_REFUND.has(r.status.toUpperCase())).reduce((s, r) => s + r.amount.minor, 0);
      if (held + ev.amount.minor > capturedMinor(pi)) return bad(fail('refund-exceeds', 'Refunds would exceed the captured amount.'));
      return next(to, { refunds: [...others, { id: ev.refundId, amount: ev.amount, status: 'COMPLETED' }], status: ev.status ?? pi.paypal.status });
    }
    case 'REFUND_DENIED': {
      const opId = ev.operationKey ? `op:${ev.operationKey}` : undefined;
      const refunds = pi.paypal.refunds.map((r) =>
        r.id === opId || r.id === ev.refundId || (!opId && !ev.refundId && r.status === PENDING_REQUEST) ? { ...r, status: 'DENIED' } : r,
      );
      return next(to, { refunds });
    }
  }
}

function reconcileWith(pi: PaymentIntent, ev: Extract<PaymentEvent, { type: 'RECONCILED' }>): ApplyResult {
  let cur = pi;
  const step = (e: PaymentEvent): ApplyResult => {
    const r = apply(cur, e);
    if (r.ok) cur = r.pi;
    return r;
  };
  if (cur.state === 'CAPTURE_UNKNOWN' || cur.state === 'CAPTURE_PENDING') {
    const c = ev.capture;
    if (c) {
      const s = c.status.toUpperCase();
      if (s === 'COMPLETED') {
        const r = step({ type: 'CAPTURE_COMPLETED', captureId: c.id, amount: c.amount, status: c.status });
        if (!r.ok) return r;
      } else if (s === 'DECLINED' || s === 'FAILED' || s === 'DENIED') {
        const r = step({ type: 'CAPTURE_DENIED', captureId: c.id, status: c.status });
        if (!r.ok) return r;
      } else if (s === 'PENDING') {
        cur = { ...cur, state: 'CAPTURE_PENDING', paypal: { ...cur.paypal, captureId: c.id, status: c.status } };
      }
    } else if (ev.orderStatus?.toUpperCase() === 'APPROVED') {
      cur = { ...cur, state: 'APPROVED', paypal: { ...cur.paypal, status: ev.orderStatus } };
    }
  }
  if (cur.state === 'REFUND_UNKNOWN' || cur.state === 'REFUND_PENDING') {
    const fresh = (ev.refunds ?? []).filter((r) => !cur.paypal.refunds.some((x) => x.id === r.id && x.status.toUpperCase() === 'COMPLETED'));
    const done = fresh.find((r) => r.status.toUpperCase() === 'COMPLETED');
    const dead = fresh.find((r) => DEAD_REFUND.has(r.status.toUpperCase()));
    const pend = fresh.find((r) => r.status.toUpperCase() === 'PENDING');
    if (done) {
      const r = step({ type: 'REFUND_COMPLETED', refundId: done.id, amount: done.amount, status: done.status });
      if (!r.ok) return r;
    } else if (pend) {
      cur = { ...cur, state: 'REFUND_PENDING' };
    } else if (dead) {
      const r = step({ type: 'REFUND_DENIED', refundId: dead.id, status: dead.status });
      if (!r.ok) return r;
    } else if (ev.refunds) {
      const refunds = cur.paypal.refunds.filter((r) => r.status !== PENDING_REQUEST);
      cur = { ...cur, paypal: { ...cur.paypal, refunds } };
      cur = { ...cur, state: settledState(cur) };
    }
  }
  return { ok: true, pi: cur };
}

export const paymentMachine = { transition, apply, refundable, refundedMinor, capturedMinor };

export interface ProposeOptions {
  payee: Id;
  obligations: Obligation[];
  id?: Id;
  operationKey?: string;
}

/** A provider-neutral payment awaiting order creation. Checks the buyer's spending permission. */
export function proposePayment(agreement: Agreement, intent: Intent, opts: ProposeOptions): PaymentIntent | PaymentRuleError {
  if (!intent.authority.mayPreparePayments) return fail('authority', 'The buyer has not authorised preparing payments.');
  const amount = sumMoney(
    opts.obligations.map((o) => o.amount),
    intent.budget.currency,
  );
  if (amount.minor > intent.authority.maxSpend.minor) return fail('authority', 'Payment exceeds the spending authority.');
  const key = opts.operationKey ?? `pay:${agreement.id}:v${agreement.version}:${opts.payee}`;
  return {
    id: opts.id ?? key,
    operationKey: key,
    agreement: agreement.id,
    obligations: opts.obligations.map((o) => o.id),
    payee: opts.payee,
    amount,
    charged: amount,
    state: 'PAYMENT_PROPOSED',
    paypal: { env: 'sandbox', refunds: [], debugIds: [] },
  };
}
