import type { Currency, Money } from '@framvera/contracts';

/** Decimal places PayPal expects per currency (developer.paypal.com/api/rest/reference/currency-codes). */
const DECIMALS: Record<string, number> = { SEK: 2, USD: 2, EUR: 2, HUF: 0, JPY: 0, TWD: 0 };

export const PAYPAL_CURRENCIES: readonly Currency[] = ['SEK', 'USD', 'EUR'];

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export function decimalsFor(currency: string): number {
  const d = DECIMALS[currency];
  if (d === undefined || !(PAYPAL_CURRENCIES as readonly string[]).includes(currency)) {
    throw new MoneyError(`Currency ${currency} is not enabled for PayPal execution.`);
  }
  return d;
}

export function assertMinor(m: Money, opts: { positive?: boolean } = {}): void {
  if (!Number.isSafeInteger(m.minor)) throw new MoneyError(`Amount must be an integer number of minor units, got ${m.minor}.`);
  if (m.minor < 0 || (opts.positive && m.minor === 0)) throw new MoneyError(`Amount must be ${opts.positive ? 'positive' : 'non-negative'}, got ${m.minor}.`);
  decimalsFor(m.currency);
}

/** Exact minor units to PayPal's decimal string, without floating point. */
export function toPayPalAmount(m: Money): PayPalAmount {
  assertMinor(m);
  const d = decimalsFor(m.currency);
  const digits = String(m.minor);
  if (d === 0) return { currency_code: m.currency, value: digits };
  const padded = digits.padStart(d + 1, '0');
  return { currency_code: m.currency, value: `${padded.slice(0, -d)}.${padded.slice(-d)}` };
}

/** PayPal's decimal string to exact minor units. Rejects precision that minor units cannot hold. */
export function fromPayPalAmount(a: PayPalAmount): Money {
  const d = decimalsFor(a.currency_code);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(a.value);
  if (!match) throw new MoneyError(`Unparseable PayPal amount "${a.value}".`);
  const whole = match[1]!;
  const frac = match[2] ?? '';
  if (frac.length > d && /[^0]/.test(frac.slice(d))) throw new MoneyError(`Amount "${a.value}" has more precision than ${a.currency_code} allows.`);
  const minor = Number(whole + frac.slice(0, d).padEnd(d, '0'));
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`Amount "${a.value}" exceeds safe integer range.`);
  return { currency: a.currency_code as Currency, minor };
}

export function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

export function sumMinor(list: Money[], currency: Currency): number {
  let total = 0;
  for (const m of list) {
    if (m.currency !== currency) throw new MoneyError(`Mixed currencies: expected ${currency}, got ${m.currency}.`);
    total += m.minor;
  }
  if (!Number.isSafeInteger(total)) throw new MoneyError('Sum exceeds safe integer range.');
  return total;
}
