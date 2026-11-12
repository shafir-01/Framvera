import { ApiError, Client, Environment, OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';
import { camelize } from './body.ts';
import { PayPalGateway, type PayPalPort, type RawResult } from './core.ts';
import { PayPalApiError, errorFromResponse } from './errors.ts';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const LIVE_BASE_URL = 'https://api-m.paypal.com';

type Env = Record<string, string | undefined>;

export interface AdapterOptions {
  env?: Env;
  /** Second, explicit opt-in besides PAYPAL_ENV=live. */
  allowLive?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Sandbox unless PAYPAL_ENV=live and the caller passed allowLive. */
export function resolvePayPalEnvironment(env: Env, allowLive = false): { mode: 'sandbox' | 'live'; baseUrl: string } {
  const mode = (env.PAYPAL_ENV ?? 'sandbox').trim().toLowerCase() || 'sandbox';
  if (mode === 'sandbox') return { mode, baseUrl: SANDBOX_BASE_URL };
  if (mode === 'live') {
    if (!allowLive) throw new PayPalApiError('config', 'PAYPAL_ENV=live is refused without the explicit allowLive option.');
    return { mode, baseUrl: LIVE_BASE_URL };
  }
  throw new PayPalApiError('config', `Unknown PAYPAL_ENV "${mode}". Use sandbox.`);
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** OAuth2 client-credentials token, cached until two minutes before expiry, one request in flight at a time. */
export class TokenCache {
  fetches = 0;
  #cached?: CachedToken;
  #flight?: Promise<CachedToken>;
  readonly #baseUrl: string;
  readonly #basic: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, clientId: string, clientSecret: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now, timeoutMs = 20000) {
    this.#baseUrl = baseUrl;
    this.#basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    this.#fetch = fetchFn;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  async get(): Promise<CachedToken> {
    if (this.#cached && this.#cached.expiresAt - 120_000 > this.#now()) return this.#cached;
    this.#flight ??= this.request().finally(() => (this.#flight = undefined));
    return this.#flight;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  private async request(): Promise<CachedToken> {
    this.fetches++;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.#basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new PayPalApiError('network', `PayPal token request failed: ${(e as Error).name}`);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : {};
    if (!res.ok) throw errorFromResponse(res.status, json, res.headers.get('paypal-debug-id') ?? undefined);
    const token = (json as any).access_token;
    const expiresIn = Number((json as any).expires_in);
    if (typeof token !== 'string' || !Number.isFinite(expiresIn)) throw new PayPalApiError('auth', 'PayPal token response missing access_token or expires_in.');
    this.#cached = { value: token, expiresAt: this.#now() + expiresIn * 1000 };
    return this.#cached;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

const PREFER = 'return=representation';

/** PayPal Orders v2 and Payments v2 through the official server SDK; webhook verification over plain HTTPS. */
class SdkPort implements PayPalPort {
  private readonly orders: OrdersController;
  private readonly payments: PaymentsController;

  constructor(
    private readonly baseUrl: string,
    mode: 'sandbox' | 'live',
    private readonly tokens: TokenCache,
    clientId: string,
    clientSecret: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch,
  ) {
    const client = new Client({
      environment: mode === 'live' ? Environment.Production : Environment.Sandbox,
      timeout: 0,
      httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
        oAuthTokenProvider: async () => {
          const t = await this.tokens.get();
          return { accessToken: t.value, tokenType: 'Bearer', expiry: BigInt(Math.floor((t.expiresAt - 60_000) / 1000)) };
        },
      },
    });
    this.orders = new OrdersController(client);
    this.payments = new PaymentsController(client);
  }

  private async run(call: (signal: AbortSignal) => Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }>): Promise<RawResult> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await call(signal);
      const text = typeof res.body === 'string' ? res.body : '';
      return { status: res.statusCode, json: text ? safeJson(text) : {}, debugId: headerValue(res.headers, 'paypal-debug-id') };
    } catch (e) {
      if (e instanceof ApiError) {
        const text = typeof e.body === 'string' ? e.body : '';
        if (e.statusCode === 401) this.tokens.invalidate();
        throw errorFromResponse(e.statusCode, text ? safeJson(text) : {}, headerValue(e.headers, 'paypal-debug-id'), headerValue(e.headers, 'retry-after'));
      }
      if (e instanceof PayPalApiError) throw e;
      if (signal.aborted) throw new PayPalApiError('timeout', `PayPal call exceeded ${this.timeoutMs} ms; outcome unknown.`);
      throw new PayPalApiError('network', `PayPal call failed before a response: ${(e as Error).name}: ${(e as Error).message}`);
    }
  }

  createOrder(body: Record<string, unknown>, requestId: string) {
    return this.run((abortSignal) => this.orders.createOrder({ body: camelize(body), paypalRequestId: requestId, prefer: PREFER }, { abortSignal }));
  }
  getOrder(id: string) {
    return this.run((abortSignal) => this.orders.getOrder({ id }, { abortSignal }));
  }
  captureOrder(id: string, requestId: string) {
    return this.run((abortSignal) => this.orders.captureOrder({ id, paypalRequestId: requestId, prefer: PREFER }, { abortSignal }));
  }
  authorizeOrder(id: string, requestId: string) {
    return this.run((abortSignal) => this.orders.authorizeOrder({ id, paypalRequestId: requestId, prefer: PREFER }, { abortSignal }));
  }
  captureAuthorization(authorizationId: string, requestId: string, body: Record<string, unknown>) {
    return this.run((abortSignal) =>
      this.payments.captureAuthorizedPayment({ authorizationId, paypalRequestId: requestId, prefer: PREFER, body: camelize(body) }, { abortSignal }),
    );
  }
  voidAuthorization(authorizationId: string, requestId: string) {
    return this.run((abortSignal) => this.payments.voidPayment({ authorizationId, paypalRequestId: requestId, prefer: PREFER }, { abortSignal }));
  }
  refundCapture(captureId: string, requestId: string, body: Record<string, unknown>) {
    return this.run((abortSignal) =>
      this.payments.refundCapturedPayment({ captureId, paypalRequestId: requestId, prefer: PREFER, body: camelize(body) }, { abortSignal }),
    );
  }
  getCapture(captureId: string) {
    return this.run((abortSignal) => this.payments.getCapturedPayment({ captureId }, { abortSignal }));
  }
  getRefund(refundId: string) {
    return this.run((abortSignal) => this.payments.getRefund({ refundId }, { abortSignal }));
  }

  async verifyWebhookSignature(requestBody: string): Promise<RawResult> {
    const token = await this.tokens.get();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
        body: requestBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PayPalApiError('network', `Webhook verification request failed: ${(e as Error).name}`);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : {};
    const debugId = res.headers.get('paypal-debug-id') ?? undefined;
    if (!res.ok) throw errorFromResponse(res.status, json, debugId);
    return { status: res.status, json, debugId };
  }
}

/** The authoritative PayPal integration. Reads credentials from process.env only and never logs them. */
export class PayPalSandboxAdapter extends PayPalGateway {
  readonly mode: 'sandbox' | 'live';
  readonly baseUrl: string;
  readonly tokens: TokenCache;

  constructor(opts: AdapterOptions = {}) {
    const env = opts.env ?? process.env;
    const { mode, baseUrl } = resolvePayPalEnvironment(env, opts.allowLive);
    if (mode === 'live') {
      throw new PayPalApiError('config', 'Live PayPal is gated off: payment records are typed sandbox-only, so a live payment could not be labelled truthfully.');
    }
    const clientId = env.PAYPAL_CLIENT_ID;
    const clientSecret = env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new PayPalApiError('config', 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set on the server.');
    const timeoutMs = opts.timeoutMs ?? 20000;
    const fetchFn = opts.fetch ?? fetch;
    const tokens = new TokenCache(baseUrl, clientId, clientSecret, fetchFn, opts.now, timeoutMs);
    super('paypal-sandbox', new SdkPort(baseUrl, mode, tokens, clientId, clientSecret, timeoutMs, fetchFn), {
      webhookId: env.PAYPAL_WEBHOOK_ID || undefined,
      defaults: { returnUrl: env.PAYPAL_RETURN_URL || undefined, cancelUrl: env.PAYPAL_CANCEL_URL || undefined },
    });
    this.mode = mode;
    this.baseUrl = baseUrl;
    this.tokens = tokens;
  }

  static configured(env: Env = process.env): boolean {
    return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  }

  toJSON() {
    return { kind: this.kind, mode: this.mode, baseUrl: this.baseUrl, webhookConfigured: Boolean(this.webhookId) };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `PayPalSandboxAdapter ${JSON.stringify(this.toJSON())}`;
  }
}
