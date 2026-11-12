import type { Money, PaymentIntent } from '@framvera/contracts';
import { MoneyError, assertMinor, sumMinor, toPayPalAmount } from './money.ts';
import type { CreateOrderOptions, OrderLine, Payee } from './gateway.ts';

const MERCHANT_ID = /^[2-9A-HJ-NP-Z]{13}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class OrderBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderBuildError';
  }
}

function within(label: string, v: string, max: number): string {
  if (!v || v.length > max) throw new OrderBuildError(`${label} must be 1 to ${max} characters.`);
  return v;
}

export function validPayee(p: Payee | undefined): Record<string, string> | undefined {
  if (!p || (!p.merchantId && !p.email)) return undefined;
  if (p.merchantId && !MERCHANT_ID.test(p.merchantId)) throw new OrderBuildError('Payee merchant id is not a valid PayPal account id.');
  if (p.email && !EMAIL.test(p.email)) throw new OrderBuildError('Payee email is not a valid address.');
  return p.merchantId ? { merchant_id: p.merchantId } : { email_address: p.email! };
}

/** Economic amount and the amount sent to PayPal must agree exactly, or carry a stated conversion. */
export function checkCharge(pi: PaymentIntent): Money {
  assertMinor(pi.charged, { positive: true });
  if (pi.amount.currency === pi.charged.currency) {
    if (pi.amount.minor !== pi.charged.minor) throw new MoneyError(`Charged ${pi.charged.minor} differs from economic amount ${pi.amount.minor} with no conversion.`);
  } else if (!pi.fx) {
    throw new MoneyError(`Charging ${pi.charged.currency} for a ${pi.amount.currency} amount requires a stated exchange rate.`);
  }
  return pi.charged;
}

function linesFor(pi: PaymentIntent, opts: CreateOrderOptions): OrderLine[] {
  if (opts.lines?.length) return opts.lines;
  const single = pi.obligations.length === 1 ? pi.obligations[0]! : pi.agreement;
  return [{ obligation: single, name: opts.description ?? `Agreement ${pi.agreement}`, amount: pi.charged }];
}

/** Orders v2 create body in PayPal's wire format (snake_case), exact to the minor unit. */
export function buildOrderBody(pi: PaymentIntent, opts: CreateOrderOptions = {}): Record<string, unknown> {
  const charged = checkCharge(pi);
  const lines = linesFor(pi, opts);
  for (const l of lines) assertMinor(l.amount, { positive: true });
  const total = sumMinor(lines.map((l) => l.amount), charged.currency);
  if (total !== charged.minor) throw new MoneyError(`Line items sum to ${total} but the charge is ${charged.minor}.`);

  const referenceId = pi.obligations.length === 1 ? pi.obligations[0]! : pi.agreement;
  const unit: Record<string, unknown> = {
    reference_id: within('reference_id', referenceId, 256),
    custom_id: within('custom_id', pi.id, 255),
    invoice_id: within('invoice_id', pi.operationKey, 127),
    amount: { ...toPayPalAmount(charged), breakdown: { item_total: toPayPalAmount(charged) } },
    items: lines.map((l) => ({
      name: within('item name', l.name, 127),
      quantity: '1',
      unit_amount: toPayPalAmount(l.amount),
      sku: within('sku', l.obligation, 127),
      category: 'PHYSICAL_GOODS',
    })),
  };
  if (opts.description) unit.description = within('description', opts.description, 127);
  const payee = validPayee(opts.payee);
  if (payee) unit.payee = payee;

  const experience: Record<string, string> = {
    brand_name: opts.brandName ?? 'Framvera',
    shipping_preference: 'NO_SHIPPING',
    user_action: 'PAY_NOW',
  };
  if (opts.locale) experience.locale = opts.locale;
  if (opts.returnUrl) experience.return_url = opts.returnUrl;
  if (opts.cancelUrl) experience.cancel_url = opts.cancelUrl;

  return {
    intent: opts.intent ?? 'CAPTURE',
    purchase_units: [unit],
    payment_source: { paypal: { experience_context: experience } },
  };
}

export function buildRefundBody(pi: PaymentIntent, amount: Money | undefined, sequence: number, note?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    invoice_id: within('refund invoice_id', `${pi.operationKey}-R${sequence}`, 127),
    custom_id: within('custom_id', pi.id, 127),
  };
  if (amount) body.amount = toPayPalAmount(amount);
  if (note) body.note_to_payer = within('note_to_payer', note, 255);
  return body;
}

/** PayPal wire keys to the SDK's model keys (reference_id to referenceId). Values are untouched. */
export function camelize(v: unknown): any {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), camelize(x)]));
  }
  return v;
}
