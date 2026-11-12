import { inspect } from 'node:util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FakeGateway,
  MoneyError,
  OrderBuildError,
  PayPalSandboxAdapter,
  TokenCache,
  assertNoSecrets,
  buildOrderBody,
  fromPayPalAmount,
  newPaymentIntent,
  redactTrace,
  requestIdFor,
  resolvePayPalEnvironment,
  toPayPalAmount,
} from '../src/index.ts';
import { camelize } from '../src/body.ts';

describe('exact money conversion', () => {
  it('converts minor units to PayPal decimals and back without loss', () => {
    expect(toPayPalAmount({ currency: 'SEK', minor: 5_430_000 })).toEqual({ currency_code: 'SEK', value: '54300.00' });
    expect(toPayPalAmount({ currency: 'SEK', minor: 5 })).toEqual({ currency_code: 'SEK', value: '0.05' });
    expect(fromPayPalAmount({ currency_code: 'EUR', value: '12.3' })).toEqual({ currency: 'EUR', minor: 1230 });
    expect(fromPayPalAmount({ currency_code: 'USD', value: '7' })).toEqual({ currency: 'USD', minor: 700 });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_000_000_000_000 }), fc.constantFrom('SEK', 'USD', 'EUR'), (minor, currency) => {
        const m = { currency: currency as 'SEK', minor };
        expect(fromPayPalAmount(toPayPalAmount(m))).toEqual(m);
      }),
    );
  });

  it('rejects fractional minor units, excess precision and unsupported currencies', () => {
    expect(() => toPayPalAmount({ currency: 'SEK', minor: 10.5 })).toThrow(MoneyError);
    expect(() => fromPayPalAmount({ currency_code: 'SEK', value: '1.005' })).toThrow(MoneyError);
    expect(fromPayPalAmount({ currency_code: 'SEK', value: '1.500' })).toEqual({ currency: 'SEK', minor: 150 });
    expect(() => toPayPalAmount({ currency: 'GBP' as 'SEK', minor: 100 })).toThrow(/not enabled/);
    expect(() => fromPayPalAmount({ currency_code: 'SEK', value: '-1.00' })).toThrow(MoneyError);
  });
});

describe('request ids', () => {
  it('are deterministic per operation and step, distinct across steps, UUID-shaped', () => {
    const k = 'op-7f3a';
    expect(requestIdFor(k, 'capture')).toBe(requestIdFor(k, 'capture'));
    const all = ['create', 'capture', 'authorize', 'void', 'refund:0', 'refund:1'].map((s) => requestIdFor(k, s as 'create'));
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestIdFor('other', 'capture')).not.toBe(requestIdFor(k, 'capture'));
    expect(() => requestIdFor('', 'create')).toThrow();
  });
});

describe('order body', () => {
  const pi = newPaymentIntent({ agreement: 'agr_9', obligations: ['obl_a'], payee: 'act_x', amount: { currency: 'SEK', minor: 99_900 } });

  it('uses PayPal wire format, the obligation as reference, and sets no payee unless given a valid one', () => {
    const body = buildOrderBody(pi) as any;
    const unit = body.purchase_units[0];
    expect(body.intent).toBe('CAPTURE');
    expect(unit.reference_id).toBe('obl_a');
    expect(unit.amount).toEqual({ currency_code: 'SEK', value: '999.00', breakdown: { item_total: { currency_code: 'SEK', value: '999.00' } } });
    expect(unit.items[0]).toMatchObject({ quantity: '1', sku: 'obl_a', unit_amount: { value: '999.00' } });
    expect(unit.payee).toBeUndefined();
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe('NO_SHIPPING');
    expect((buildOrderBody(pi, { payee: { merchantId: 'ABCDEFGH23456' } }) as any).purchase_units[0].payee).toEqual({ merchant_id: 'ABCDEFGH23456' });
    expect(() => buildOrderBody(pi, { payee: { merchantId: 'act_kista_pack' } })).toThrow(OrderBuildError);
    expect(() => buildOrderBody(pi, { payee: { email: 'not-an-email' } })).toThrow(OrderBuildError);
  });

  it('maps wire keys to the SDK model keys', () => {
    expect(camelize({ purchase_units: [{ reference_id: 'r', amount: { currency_code: 'SEK', value: '1.00' } }], payment_source: { paypal: { experience_context: { user_action: 'PAY_NOW' } } } })).toEqual({
      purchaseUnits: [{ referenceId: 'r', amount: { currencyCode: 'SEK', value: '1.00' } }],
      paymentSource: { paypal: { experienceContext: { userAction: 'PAY_NOW' } } },
    });
  });
});

describe('environment and credentials', () => {
  it('uses the sandbox base URL by default and refuses live without the explicit flag', () => {
    expect(resolvePayPalEnvironment({}).baseUrl).toBe('https://api-m.sandbox.paypal.com');
    expect(resolvePayPalEnvironment({ PAYPAL_ENV: 'sandbox' }).mode).toBe('sandbox');
    expect(() => resolvePayPalEnvironment({ PAYPAL_ENV: 'live' })).toThrow(/refused/);
    expect(resolvePayPalEnvironment({ PAYPAL_ENV: 'live' }, true).baseUrl).toBe('https://api-m.paypal.com');
    expect(() => resolvePayPalEnvironment({ PAYPAL_ENV: 'production' })).toThrow(/Unknown/);
    expect(() => new PayPalSandboxAdapter({ env: { PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' }, allowLive: true })).toThrow(/gated off/);
    expect(() => new PayPalSandboxAdapter({ env: {} })).toThrow(/must be set/);
  });

  it('never exposes credentials when the adapter is logged or serialised', () => {
    const secret = 'sk-test-secret-value-123456';
    const a = new PayPalSandboxAdapter({ env: { PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: secret } });
    expect(JSON.stringify(a)).not.toContain(secret);
    expect(inspect(a, { depth: 10 })).not.toContain(secret);
    expect(inspect(a.tokens, { depth: 10 })).not.toContain(secret);
  });

  it('caches the OAuth token, shares one request between concurrent callers and refreshes near expiry', async () => {
    let now = 1_000_000;
    let calls = 0;
    const fetchStub = (async (_url: string, init: RequestInit) => {
      calls++;
      expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
      expect(init.body).toBe('grant_type=client_credentials');
      return new Response(JSON.stringify({ access_token: `tok${calls}`, token_type: 'Bearer', expires_in: 600 }), { status: 200 });
    }) as typeof fetch;
    const cache = new TokenCache('https://api-m.sandbox.paypal.com', 'id', 'secret', fetchStub, () => now);
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a.value).toBe('tok1');
    expect(b.value).toBe('tok1');
    now += 400_000;
    expect((await cache.get()).value).toBe('tok1');
    now += 100_000;
    expect((await cache.get()).value).toBe('tok2');
    expect(calls).toBe(2);
  });
});

describe('evidence redaction', () => {
  it('drops personal data and refuses to write configured secrets', () => {
    const out = redactTrace({ orderId: 'X1', payer: { email_address: 'buyer@example.com', payer_id: 'P1' }, note: 'mail buyer@example.com', status: 'COMPLETED' });
    expect(JSON.stringify(out)).not.toContain('buyer@example.com');
    expect(out).toMatchObject({ orderId: 'X1', status: 'COMPLETED' });
    expect(() => assertNoSecrets('token A21AAabcdefghijklmnopqrstuvwxyz', {})).toThrow();
    expect(() => assertNoSecrets('contains hunter2-secret', { PAYPAL_CLIENT_SECRET: 'hunter2-secret' })).toThrow(/PAYPAL_CLIENT_SECRET/);
  });

  it('fake records are recognisable and the fake refuses to run outside tests unless labelled', () => {
    const prev = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => new FakeGateway()).toThrow(/only under tests/);
      expect(new FakeGateway({ offlineFallback: true }).kind).toBe('fake');
    } finally {
      process.env.VITEST = prev;
    }
  });
});
