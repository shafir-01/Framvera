/**
 * Probes what this sandbox app can actually do, against live PayPal sandbox:
 *  1. card payment_source on order creation (capture with no buyer redirect)
 *  2. one order with two purchase units, approved and captured, to observe per-unit results
 *  3. registered webhooks
 * Writes a redacted report to evidence/paypal-capabilities.json and cleans up with refunds.
 *
 *   npx tsx packages/paypal/src/probe.ts [--auto]
 */
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SANDBOX_BASE_URL, TokenCache } from './adapter.ts';
import { requestIdFor, type Step } from './gateway.ts';
import { toPayPalAmount } from './money.ts';
import { approveLink, parseUnits } from './parse.ts';
import { assertNoSecrets, redactTrace } from './redact.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));
const auto = process.argv.includes('--auto');
const env = process.env;
const tokens = new TokenCache(SANDBOX_BASE_URL, env.PAYPAL_CLIENT_ID ?? '', env.PAYPAL_CLIENT_SECRET ?? '');
const run = randomUUID();
const report: Record<string, any> = { kind: 'paypal-sandbox-capabilities', source: 'paypal-sandbox', environment: SANDBOX_BASE_URL, startedAt: new Date().toISOString() };

async function call(method: 'GET' | 'POST', path: string, body?: unknown, key?: [string, Step]): Promise<{ status: number; json: any; debugId?: string }> {
  const t = await tokens.get();
  const headers: Record<string, string> = { Authorization: `Bearer ${t.value}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (method === 'POST') headers['PayPal-Request-Id'] = requestIdFor(`${run}:${key?.[0] ?? path}`, key?.[1] ?? 'create');
  const res = await fetch(`${SANDBOX_BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json, debugId: res.headers.get('paypal-debug-id') ?? json.debug_id };
}

const issueOf = (j: any) => j?.details?.[0]?.issue ?? j?.name;
const sek = (minor: number) => toPayPalAmount({ currency: 'SEK', minor });

async function refundAll(captureIds: string[]): Promise<any[]> {
  const out = [];
  for (const [i, id] of captureIds.entries()) {
    const r = await call('POST', `/v2/payments/captures/${id}/refund`, {}, [id, `refund:${i}`]);
    out.push({ captureId: id, http: r.status, refundId: r.json.id, status: r.json.status, issue: r.status >= 400 ? issueOf(r.json) : undefined, debugId: r.debugId });
  }
  return out;
}

async function probeCard() {
  const r = await call(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'probe-card', invoice_id: `probe-card-${run}`, amount: sek(1000) }],
      payment_source: { card: { name: 'Framvera Probe', number: '4012000033330026', expiry: '2030-12', security_code: '123' } },
    },
    ['card', 'create'],
  );
  const units = r.status < 300 ? parseUnits(r.json) : [];
  const caps = units.flatMap((u) => u.captures);
  const result: Record<string, any> = {
    http: r.status,
    orderId: r.json.id,
    orderStatus: r.json.status,
    issue: r.status >= 400 ? issueOf(r.json) : undefined,
    captures: caps.map((c) => ({ id: c.id, status: c.status, amount: c.amount })),
    payerActionLink: Boolean(approveLink(r.json)),
    debugId: r.debugId,
  };
  if (r.json.status === 'APPROVED' && !caps.length) {
    const c = await call('POST', `/v2/checkout/orders/${r.json.id}/capture`, {}, ['card', 'capture']);
    const cc = parseUnits(c.json).flatMap((u) => u.captures);
    result.capture = { http: c.status, orderStatus: c.json.status, issue: c.status >= 400 ? issueOf(c.json) : undefined, captures: cc.map((x) => ({ id: x.id, status: x.status, amount: x.amount })), debugId: c.debugId };
    caps.push(...cc);
  }
  const done = caps.filter((c) => c.status === 'COMPLETED').map((c) => c.id);
  if (done.length) result.cleanupRefunds = await refundAll(done);
  result.available = done.length > 0;
  return result;
}

async function probeMultiUnit() {
  const r = await call(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        { reference_id: 'probe-obl-a', invoice_id: `probe-a-${run}`, description: 'Probe unit A', amount: sek(700) },
        {
          reference_id: 'probe-obl-b',
          invoice_id: `probe-b-${run}`,
          description: 'Probe unit B',
          amount: sek(550),
          ...(env.PAYPAL_SECOND_PAYEE_MERCHANT_ID ? { payee: { merchant_id: env.PAYPAL_SECOND_PAYEE_MERCHANT_ID } } : {}),
        },
      ],
      payment_source: {
        paypal: { experience_context: { brand_name: 'Framvera', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: 'https://example.com/framvera/paypal/return', cancel_url: 'https://example.com/framvera/paypal/cancel' } },
      },
    },
    ['multi', 'create'],
  );
  const created = parseUnits(r.json);
  const result: Record<string, any> = {
    create: {
      http: r.status,
      orderId: r.json.id,
      orderStatus: r.json.status,
      issue: r.status >= 400 ? issueOf(r.json) : undefined,
      units: created.map((u) => ({ referenceId: u.referenceId, amount: u.amount, payeeAssignedByPayPal: Boolean(u.payeeMerchantId) })),
      distinctPayees: new Set(created.map((u) => u.payeeMerchantId)).size,
      secondPayeeRequested: Boolean(env.PAYPAL_SECOND_PAYEE_MERCHANT_ID),
      debugId: r.debugId,
    },
  };
  const link = approveLink(r.json);
  if (r.status >= 300 || !link || !auto) return result;

  const { approveWithSandboxBuyer } = await import('./sandboxBuyer.ts');
  const approval = await approveWithSandboxBuyer(link, { debugDir: env.PAYPAL_SMOKE_DEBUG_DIR });
  result.approval = { browserCompleted: approval.completed, steps: approval.steps };
  let order = await call('GET', `/v2/checkout/orders/${r.json.id}`);
  for (let i = 0; i < 12 && order.json.status !== 'APPROVED'; i++) {
    await new Promise((s) => setTimeout(s, 5000));
    order = await call('GET', `/v2/checkout/orders/${r.json.id}`);
  }
  result.approvedStatus = order.json.status;
  if (order.json.status !== 'APPROVED') return result;

  const c = await call('POST', `/v2/checkout/orders/${r.json.id}/capture`, {}, ['multi', 'capture']);
  const units = parseUnits(c.json);
  result.capture = {
    http: c.status,
    orderStatus: c.json.status,
    issue: c.status >= 400 ? issueOf(c.json) : undefined,
    units: units.map((u) => ({ referenceId: u.referenceId, captures: u.captures.map((x) => ({ id: x.id, status: x.status, amount: x.amount })) })),
    debugId: c.debugId,
  };
  const done = units.flatMap((u) => u.captures).filter((x) => x.status === 'COMPLETED').map((x) => x.id);
  if (done.length) result.cleanupRefunds = await refundAll(done);
  return result;
}

async function probeWebhooks() {
  const r = await call('GET', '/v1/notifications/webhooks');
  const hooks: any[] = r.json.webhooks ?? [];
  return {
    http: r.status,
    count: hooks.length,
    webhooks: hooks.map((h) => ({ id: h.id, host: safeHost(h.url), path: safePath(h.url), eventTypes: (h.event_types ?? []).map((e: any) => e.name) })),
    debugId: r.debugId,
  };
}

const safeHost = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return undefined;
  }
};
const safePath = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return undefined;
  }
};

async function main() {
  for (const [name, fn] of [
    ['cardPaymentSource', probeCard],
    ['multiplePurchaseUnits', probeMultiUnit],
    ['webhooks', probeWebhooks],
  ] as const) {
    try {
      report[name] = await fn();
    } catch (e) {
      report[name] = { error: `${(e as Error).name}: ${(e as Error).message}` };
    }
    console.log(name, JSON.stringify(redactTrace(report[name])).slice(0, 600));
  }
  report.finishedAt = new Date().toISOString();
  const text = JSON.stringify(redactTrace(report), null, 2);
  assertNoSecrets(text);
  if (text.includes('4012000033330026')) throw new Error('Refusing to write a card number.');
  writeFileSync(resolve(ROOT, 'evidence/paypal-capabilities.json'), `${text}\n`);
  console.log('written: evidence/paypal-capabilities.json');
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
