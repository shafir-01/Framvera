import type { Money, PaymentIntent } from '@framvera/contracts';
import { buildOrderBody, buildRefundBody } from './body.ts';
import { PayPalApiError, PaymentInvariantError } from './errors.ts';
import { assertMinor, fromPayPalAmount, sameMoney } from './money.ts';
import { parseCapture, parseOrder, parseRefund } from './parse.ts';
import { extractWebhookHeaders, verifyRequestBody } from './webhooks.ts';
import {
  mergeRecord,
  requestIdFor,
  type CaptureView,
  type CreateOrderOptions,
  type GatewayRecord,
  type HeaderBag,
  type PaymentsGateway,
  type RefundOptions,
  type RefundView,
  type WebhookVerification,
} from './gateway.ts';

export interface RawResult {
  status: number;
  json: any;
  debugId?: string;
}

/** The PayPal REST surface the gateway needs, in wire format. Implementations throw PayPalApiError. */
export interface PayPalPort {
  createOrder(body: Record<string, unknown>, requestId: string): Promise<RawResult>;
  getOrder(orderId: string): Promise<RawResult>;
  captureOrder(orderId: string, requestId: string): Promise<RawResult>;
  authorizeOrder(orderId: string, requestId: string): Promise<RawResult>;
  captureAuthorization(authorizationId: string, requestId: string, body: Record<string, unknown>): Promise<RawResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<RawResult>;
  refundCapture(captureId: string, requestId: string, body: Record<string, unknown>): Promise<RawResult>;
  getCapture(captureId: string): Promise<RawResult>;
  getRefund(refundId: string): Promise<RawResult>;
  verifyWebhookSignature(requestBody: string): Promise<RawResult>;
}

const ids = (r: RawResult): string[] => (r.debugId ? [r.debugId] : []);

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null || v === '') throw new PaymentInvariantError(`${what} is required for this operation.`);
  return v;
}

export class PayPalGateway implements PaymentsGateway {
  readonly kind: 'paypal-sandbox' | 'fake';
  protected readonly port: PayPalPort;
  protected readonly webhookId?: string;
  protected readonly now: () => Date;
  protected readonly defaults: CreateOrderOptions;

  constructor(kind: 'paypal-sandbox' | 'fake', port: PayPalPort, opts: { webhookId?: string; now?: () => Date; defaults?: CreateOrderOptions } = {}) {
    this.kind = kind;
    this.port = port;
    this.webhookId = opts.webhookId;
    this.now = opts.now ?? (() => new Date());
    this.defaults = opts.defaults ?? {};
  }

  async createOrder(pi: PaymentIntent, opts: CreateOrderOptions = {}): Promise<GatewayRecord> {
    const body = buildOrderBody(pi, { ...this.defaults, ...opts });
    const res = await this.port.createOrder(body, requestIdFor(pi.operationKey, 'create'));
    if (res.status === 202) throw this.accepted(res, 'create order');
    const rec = mergeRecord(pi.paypal, { ...parseOrder(res.json), debugIds: ids(res) });
    const unitAmount = rec.units?.[0]?.amount;
    if (unitAmount && !sameMoney(unitAmount, pi.charged)) {
      throw new PaymentInvariantError(`PayPal order amount ${unitAmount.minor} ${unitAmount.currency} differs from charge ${pi.charged.minor} ${pi.charged.currency}.`, rec);
    }
    return rec;
  }

  async getOrder(orderId: string): Promise<GatewayRecord> {
    const res = await this.port.getOrder(orderId);
    return mergeRecord({ env: 'sandbox', refunds: [], debugIds: [] }, { ...parseOrder(res.json), debugIds: ids(res), lastFetchedAt: this.now().toISOString() });
  }

  async capture(pi: PaymentIntent): Promise<GatewayRecord> {
    const orderId = need(pi.paypal.orderId, 'PayPal order id');
    const res = await this.port.captureOrder(orderId, requestIdFor(pi.operationKey, 'capture'));
    if (res.status === 202) throw this.accepted(res, 'capture');
    return mergeRecord(pi.paypal, { ...parseOrder(res.json), debugIds: ids(res), replayed: res.status === 200, issue: undefined });
  }

  async authorize(pi: PaymentIntent): Promise<GatewayRecord> {
    const orderId = need(pi.paypal.orderId, 'PayPal order id');
    const res = await this.port.authorizeOrder(orderId, requestIdFor(pi.operationKey, 'authorize'));
    if (res.status === 202) throw this.accepted(res, 'authorize');
    return mergeRecord(pi.paypal, { ...parseOrder(res.json), debugIds: ids(res), replayed: res.status === 200 });
  }

  async captureAuthorization(pi: PaymentIntent): Promise<GatewayRecord> {
    const authId = need((pi.paypal as GatewayRecord).authorizationId, 'PayPal authorization id');
    const res = await this.port.captureAuthorization(authId, requestIdFor(pi.operationKey, 'capture-authorization'), {
      final_capture: true,
      invoice_id: `${pi.operationKey}-C`,
    });
    const c = res.json ?? {};
    return mergeRecord(pi.paypal, {
      captureId: c.id,
      captureStatus: c.status,
      captureReason: c.status_details?.reason,
      captured: c.amount ? fromPayPalAmount(c.amount) : undefined,
      debugIds: ids(res),
      replayed: res.status === 200,
    });
  }

  async voidAuthorization(pi: PaymentIntent): Promise<GatewayRecord> {
    const authId = need((pi.paypal as GatewayRecord).authorizationId, 'PayPal authorization id');
    const res = await this.port.voidAuthorization(authId, requestIdFor(pi.operationKey, 'void'));
    const status = res.json?.status ?? (res.status === 204 ? 'VOIDED' : undefined);
    return mergeRecord(pi.paypal, { authorizationStatus: status, debugIds: ids(res), replayed: res.status === 200 });
  }

  async refund(pi: PaymentIntent, amount?: Money, opts: RefundOptions = {}): Promise<GatewayRecord> {
    const captureId = need(pi.paypal.captureId, 'PayPal capture id');
    if (amount) assertMinor(amount, { positive: true });
    const sequence = opts.sequence ?? pi.paypal.refunds.length;
    const res = await this.port.refundCapture(captureId, requestIdFor(pi.operationKey, `refund:${sequence}`), buildRefundBody(pi, amount, sequence, opts.note));
    const r = res.json ?? {};
    let refunded: Money | undefined = r.amount ? fromPayPalAmount(r.amount) : amount;
    if (!refunded) refunded = (await this.getRefund(r.id)).amount;
    if (amount && !sameMoney(refunded, amount)) {
      throw new PaymentInvariantError(`PayPal refunded ${refunded.minor} ${refunded.currency}, requested ${amount.minor} ${amount.currency}.`, r);
    }
    return mergeRecord(pi.paypal, {
      refunds: [{ id: need(r.id, 'refund id'), amount: refunded, status: r.status }],
      debugIds: ids(res),
      replayed: res.status === 200,
    });
  }

  async getCapture(captureId: string): Promise<CaptureView> {
    const res = await this.port.getCapture(captureId);
    return parseCapture(res.json, ids(res), this.now().toISOString());
  }

  async getRefund(refundId: string): Promise<RefundView> {
    const res = await this.port.getRefund(refundId);
    return parseRefund(res.json, ids(res), this.now().toISOString());
  }

  async verifyWebhook(headers: HeaderBag, rawBody: string): Promise<WebhookVerification> {
    if (!this.webhookId) return { verified: false, status: 'NOT_CONFIGURED', debugIds: [] };
    const h = extractWebhookHeaders(headers);
    if (!h) return { verified: false, status: 'MISSING_HEADERS', debugIds: [] };
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { verified: false, status: 'INVALID_BODY', debugIds: [] };
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { verified: false, status: 'INVALID_BODY', debugIds: [] };
    const res = await this.port.verifyWebhookSignature(verifyRequestBody(h, this.webhookId, rawBody));
    const ok = res.json?.verification_status === 'SUCCESS';
    return {
      verified: ok,
      status: ok ? 'SUCCESS' : 'FAILURE',
      eventId: event.id,
      eventType: event.event_type,
      resourceId: event.resource?.id,
      debugIds: ids(res),
    };
  }

  private accepted(res: RawResult, what: string): PayPalApiError {
    return new PayPalApiError('accepted', `PayPal accepted ${what} for asynchronous processing; outcome must be retrieved.`, {
      httpStatus: 202,
      debugId: res.debugId,
      body: { orderId: res.json?.id, status: res.json?.status },
    });
  }
}
