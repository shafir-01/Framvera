import type { Money } from '@framvera/contracts';
import { fromPayPalAmount } from './money.ts';
import type { CaptureView, GatewayRecord, OrderIntent, RefundView, UnitResult } from './gateway.ts';

type Json = Record<string, any>;

const amount = (a: any): Money | undefined => (a && typeof a.value === 'string' ? fromPayPalAmount(a) : undefined);

export function approveLink(o: Json): string | undefined {
  const links: Json[] = Array.isArray(o?.links) ? o.links : [];
  return (links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve'))?.href;
}

export function parseUnits(o: Json): UnitResult[] {
  const units: Json[] = Array.isArray(o?.purchase_units) ? o.purchase_units : [];
  return units.map((pu) => {
    const p = pu.payments ?? {};
    return {
      referenceId: pu.reference_id,
      amount: amount(pu.amount),
      payeeMerchantId: pu.payee?.merchant_id,
      captures: (p.captures ?? []).map((c: Json) => ({
        id: c.id,
        status: c.status,
        reason: c.status_details?.reason,
        amount: amount(c.amount),
        finalCapture: c.final_capture,
      })),
      authorizations: (p.authorizations ?? []).map((a: Json) => ({
        id: a.id,
        status: a.status,
        amount: amount(a.amount),
        expiresAt: a.expiration_time,
      })),
      refunds: (p.refunds ?? []).map((r: Json) => ({ id: r.id, status: r.status, amount: amount(r.amount)! })),
    };
  });
}

/** Order JSON (create, get, capture, authorize responses) to record fields. First purchase unit is the payment of record. */
export function parseOrder(o: Json): Partial<GatewayRecord> {
  const units = parseUnits(o);
  const u = units[0];
  const cap = u?.captures[u.captures.length - 1];
  const auth = u?.authorizations[u.authorizations.length - 1];
  return {
    orderId: o.id,
    status: o.status,
    orderStatus: o.status,
    intent: o.intent as OrderIntent | undefined,
    approveUrl: approveLink(o),
    captureId: cap?.id,
    captureStatus: cap?.status,
    captureReason: cap?.reason,
    captured: cap?.amount,
    authorizationId: auth?.id,
    authorizationStatus: auth?.status,
    authorizationExpiresAt: auth?.expiresAt,
    payeeMerchantId: u?.payeeMerchantId,
    refunds: units.flatMap((x) => x.refunds),
    units: units.length ? units : undefined,
  };
}

export function parseCapture(c: Json, debugIds: string[], fetchedAt: string): CaptureView {
  return {
    id: c.id,
    status: c.status,
    reason: c.status_details?.reason,
    amount: fromPayPalAmount(c.amount),
    finalCapture: c.final_capture,
    invoiceId: c.invoice_id,
    customId: c.custom_id,
    debugIds,
    fetchedAt,
  };
}

export function parseRefund(r: Json, debugIds: string[], fetchedAt: string): RefundView {
  return { id: r.id, status: r.status, amount: fromPayPalAmount(r.amount), invoiceId: r.invoice_id, debugIds, fetchedAt };
}
