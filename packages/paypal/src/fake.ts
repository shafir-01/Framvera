import { createHash, createHmac } from 'node:crypto';
import { PayPalGateway, type PayPalPort, type RawResult } from './core.ts';
import { PayPalApiError, errorFromResponse } from './errors.ts';
import { fromPayPalAmount, toPayPalAmount, type PayPalAmount } from './money.ts';

/**
 * Deterministic in-memory stand-in for PayPal, for tests and the labelled offline fallback only.
 * Ids start with FAKE and links point at fake.invalid so nothing it produces can pass for a PayPal record.
 */
export type Fault =
  | 'timeout-before'
  | 'timeout-after-success'
  | 'server-error'
  | 'rate-limit'
  | 'conflict'
  | 'deny'
  | 'declined-capture';

export type FaultOp = keyof PayPalPort;

interface FakeCapture {
  id: string;
  orderId: string;
  status: string;
  amount: PayPalAmount;
  refunded: number;
}
interface FakeRefund {
  id: string;
  captureId: string;
  status: string;
  amount: PayPalAmount;
}
interface FakeOrder {
  id: string;
  intent: string;
  status: string;
  unit: any;
  captures: string[];
  authorizations: { id: string; status: string; amount: PayPalAmount; expiration_time: string }[];
}

export interface FakeEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource: any;
}

export class FakePayPal implements PayPalPort {
  readonly orders = new Map<string, FakeOrder>();
  readonly captures = new Map<string, FakeCapture>();
  readonly refunds = new Map<string, FakeRefund>();
  readonly events: FakeEvent[] = [];
  readonly calls: { op: FaultOp; requestId?: string; replayed?: boolean; executed: boolean }[] = [];
  readonly webhookId = 'FAKEWEBHOOK1';
  private readonly webhookSecret = 'fake-webhook-signing-key';
  private readonly idem = new Map<string, { status: number; render: () => any }>();
  private readonly invoices = new Set<string>();
  private readonly faults: { op: FaultOp; fault: Fault }[] = [];
  private seq = 0;
  private clock = Date.parse('2026-11-12T12:00:00Z');

  inject(op: FaultOp, fault: Fault, times = 1): this {
    for (let i = 0; i < times; i++) this.faults.push({ op, fault });
    return this;
  }

  /** Simulates the buyer approving on PayPal. Real approval only happens on PayPal's own pages. */
  approve(orderId: string): void {
    const o = this.mustOrder(orderId);
    if (o.status !== 'CREATED' && o.status !== 'PAYER_ACTION_REQUIRED') throw new Error(`Order ${orderId} is ${o.status}.`);
    o.status = 'APPROVED';
    this.emit('CHECKOUT.ORDER.APPROVED', this.renderOrder(o));
  }

  executions(op: FaultOp): number {
    return this.calls.filter((c) => c.op === op && c.executed && !c.replayed).length;
  }

  signWebhook(event: FakeEvent): { headers: Record<string, string>; body: string } {
    const body = JSON.stringify(event);
    const transmissionId = `fake-tx-${event.id}`;
    const time = new Date(this.clock).toISOString();
    return {
      body,
      headers: {
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': time,
        'paypal-transmission-sig': this.signature(transmissionId, time, body),
        'paypal-cert-url': 'https://fake.invalid/cert.pem',
        'paypal-auth-algo': 'SHA256withRSA',
      },
    };
  }

  private signature(transmissionId: string, time: string, rawEvent: string): string {
    const digest = createHash('sha256').update(rawEvent).digest('hex');
    return createHmac('sha256', this.webhookSecret).update(`${transmissionId}|${time}|${this.webhookId}|${digest}`).digest('base64');
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `FAKE${prefix}${String(this.seq).padStart(10, '0')}`;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private emit(type: string, resource: any): void {
    this.events.push({ id: `WH-FAKE-${this.events.length + 1}`, event_type: type, create_time: this.now(), resource });
  }

  private mustOrder(id: string): FakeOrder {
    const o = this.orders.get(id);
    if (!o) throw errorFromResponse(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }], debug_id: 'fakedebug404' });
    return o;
  }

  private reject(status: number, issue: string, description = issue): never {
    throw errorFromResponse(status, { name: status === 422 ? 'UNPROCESSABLE_ENTITY' : 'ERROR', message: description, debug_id: `fakedebug${status}`, details: [{ issue, description }] });
  }

  private async exec(op: FaultOp, requestId: string | undefined, run: () => { status: number; render: () => any }): Promise<RawResult> {
    const key = requestId ? `${op}|${requestId}` : undefined;
    const stored = key ? this.idem.get(key) : undefined;
    const i = this.faults.findIndex((f) => f.op === op);
    const fault = i >= 0 ? this.faults.splice(i, 1)[0]!.fault : undefined;

    if (fault === 'timeout-before') {
      this.calls.push({ op, requestId, executed: false });
      throw new PayPalApiError('timeout', 'Simulated timeout before PayPal received the request.');
    }
    if (fault === 'rate-limit') {
      this.calls.push({ op, requestId, executed: false });
      throw errorFromResponse(429, { name: 'RATE_LIMIT_REACHED', message: 'Too many requests.', debug_id: 'fakedebug429' }, undefined, '1');
    }
    if (fault === 'server-error') {
      this.calls.push({ op, requestId, executed: false });
      throw errorFromResponse(500, { name: 'INTERNAL_SERVER_ERROR', message: 'Simulated outage.', debug_id: 'fakedebug500' });
    }
    if (fault === 'conflict') {
      this.calls.push({ op, requestId, executed: false });
      this.reject(409, 'PREVIOUS_REQUEST_IN_PROGRESS');
    }
    if (fault === 'deny') {
      this.calls.push({ op, requestId, executed: false });
      this.reject(422, 'INSTRUMENT_DECLINED', 'The instrument presented was declined.');
    }

    if (stored) {
      this.calls.push({ op, requestId, replayed: true, executed: true });
      return { status: 200, json: stored.render(), debugId: 'fakedebugreplay' };
    }
    const out = run.call(this);
    if (key) this.idem.set(key, out);
    this.calls.push({ op, requestId, executed: true });
    if (fault === 'timeout-after-success') throw new PayPalApiError('timeout', 'Simulated timeout after PayPal processed the request.');
    return { status: out.status, json: out.render(), debugId: `fakedebug${this.seq}` };
  }

  private nextFault(op: FaultOp, fault: Fault): boolean {
    const i = this.faults.findIndex((f) => f.op === op && f.fault === fault);
    if (i < 0) return false;
    this.faults.splice(i, 1);
    return true;
  }

  renderOrder(o: FakeOrder): any {
    const caps = o.captures.map((id) => this.captures.get(id)!);
    const refunds = [...this.refunds.values()].filter((r) => o.captures.includes(r.captureId));
    const payments: any = {};
    if (caps.length) payments.captures = caps.map((c) => ({ id: c.id, status: c.status, amount: c.amount, final_capture: true }));
    if (o.authorizations.length) payments.authorizations = o.authorizations;
    if (refunds.length) payments.refunds = refunds.map((r) => ({ id: r.id, status: r.status, amount: r.amount }));
    return {
      id: o.id,
      intent: o.intent,
      status: o.status,
      purchase_units: [{ ...o.unit, payee: { merchant_id: 'FAKEMERCHANT1' }, ...(caps.length || o.authorizations.length ? { payments } : {}) }],
      links: o.status === 'PAYER_ACTION_REQUIRED' || o.status === 'CREATED' ? [{ rel: 'payer-action', href: `https://fake.invalid/checkout?token=${o.id}`, method: 'GET' }] : [],
    };
  }

  createOrder(body: Record<string, unknown>, requestId: string): Promise<RawResult> {
    return this.exec('createOrder', requestId, () => {
      const unit = (body.purchase_units as any[])[0];
      const items: any[] = unit.items ?? [];
      const total = fromPayPalAmount(unit.amount);
      const sum = items.reduce((s, it) => s + fromPayPalAmount(it.unit_amount).minor * Number(it.quantity), 0);
      if (items.length && sum !== total.minor) this.reject(422, 'ITEM_TOTAL_MISMATCH');
      if (unit.invoice_id && this.invoices.has(unit.invoice_id)) this.reject(422, 'DUPLICATE_INVOICE_ID');
      if (unit.invoice_id) this.invoices.add(unit.invoice_id);
      const o: FakeOrder = {
        id: this.id('O'),
        intent: String(body.intent),
        status: body.payment_source ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
        unit: { reference_id: unit.reference_id, amount: unit.amount, custom_id: unit.custom_id, invoice_id: unit.invoice_id, items },
        captures: [],
        authorizations: [],
      };
      this.orders.set(o.id, o);
      return { status: 201, render: () => this.renderOrder(o) };
    });
  }

  getOrder(orderId: string): Promise<RawResult> {
    return this.exec('getOrder', undefined, () => {
      const o = this.mustOrder(orderId);
      return { status: 200, render: () => this.renderOrder(o) };
    });
  }

  captureOrder(orderId: string, requestId: string): Promise<RawResult> {
    const declined = this.nextFault('captureOrder', 'declined-capture');
    return this.exec('captureOrder', requestId, () => {
      const o = this.mustOrder(orderId);
      if (o.intent !== 'CAPTURE') this.reject(422, 'ACTION_DOES_NOT_MATCH_INTENT');
      if (o.status === 'COMPLETED') this.reject(422, 'ORDER_ALREADY_CAPTURED');
      if (o.status !== 'APPROVED') this.reject(422, 'ORDER_NOT_APPROVED');
      const c: FakeCapture = { id: this.id('C'), orderId, status: declined ? 'DECLINED' : 'COMPLETED', amount: o.unit.amount, refunded: 0 };
      this.captures.set(c.id, c);
      o.captures.push(c.id);
      o.status = 'COMPLETED';
      this.emit(declined ? 'PAYMENT.CAPTURE.DENIED' : 'PAYMENT.CAPTURE.COMPLETED', { id: c.id, status: c.status, amount: c.amount, supplementary_data: { related_ids: { order_id: o.id } } });
      return { status: 201, render: () => this.renderOrder(o) };
    });
  }

  authorizeOrder(orderId: string, requestId: string): Promise<RawResult> {
    return this.exec('authorizeOrder', requestId, () => {
      const o = this.mustOrder(orderId);
      if (o.intent !== 'AUTHORIZE') this.reject(422, 'ACTION_DOES_NOT_MATCH_INTENT');
      if (o.status !== 'APPROVED') this.reject(422, 'ORDER_NOT_APPROVED');
      o.authorizations.push({ id: this.id('A'), status: 'CREATED', amount: o.unit.amount, expiration_time: new Date(this.clock + 29 * 86400_000).toISOString() });
      o.status = 'COMPLETED';
      return { status: 201, render: () => this.renderOrder(o) };
    });
  }

  private findAuth(authorizationId: string): { o: FakeOrder; a: FakeOrder['authorizations'][number] } {
    for (const o of this.orders.values()) {
      const a = o.authorizations.find((x) => x.id === authorizationId);
      if (a) return { o, a };
    }
    return this.reject(404, 'INVALID_RESOURCE_ID');
  }

  captureAuthorization(authorizationId: string, requestId: string): Promise<RawResult> {
    return this.exec('captureAuthorization', requestId, () => {
      const { o, a } = this.findAuth(authorizationId);
      if (a.status !== 'CREATED') this.reject(422, a.status === 'VOIDED' ? 'AUTHORIZATION_VOIDED' : 'PREVIOUSLY_CAPTURED');
      const c: FakeCapture = { id: this.id('C'), orderId: o.id, status: 'COMPLETED', amount: a.amount, refunded: 0 };
      this.captures.set(c.id, c);
      o.captures.push(c.id);
      a.status = 'CAPTURED';
      return { status: 201, render: () => ({ id: c.id, status: this.captures.get(c.id)!.status, amount: c.amount, final_capture: true }) };
    });
  }

  voidAuthorization(authorizationId: string, requestId: string): Promise<RawResult> {
    return this.exec('voidAuthorization', requestId, () => {
      const { a } = this.findAuth(authorizationId);
      if (a.status !== 'CREATED') this.reject(422, 'CANNOT_BE_VOIDED');
      a.status = 'VOIDED';
      return { status: 200, render: () => ({ id: a.id, status: a.status, amount: a.amount }) };
    });
  }

  refundCapture(captureId: string, requestId: string, body: Record<string, unknown>): Promise<RawResult> {
    return this.exec('refundCapture', requestId, () => {
      const c = this.captures.get(captureId);
      if (!c) return this.reject(404, 'INVALID_RESOURCE_ID');
      if (c.status !== 'COMPLETED' && c.status !== 'PARTIALLY_REFUNDED') this.reject(422, 'CAPTURE_FULLY_REFUNDED');
      const capMinor = fromPayPalAmount(c.amount).minor;
      const req = body.amount as PayPalAmount | undefined;
      if (req && req.currency_code !== c.amount.currency_code) this.reject(422, 'INVALID_CURRENCY_CODE');
      const minor = req ? fromPayPalAmount(req).minor : capMinor - c.refunded;
      if (minor <= 0 || c.refunded + minor > capMinor) this.reject(422, 'REFUND_AMOUNT_EXCEEDED');
      c.refunded += minor;
      c.status = c.refunded === capMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const r: FakeRefund = { id: this.id('R'), captureId, status: 'COMPLETED', amount: toPayPalAmount({ currency: fromPayPalAmount(c.amount).currency, minor }) };
      this.refunds.set(r.id, r);
      this.emit('PAYMENT.CAPTURE.REFUNDED', { id: r.id, status: r.status, amount: r.amount, links: [{ rel: 'up', href: `https://fake.invalid/v2/payments/captures/${captureId}` }] });
      return { status: 201, render: () => ({ ...r, links: [] }) };
    });
  }

  getCapture(captureId: string): Promise<RawResult> {
    return this.exec('getCapture', undefined, () => {
      const c = this.captures.get(captureId);
      if (!c) return this.reject(404, 'INVALID_RESOURCE_ID');
      return { status: 200, render: () => ({ id: c.id, status: c.status, amount: c.amount, final_capture: true }) };
    });
  }

  getRefund(refundId: string): Promise<RawResult> {
    return this.exec('getRefund', undefined, () => {
      const r = this.refunds.get(refundId);
      if (!r) return this.reject(404, 'INVALID_RESOURCE_ID');
      return { status: 200, render: () => ({ id: r.id, status: r.status, amount: r.amount }) };
    });
  }

  async verifyWebhookSignature(requestBody: string): Promise<RawResult> {
    const marker = '"webhook_event":';
    const at = requestBody.indexOf(marker);
    const raw = at >= 0 ? requestBody.slice(at + marker.length, -1) : '';
    const head = JSON.parse(`${requestBody.slice(0, at - 1)}}`);
    const ok = head.webhook_id === this.webhookId && head.transmission_sig === this.signature(head.transmission_id, head.transmission_time, raw);
    return { status: 200, json: { verification_status: ok ? 'SUCCESS' : 'FAILURE' }, debugId: 'fakedebugverify' };
  }
}

export class FakeGateway extends PayPalGateway {
  readonly paypal: FakePayPal;

  constructor(opts: { offlineFallback?: boolean } = {}) {
    if (!process.env.VITEST && !opts.offlineFallback) {
      throw new Error('FakeGateway runs only under tests or as an explicitly labelled offline fallback.');
    }
    const paypal = new FakePayPal();
    super('fake', paypal, { webhookId: paypal.webhookId });
    this.paypal = paypal;
  }
}

export function isFakeRecord(r: { orderId?: string; captureId?: string }): boolean {
  return Boolean(r.orderId?.startsWith('FAKE') || r.captureId?.startsWith('FAKE'));
}
