/**
 * Real PayPal sandbox lifecycle: create order -> buyer approval -> capture -> independent GET ->
 * idempotent replay -> partial refund -> GET. Writes a redacted trace to evidence/paypal-smoke.json.
 *
 *   npx tsx packages/paypal/src/smoke.ts            approve in a browser using the printed link (polls up to 10 min)
 *   npx tsx packages/paypal/src/smoke.ts --auto     approve as the sandbox test buyer with headless Chromium
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Authority, PaymentIntent } from '@framvera/contracts';
import { PayPalSandboxAdapter } from './adapter.ts';
import { requestIdFor, type GatewayRecord } from './gateway.ts';
import { capturePayment, newPaymentIntent, openOrder, reconcile, refundPayment } from './payments.ts';
import { assertNoSecrets, redactTrace } from './redact.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'evidence/paypal-smoke.json');
if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));

const auto = process.argv.includes('--auto');
const trace: Record<string, unknown>[] = [];
const started = new Date().toISOString();

function step(name: string, pi: PaymentIntent, extra: Record<string, unknown> = {}, t0 = Date.now()) {
  const r = pi.paypal as GatewayRecord;
  const entry = {
    step: name,
    at: new Date().toISOString(),
    ms: Date.now() - t0,
    state: pi.state,
    paypalStatus: { order: r.orderStatus, capture: r.captureStatus, hold: r.authorizationStatus },
    ids: { orderId: r.orderId, captureId: r.captureId, refundIds: r.refunds.map((x) => x.id) },
    captured: r.captured,
    refunds: r.refunds.map((x) => ({ id: x.id, status: x.status, amount: x.amount })),
    replayed: r.replayed ?? false,
    debugIds: r.debugIds.slice(-3),
    ...extra,
  };
  trace.push(entry);
  console.log(`${name.padEnd(22)} ${pi.state.padEnd(22)} order=${r.orderId ?? '-'} capture=${r.captureId ?? '-'} refunds=${r.refunds.map((x) => `${x.id}:${x.status}`).join(',') || '-'}`);
}

function write(result: 'ok' | 'failed', error?: string) {
  const doc = redactTrace({
    kind: 'paypal-sandbox-smoke',
    source: 'paypal-sandbox',
    environment: 'https://api-m.sandbox.paypal.com',
    integration: '@paypal/paypal-server-sdk 2.5.0 (Orders v2, Payments v2) + REST webhook verification',
    approval: auto ? 'sandbox test buyer via automated browser on PayPal sandbox checkout (test harness)' : 'sandbox buyer in a browser',
    startedAt: started,
    finishedAt: new Date().toISOString(),
    result,
    error,
    steps: trace,
  });
  const text = JSON.stringify(doc, null, 2);
  assertNoSecrets(text);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${text}\n`);
  console.log(`trace written: evidence/paypal-smoke.json (${result})`);
}

async function waitForApproval(pi: PaymentIntent, gw: PayPalSandboxAdapter, minutes = 10): Promise<PaymentIntent> {
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    pi = await reconcile(pi, gw);
    if (pi.state === 'APPROVED') return pi;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Order was not approved in time.');
}

async function main() {
  const gw = new PayPalSandboxAdapter();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const authority: Authority = { mayNegotiate: false, mayReserve: false, mayPreparePayments: true, maxSpend: { currency: 'SEK', minor: 5_500_000 } };
  let pi = newPaymentIntent({
    id: `pay_smoke_${stamp}`,
    agreement: `agr_smoke_${stamp}`,
    obligations: [`obl_smoke_${stamp}_print`, `obl_smoke_${stamp}_assembly`],
    payee: 'act_smoke_supplier',
    amount: { currency: 'SEK', minor: 123_450 },
  });
  trace.push({ step: 'intent', at: new Date().toISOString(), paymentId: pi.id, operationKey: pi.operationKey, amount: pi.charged, obligations: pi.obligations });

  let t0 = Date.now();
  pi = await openOrder(pi, gw, {
    authority,
    description: 'Framvera smoke: print and assembly',
    lines: [
      { obligation: pi.obligations[0]!, name: 'Print inserts (smoke)', amount: { currency: 'SEK', minor: 80_000 } },
      { obligation: pi.obligations[1]!, name: 'Kit assembly (smoke)', amount: { currency: 'SEK', minor: 43_450 } },
    ],
    returnUrl: 'https://example.com/framvera/paypal/return',
    cancelUrl: 'https://example.com/framvera/paypal/cancel',
  });
  step('order.created', pi, { requestId: requestIdFor(pi.operationKey, 'create') }, t0);
  const approveUrl = pi.paypal.approveUrl;
  if (!approveUrl) throw new Error('PayPal returned no approval link.');
  console.log(`\nApprove as the sandbox buyer:\n${approveUrl}\n`);

  t0 = Date.now();
  if (auto) {
    const { approveWithSandboxBuyer } = await import('./sandboxBuyer.ts');
    const res = await approveWithSandboxBuyer(approveUrl, { debugDir: process.env.PAYPAL_SMOKE_DEBUG_DIR });
    trace.push({ step: 'buyer.approval', at: new Date().toISOString(), ms: Date.now() - t0, browserCompleted: res.completed, browserSteps: res.steps, finalHost: res.finalHost });
    if (!res.completed) throw new Error(`Automated sandbox approval failed: ${res.steps.at(-1)}`);
  }
  pi = await waitForApproval(pi, gw, auto ? 2 : 10);
  step('order.approved', pi, { verifiedBy: 'GET /v2/checkout/orders/{id}' }, t0);

  t0 = Date.now();
  pi = await capturePayment(pi, gw);
  step('capture', pi, { requestId: requestIdFor(pi.operationKey, 'capture') }, t0);
  if (pi.state !== 'CAPTURE_COMPLETED') throw new Error(`Capture ended in ${pi.state}.`);

  t0 = Date.now();
  const cap = await gw.getCapture(pi.paypal.captureId!);
  trace.push({ step: 'capture.get', at: cap.fetchedAt, ms: Date.now() - t0, ids: { captureId: cap.id }, status: cap.status, amount: cap.amount, invoiceMatches: cap.invoiceId === pi.operationKey, debugIds: cap.debugIds });
  console.log(`capture.get            ${cap.status} ${cap.amount.minor} ${cap.amount.currency}`);

  t0 = Date.now();
  const replay = await gw.capture(pi);
  trace.push({
    step: 'capture.replay',
    at: new Date().toISOString(),
    ms: Date.now() - t0,
    requestId: requestIdFor(pi.operationKey, 'capture'),
    replayed: replay.replayed,
    sameCapture: replay.captureId === pi.paypal.captureId,
    ids: { captureId: replay.captureId },
    debugIds: replay.debugIds.slice(-1),
  });
  console.log(`capture.replay         replayed=${replay.replayed} sameCapture=${replay.captureId === pi.paypal.captureId}`);

  t0 = Date.now();
  pi = await refundPayment(pi, gw, { currency: 'SEK', minor: 20_000 }, { note: 'Framvera smoke partial refund' });
  step('refund.partial', pi, { requestId: requestIdFor(pi.operationKey, 'refund:0'), requested: { currency: 'SEK', minor: 20_000 } }, t0);

  const refundId = pi.paypal.refunds[0]?.id;
  if (refundId) {
    t0 = Date.now();
    const rf = await gw.getRefund(refundId);
    trace.push({ step: 'refund.get', at: rf.fetchedAt, ms: Date.now() - t0, ids: { refundId: rf.id }, status: rf.status, amount: rf.amount, debugIds: rf.debugIds });
    console.log(`refund.get             ${rf.status} ${rf.amount.minor} ${rf.amount.currency}`);
  }

  t0 = Date.now();
  pi = await reconcile(pi, gw);
  step('order.get.final', pi, { verifiedBy: 'GET /v2/checkout/orders/{id}', lastFetchedAt: pi.paypal.lastFetchedAt }, t0);

  t0 = Date.now();
  const cap2 = await gw.getCapture(pi.paypal.captureId!);
  trace.push({ step: 'capture.get.final', at: cap2.fetchedAt, ms: Date.now() - t0, ids: { captureId: cap2.id }, status: cap2.status, amount: cap2.amount, debugIds: cap2.debugIds });
  console.log(`capture.get.final      ${cap2.status}`);
  write('ok');
}

main().catch((e) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(msg);
  try {
    write('failed', msg);
  } catch (w) {
    console.error((w as Error).message);
  }
  process.exitCode = 1;
});
