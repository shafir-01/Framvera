import { describe, expect, it } from 'vitest';
import type { PaymentIntent } from '@framvera/contracts';
import { apply, isPaymentError, proposePayment, refundable, transition, type PaymentEvent } from '../src/payment.ts';
import { committed, intent, payment } from './fixture.ts';

const SEK = (minor: number) => ({ currency: 'SEK' as const, minor });

function run(pi: PaymentIntent, events: PaymentEvent[]): PaymentIntent {
  let cur = pi;
  for (const e of events) {
    const r = apply(cur, e);
    if (!r.ok) throw new Error(`${e.type}: ${r.message}`);
    cur = r.pi;
  }
  return cur;
}

describe('payment state machine', () => {
  const { agreement } = committed();
  const fresh = () => payment(agreement, 'sP1', 'PAYMENT_PROPOSED');
  const captured = () =>
    run(fresh(), [
      { type: 'ORDER_CREATED', orderId: 'O1' },
      { type: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=O1' },
      { type: 'APPROVED', status: 'APPROVED' },
      { type: 'CAPTURE_REQUESTED' },
      { type: 'CAPTURE_COMPLETED', captureId: 'C1', amount: SEK(1_000_000), status: 'COMPLETED' },
    ]);

  it('no capture without approval', () => {
    expect(isPaymentError(transition('PAYMENT_PROPOSED', { type: 'CAPTURE_REQUESTED' }))).toBe(true);
    expect(isPaymentError(transition('PAYER_ACTION_REQUIRED', { type: 'CAPTURE_REQUESTED' }))).toBe(true);
    expect(transition('APPROVED', { type: 'CAPTURE_REQUESTED' })).toBe('CAPTURE_PENDING');
  });

  it('a timeout yields an unknown outcome, never failure, and blocks blind retries', () => {
    const p = run(fresh(), [{ type: 'ORDER_CREATED', orderId: 'O1' }, { type: 'APPROVED' }, { type: 'CAPTURE_REQUESTED' }, { type: 'TIMEOUT', operation: 'capture' }]);
    expect(p.state).toBe('CAPTURE_UNKNOWN');
    const retry = apply(p, { type: 'CAPTURE_REQUESTED' });
    expect(retry.ok).toBe(false);
    const found = run(p, [{ type: 'RECONCILED', capture: { id: 'C1', status: 'COMPLETED', amount: SEK(1_000_000) } }]);
    expect(found.state).toBe('CAPTURE_COMPLETED');
    const none = run(p, [{ type: 'RECONCILED', orderStatus: 'APPROVED' }]);
    expect(none.state).toBe('APPROVED');
    expect(apply(none, { type: 'CAPTURE_REQUESTED' }).ok).toBe(true);
  });

  it('no duplicate capture and amount must match', () => {
    const p = captured();
    expect(apply(p, { type: 'CAPTURE_REQUESTED' }).ok).toBe(false);
    expect(apply(p, { type: 'CAPTURE_COMPLETED', captureId: 'C2', amount: SEK(1_000_000) }).ok).toBe(false);
    expect(apply(p, { type: 'CAPTURE_COMPLETED', captureId: 'C1', amount: SEK(1_000_000) })).toEqual({ ok: true, pi: p });
    const q = run(fresh(), [{ type: 'ORDER_CREATED', orderId: 'O1' }, { type: 'APPROVED' }, { type: 'CAPTURE_REQUESTED' }]);
    expect(apply(q, { type: 'CAPTURE_COMPLETED', captureId: 'C1', amount: SEK(999) }).ok).toBe(false);
  });

  it('refunds never exceed captured minus refunded', () => {
    let p = captured();
    p = run(p, [
      { type: 'REFUND_REQUESTED', operationKey: 'r1', amount: SEK(600_000) },
      { type: 'REFUND_COMPLETED', refundId: 'R1', operationKey: 'r1', amount: SEK(600_000) },
    ]);
    expect(refundable(p)).toBe(400_000);
    expect(apply(p, { type: 'REFUND_REQUESTED', operationKey: 'r2', amount: SEK(400_001) }).ok).toBe(false);
    p = run(p, [{ type: 'REFUND_REQUESTED', operationKey: 'r2', amount: SEK(400_000) }]);
    expect(refundable(p)).toBe(0);
    p = run(p, [{ type: 'TIMEOUT', operation: 'refund' }]);
    expect(p.state).toBe('REFUND_UNKNOWN');
    expect(apply(p, { type: 'REFUND_REQUESTED', operationKey: 'r3', amount: SEK(1) }).ok).toBe(false);
    p = run(p, [{ type: 'RECONCILED', refunds: [{ id: 'R1', status: 'COMPLETED', amount: SEK(600_000) }] }]);
    expect(p.state).toBe('REFUND_COMPLETED');
    expect(refundable(p)).toBe(400_000);
  });

  it('void only before money moves', () => {
    expect(apply(fresh(), { type: 'VOID' }).ok).toBe(true);
    expect(apply(captured(), { type: 'VOID' }).ok).toBe(false);
  });

  it('proposes payments within the spending authority only', () => {
    const p = proposePayment(agreement, intent(), { payee: 'sP1', obligations: [agreement.obligations[0]!] });
    expect(isPaymentError(p)).toBe(false);
    const low = intent();
    low.authority = { ...low.authority, maxSpend: SEK(10) };
    expect(isPaymentError(proposePayment(agreement, low, { payee: 'sP1', obligations: [agreement.obligations[0]!] }))).toBe(true);
  });
});
