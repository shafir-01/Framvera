export type FailureKind =
  | 'timeout'
  | 'network'
  | 'server'
  | 'accepted'
  | 'conflict'
  | 'rate-limit'
  | 'unprocessable'
  | 'bad-request'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'config';

/** Kinds where PayPal may or may not have executed a mutating call. */
const UNKNOWN_OUTCOME: ReadonlySet<FailureKind> = new Set(['timeout', 'network', 'server', 'accepted', 'conflict']);

export class PayPalApiError extends Error {
  readonly kind: FailureKind;
  readonly httpStatus?: number;
  readonly errorName?: string;
  readonly issue?: string;
  readonly debugId?: string;
  readonly retryAfterMs?: number;
  readonly body?: unknown;

  constructor(
    kind: FailureKind,
    message: string,
    extra: { httpStatus?: number; errorName?: string; issue?: string; debugId?: string; retryAfterMs?: number; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'PayPalApiError';
    this.kind = kind;
    Object.assign(this, extra);
  }

  get outcomeUnknown(): boolean {
    return UNKNOWN_OUTCOME.has(this.kind);
  }
}

export function kindForStatus(status: number): FailureKind {
  if (status === 202) return 'accepted';
  if (status === 400) return 'bad-request';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate-limit';
  return status >= 500 ? 'server' : 'bad-request';
}

/** Builds a typed error from a PayPal error body (REST or identity format). */
export function errorFromResponse(status: number, body: unknown, headerDebugId?: string, retryAfter?: string | null): PayPalApiError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const issue: string | undefined = b.details?.[0]?.issue ?? b.error;
  const errorName: string | undefined = b.name ?? b.error;
  const debugId: string | undefined = b.debug_id ?? headerDebugId;
  const description: string = b.details?.[0]?.description ?? b.message ?? b.error_description ?? `HTTP ${status}`;
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
  return new PayPalApiError(kindForStatus(status), `PayPal ${status} ${issue ?? errorName ?? ''}: ${description}`.replace(/\s+/g, ' ').trim(), {
    httpStatus: status,
    errorName,
    issue,
    debugId,
    retryAfterMs,
    body: redactErrorBody(b),
  });
}

function redactErrorBody(b: Record<string, any>): unknown {
  return {
    name: b.name ?? b.error,
    debug_id: b.debug_id,
    details: Array.isArray(b.details) ? b.details.map((d: any) => ({ issue: d.issue, field: d.field, description: d.description })) : undefined,
  };
}

/** Raised when a PayPal response contradicts the economic record (amount, currency, ids). */
export class PaymentInvariantError extends Error {
  readonly context: unknown;
  constructor(message: string, context?: unknown) {
    super(message);
    this.name = 'PaymentInvariantError';
    this.context = context;
  }
}
