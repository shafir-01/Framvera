import { describe, expect, it } from 'vitest';
import type { Authority, PaymentIntent } from '@framvera/contracts';
import {
  AuthorityError,
  FakeGateway,
  MoneyError,
  PayPalApiError,
  PaymentInvariantError,
  WebhookInbox,
  authorizePayment,
  captureAuthorizedPayment,
  capturePayment,
  newPaymentIntent,
  openOrder,
  reconcile,
  refundPayment,
  refundable,
  requestIdFor,
  voidPayment,
  webhookHint,
  type GatewayRecord,
} from '../src/index.ts';

const SEK = (minor: number) => ({ currency: 'SEK' as const, minor });
const authority: Authority = { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: SEK(5_500_000) };

function intent(minor = 123_450, extra: Partial<Parameters<typeof newPaymentIntent>[0]> = {}): PaymentIntent {
  return newPaymentIntent({ agreement: 'agr_1', obligations: ['obl_print', 'obl_assembly'], payee: 'act_kista', amount: SEK(minor), ...extra });
}

async function approved(gw: FakeGateway, pi = intent()): Promise<PaymentIntent> {
  const opened = await openOrder(pi, gw, { authority });
  gw.paypal.approve(opened.paypal.orderId!);
  return reconcile(opened, gw);
}

async function captured(gw: FakeGateway, pi = intent()): Promise<PaymentIntent> {
  return capturePayment(await approved(gw, pi), gw);
}

describe('order creation', () => {
  it('creates an order awaiting the buyer, with exact amounts and correlation ids', async () => {
    const gw = new FakeGateway();
    const pi = await openOrder(intent(), gw, {
      authority,
      lines: [
        { obligation: 'obl_print', name: 'Print inserts', amount: SEK(80_000) },
        { obligation: 'obl_assembly', name: 'Kit assembly', amount: SEK(43_450) },
      ],
    });
    expect(pi.state).toBe('PAYER_ACTION_REQUIRED');
    expect(pi.paypal.approveUrl).toContain('fake.invalid');
    const order = gw.paypal.orders.get(pi.paypal.orderId!)!;
    expect(order.unit.amount).toMatchObject({ currency_code: 'SEK', value: '1234.50', breakdown: { item_total: { value: '1234.50' } } });
    expect(order.unit.items.map((i: any) => [i.sku, i.unit_amount.value])).toEqual([
      ['obl_print', '800.00'],
      ['obl_assembly', '434.50'],
    ]);
    expect(order.unit.reference_id).toBe('agr_1');
    expect(order.unit.custom_id).toBe(pi.id);
    expect(order.unit.invoice_id).toBe(pi.operationKey);
  });

  it('replaying creation with the same operation key returns the same order', async () => {
    const gw = new FakeGateway();
    const pi = intent();
    gw.paypal.inject('createOrder', 'timeout-after-success');
    const opened = await openOrder(pi, gw, { authority });
    expect(gw.paypal.executions('createOrder')).toBe(1);
    expect(gw.paypal.orders.size).toBe(1);
    expect(opened.paypal.orderId).toBe([...gw.paypal.orders.keys()][0]);
    expect(gw.paypal.calls.filter((c) => c.op === 'createOrder').map((c) => c.requestId)).toEqual([
      requestIdFor(pi.operationKey, 'create'),
      requestIdFor(pi.operationKey, 'create'),
    ]);
  });

  it('refuses when the buyer has not granted payment preparation, whatever a proposal says', async () => {
    const gw = new FakeGateway();
    await expect(openOrder(intent(), gw, { authority: undefined })).rejects.toBeInstanceOf(AuthorityError);
    await expect(openOrder(intent(), gw, { authority: { ...authority, mayPreparePayments: false } })).rejects.toBeInstanceOf(AuthorityError);
    await expect(openOrder(intent(6_000_000), gw, { authority })).rejects.toThrow(/exceeds the buyer's limit/);
    expect(gw.paypal.orders.size).toBe(0);
  });

  it('rejects a charge in another currency without a stated rate, and line items that do not sum', async () => {
    const gw = new FakeGateway();
    const usd = intent(123_450, { charged: { currency: 'USD', minor: 11_500 } });
    await expect(openOrder(usd, gw, { authority })).rejects.toBeInstanceOf(MoneyError);
    const withFx = intent(123_450, { charged: { currency: 'USD', minor: 11_500 }, fx: { rate: '0.0932', source: 'stated', at: '2026-11-12T12:00:00Z' } });
    await expect(openOrder(withFx, gw, { authority: { ...authority, maxSpend: { currency: 'USD', minor: 20_000 } } })).resolves.toMatchObject({ state: 'PAYER_ACTION_REQUIRED' });
    await expect(
      openOrder(intent(), gw, { authority, lines: [{ obligation: 'obl_print', name: 'Print', amount: SEK(80_000) }] }),
    ).rejects.toThrow(/sum to 80000/);
  });
});

describe('capture', () => {
  it('captures once and records the captured amount', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    expect(pi.state).toBe('CAPTURE_COMPLETED');
    expect((pi.paypal as GatewayRecord).captured).toEqual(SEK(123_450));
    expect(gw.paypal.executions('captureOrder')).toBe(1);
  });

  it('refuses to capture before buyer approval and reports payer action', async () => {
    const gw = new FakeGateway();
    const opened = await openOrder(intent(), gw, { authority });
    const after = await capturePayment(opened, gw);
    expect(after.state).toBe('PAYER_ACTION_REQUIRED');
    expect((after.paypal as GatewayRecord).issue).toBe('ORDER_NOT_APPROVED');
  });

  it('timeout after PayPal captured: retrieves the order, finds the capture, never captures twice', async () => {
    const gw = new FakeGateway();
    const pi = await approved(gw);
    gw.paypal.inject('captureOrder', 'timeout-after-success');
    const after = await capturePayment(pi, gw);
    expect(after.state).toBe('CAPTURE_COMPLETED');
    expect(gw.paypal.executions('captureOrder')).toBe(1);
    const ops = gw.paypal.calls.map((c) => c.op);
    const firstCapture = ops.indexOf('captureOrder');
    expect(ops[firstCapture + 1]).toBe('getOrder');
    expect(ops.filter((o) => o === 'captureOrder')).toHaveLength(1);
  });

  it('timeout before PayPal received it: retrieves first, then retries with the same request id', async () => {
    const gw = new FakeGateway();
    const pi = await approved(gw);
    gw.paypal.inject('captureOrder', 'timeout-before');
    const after = await capturePayment(pi, gw);
    expect(after.state).toBe('CAPTURE_COMPLETED');
    const captures = gw.paypal.calls.filter((c) => c.op === 'captureOrder');
    expect(captures.map((c) => c.requestId)).toEqual([requestIdFor(pi.operationKey, 'capture'), requestIdFor(pi.operationKey, 'capture')]);
    const ops = gw.paypal.calls.map((c) => c.op);
    expect(ops.slice(ops.indexOf('captureOrder'))).toEqual(['captureOrder', 'getOrder', 'captureOrder']);
    expect(gw.paypal.executions('captureOrder')).toBe(1);
  });

  it('stays CAPTURE_UNKNOWN when PayPal cannot be reached to check, instead of retrying blind', async () => {
    const gw = new FakeGateway();
    const pi = await approved(gw);
    gw.paypal.inject('captureOrder', 'server-error').inject('getOrder', 'timeout-before');
    const after = await capturePayment(pi, gw);
    expect(after.state).toBe('CAPTURE_UNKNOWN');
    expect(gw.paypal.calls.filter((c) => c.op === 'captureOrder')).toHaveLength(1);
    const later = await reconcile(after, gw);
    expect(later.state).toBe('APPROVED');
  });

  it('a rate limit is a definite non-execution: state is unchanged and the error says when to retry', async () => {
    const gw = new FakeGateway();
    const pi = await approved(gw);
    gw.paypal.inject('captureOrder', 'rate-limit');
    const err = await capturePayment(pi, gw).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.kind).toBe('rate-limit');
    expect(err.retryAfterMs).toBe(1000);
    expect(gw.paypal.executions('captureOrder')).toBe(0);
    expect((await capturePayment(pi, gw)).state).toBe('CAPTURE_COMPLETED');
  });

  it('a declined instrument and a DECLINED capture both end in CAPTURE_DENIED', async () => {
    const gw = new FakeGateway();
    const a = await approved(gw);
    gw.paypal.inject('captureOrder', 'deny');
    const denied = await capturePayment(a, gw);
    expect(denied.state).toBe('CAPTURE_DENIED');
    expect((denied.paypal as GatewayRecord).issue).toBe('INSTRUMENT_DECLINED');

    const b = await approved(gw, intent());
    gw.paypal.inject('captureOrder', 'declined-capture');
    const declined = await capturePayment(b, gw);
    expect(declined.state).toBe('CAPTURE_DENIED');
    expect((declined.paypal as GatewayRecord).captureStatus).toBe('DECLINED');
  });

  it('concurrent capture attempts on one payment execute once', async () => {
    const gw = new FakeGateway();
    const pi = await approved(gw);
    const [x, y] = await Promise.all([capturePayment(pi, gw), capturePayment(pi, gw)]);
    expect(x.paypal.captureId).toBe(y.paypal.captureId);
    expect(gw.paypal.executions('captureOrder')).toBe(1);
  });

  it('refuses a second capture of a completed payment', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    await expect(capturePayment(pi, gw)).rejects.toBeInstanceOf(PaymentInvariantError);
  });

  it('flags a captured amount that differs from the charge', async () => {
    const gw = new FakeGateway();
    const pi = await approved(gw);
    gw.paypal.orders.get(pi.paypal.orderId!)!.unit.amount = { currency_code: 'SEK', value: '1234.49' };
    await expect(capturePayment(pi, gw)).rejects.toThrow(/expected 123450/);
  });
});

describe('refunds', () => {
  it('partial then full refund of the remainder, each with its own request id', async () => {
    const gw = new FakeGateway();
    let pi = await captured(gw);
    pi = await refundPayment(pi, gw, SEK(20_000));
    expect(pi.state).toBe('REFUND_COMPLETED');
    expect(refundable(pi)).toEqual(SEK(103_450));
    pi = await refundPayment(pi, gw);
    expect(pi.paypal.refunds.map((r) => r.amount.minor)).toEqual([20_000, 103_450]);
    expect(refundable(pi).minor).toBe(0);
    const keys = gw.paypal.calls.filter((c) => c.op === 'refundCapture').map((c) => c.requestId);
    expect(keys).toEqual([requestIdFor(pi.operationKey, 'refund:0'), requestIdFor(pi.operationKey, 'refund:1')]);
    expect([...gw.paypal.captures.values()][0]!.status).toBe('REFUNDED');
  });

  it('never refunds more than was captured, checked before PayPal is called', async () => {
    const gw = new FakeGateway();
    let pi = await captured(gw);
    pi = await refundPayment(pi, gw, SEK(100_000));
    await expect(refundPayment(pi, gw, SEK(23_451))).rejects.toThrow(/exceeds refundable 23450/);
    await expect(refundPayment(pi, gw, SEK(0))).rejects.toBeInstanceOf(MoneyError);
    await expect(refundPayment(pi, gw, SEK(-5))).rejects.toBeInstanceOf(MoneyError);
    await expect(refundPayment(pi, gw, SEK(10.5))).rejects.toBeInstanceOf(MoneyError);
    expect(gw.paypal.calls.filter((c) => c.op === 'refundCapture')).toHaveLength(1);
    pi = await refundPayment(pi, gw, SEK(23_450));
    await expect(refundPayment(pi, gw)).rejects.toThrow(/Nothing left/);
  });

  it('PayPal itself also rejects an over-refund that bypasses the local check', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    const err = await gw.refund(pi, SEK(200_000)).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.issue).toBe('REFUND_AMOUNT_EXCEEDED');
  });

  it('rejects a refund in a different currency from the capture', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    await expect(refundPayment(pi, gw, { currency: 'USD', minor: 100 })).rejects.toThrow(/does not match capture currency SEK/);
    const err = await gw.refund(pi, { currency: 'EUR', minor: 100 }).catch((e) => e);
    expect(err.issue).toBe('INVALID_CURRENCY_CODE');
  });

  it('refund timeout after success: reconciles from the order and does not refund twice', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    gw.paypal.inject('refundCapture', 'timeout-after-success');
    const after = await refundPayment(pi, gw, SEK(30_000));
    expect(after.state).toBe('REFUND_COMPLETED');
    expect(after.paypal.refunds).toHaveLength(1);
    expect(gw.paypal.executions('refundCapture')).toBe(1);
    expect(gw.paypal.refunds.size).toBe(1);
  });

  it('refund timeout before PayPal received it: retries with the same key once the order shows no refund', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    gw.paypal.inject('refundCapture', 'timeout-before');
    const after = await refundPayment(pi, gw, SEK(30_000));
    expect(after.paypal.refunds).toHaveLength(1);
    const keys = gw.paypal.calls.filter((c) => c.op === 'refundCapture').map((c) => c.requestId);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('authorize and void', () => {
  it('authorizes, then voids a hold that will not be captured', async () => {
    const gw = new FakeGateway();
    let pi = await openOrder(intent(), gw, { authority, intent: 'AUTHORIZE' });
    gw.paypal.approve(pi.paypal.orderId!);
    pi = await authorizePayment(await reconcile(pi, gw), gw);
    expect((pi.paypal as GatewayRecord).authorizationStatus).toBe('CREATED');
    pi = await voidPayment(pi, gw);
    expect(pi.state).toBe('VOIDED');
  });

  it('captures an authorization exactly once', async () => {
    const gw = new FakeGateway();
    let pi = await openOrder(intent(), gw, { authority, intent: 'AUTHORIZE' });
    gw.paypal.approve(pi.paypal.orderId!);
    pi = await authorizePayment(await reconcile(pi, gw), gw);
    pi = await captureAuthorizedPayment(pi, gw);
    expect(pi.state).toBe('CAPTURE_COMPLETED');
    await expect(voidPayment(pi, gw)).rejects.toThrow(/refunded, not voided/);
  });
});

describe('webhooks', () => {
  it('verifies signatures through the verify API, dedupes redeliveries and rejects tampering', async () => {
    const gw = new FakeGateway();
    const pi = await captured(gw);
    const event = gw.paypal.events.find((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED')!;
    const { headers, body } = gw.paypal.signWebhook(event);
    const inbox = new WebhookInbox();

    const first = await gw.verifyWebhook(headers, body);
    expect(first).toMatchObject({ verified: true, status: 'SUCCESS', eventType: 'PAYMENT.CAPTURE.COMPLETED' });
    expect(await inbox.accept(first.eventId)).toBe('new');
    const again = await gw.verifyWebhook(headers, body);
    expect(await inbox.accept(again.eventId)).toBe('duplicate');

    const hint = webhookHint(JSON.parse(body));
    expect(hint).toMatchObject({ captureId: pi.paypal.captureId, orderId: pi.paypal.orderId });

    const tampered = body.replace('"COMPLETED"', '"REFUNDED"');
    expect((await gw.verifyWebhook(headers, tampered)).verified).toBe(false);
    const { ['paypal-transmission-sig']: _, ...missing } = headers;
    expect((await gw.verifyWebhook(missing, body)).status).toBe('MISSING_HEADERS');
    expect((await gw.verifyWebhook(headers, 'not json')).status).toBe('INVALID_BODY');
  });

  it('refund events point back to their capture', async () => {
    const gw = new FakeGateway();
    const pi = await refundPayment(await captured(gw), gw, SEK(100));
    const ev = gw.paypal.events.find((e) => e.event_type === 'PAYMENT.CAPTURE.REFUNDED')!;
    expect(webhookHint(ev)).toMatchObject({ refundId: pi.paypal.refunds[0]!.id, captureId: pi.paypal.captureId });
  });
});
