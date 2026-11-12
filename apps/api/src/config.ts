export interface Config {
  port: number;
  dataDir: string;
  aiEnabled: boolean;
  dailyAiCalls: number;
  approvalSecret: string;
  webDist: string;
  rateLimitPerMin: number;
  heavyLimitPerMin: number;
  paypalConfigured: boolean;
  /** The PayPal REST client id. Public by design (the browser SDK loads with it); the secret never leaves the server. */
  paypalClientId: string;
  aiKeyConfigured: boolean;
}

const flag = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d);

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  return {
    port: int(env.PORT, 8790),
    dataDir: env.FRAMVERA_DATA || './.data',
    aiEnabled: flag(env.FRAMVERA_AI_ENABLED, true),
    dailyAiCalls: int(env.FRAMVERA_DAILY_AI_CALLS, 200),
    approvalSecret: env.FRAMVERA_APPROVAL_SECRET || '',
    webDist: env.FRAMVERA_WEB_DIST || '',
    rateLimitPerMin: int(env.FRAMVERA_RATE_LIMIT, 240),
    heavyLimitPerMin: int(env.FRAMVERA_HEAVY_LIMIT, 40),
    paypalConfigured: Boolean(env.PAYPAL_CLIENT_ID && (env.PAYPAL_CLIENT_SECRET || env.PAYPAL_SECRET)),
    paypalClientId: env.PAYPAL_CLIENT_ID && (env.PAYPAL_CLIENT_SECRET || env.PAYPAL_SECRET) ? env.PAYPAL_CLIENT_ID : '',
    aiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY),
    ...overrides,
  };
}
