const SENSITIVE_KEY =
  /^(email|email_address|password|secret|client_secret|access_token|token|authorization|payer|payer_id|payerid|name|given_name|surname|full_name|address|address_line_1|address_line_2|postal_code|phone|phone_number|national_number|birth_date|tax_info|card|number|security_code|cvv|expiry)$/i;
const SENSITIVE_PART = /(secret|password|access_?token|bearer)/i;

/** Second line of defence for evidence traces, which are built from explicit fields: personal data and credential keys are blanked, emails and tokens masked. */
export function redactTrace<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redactTrace) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k) || SENSITIVE_PART.test(k)) out[k] = '[redacted]';
      else out[k] = redactTrace(x);
    }
    return out as T;
  }
  if (typeof v === 'string') return v.replace(/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/gi, '[redacted-email]').replace(/A21AA[\w-]{20,}/g, '[redacted-token]') as T;
  return v;
}

/** Refuses to continue if any configured secret or sandbox login value appears in text bound for disk or logs. */
export function assertNoSecrets(text: string, env: Record<string, string | undefined> = process.env): void {
  const names = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_SANDBOX_BUYER_EMAIL', 'PAYPAL_SANDBOX_BUYER_PASSWORD', 'ANTHROPIC_API_KEY', 'FRAMVERA_ADMIN_TOKEN', 'FRAMVERA_APPROVAL_SECRET'];
  for (const n of names) {
    const v = env[n];
    if (v && v.length >= 6 && text.includes(v)) throw new Error(`Refusing to write output containing the value of ${n}.`);
  }
  if (/A21AA[\w-]{20,}/.test(text) || /Bearer\s+[\w-]{10,}/.test(text)) throw new Error('Refusing to write output containing an access token.');
}
