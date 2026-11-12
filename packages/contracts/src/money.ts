import type { Currency, Money } from './types.ts';

function assertMinor(n: number, what = 'minor'): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${n}`);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch: ${a.currency} and ${b.currency}`);
}

export function money(currency: Currency, minor: number): Money {
  assertMinor(minor);
  return { currency, minor };
}

/** Whole or decimal kronor to an exact SEK amount. For literals only; totals stay in minor units. */
export function sek(kr: number): Money {
  return money('SEK', Math.round(kr * 100));
}

export function zero(currency: Currency): Money {
  return { currency, minor: 0 };
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function sub(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.currency, a.minor - b.minor);
}

/** Unit price times an integer quantity. */
export function mul(m: Money, qty: number): Money {
  if (!Number.isSafeInteger(qty)) throw new RangeError(`qty must be an integer, got ${qty}`);
  return money(m.currency, m.minor * qty);
}

/** m * num / den, rounded half away from zero to whole minor units. */
export function scale(m: Money, num: number, den = 1): Money {
  if (den === 0) throw new RangeError('den must not be 0');
  const exact = (m.minor * num) / den;
  const r = Math.sign(exact) * Math.round(Math.abs(exact));
  return money(m.currency, r === 0 ? 0 : r);
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function eq(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

export function minMoney(a: Money, b: Money): Money {
  return cmp(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return cmp(a, b) >= 0 ? a : b;
}

export function sumMoney(list: readonly Money[], currency: Currency): Money {
  let total = 0;
  for (const m of list) {
    if (m.currency !== currency) throw new Error(`Currency mismatch: ${m.currency} in a ${currency} sum`);
    total += m.minor;
    assertMinor(total, 'sum');
  }
  return money(currency, total);
}

/**
 * Split an amount by integer weights so the parts sum exactly to the whole
 * (largest remainder; ties go to the earlier weight).
 */
export function allocate(m: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError('weights must be non-negative');
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (totalW === 0) throw new RangeError('weights must not all be 0');
  const sign = m.minor < 0 ? -1 : 1;
  const abs = Math.abs(m.minor);
  const raw = weights.map((w) => (abs * w) / totalW);
  const base = raw.map(Math.floor);
  let rest = abs - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    base[i] = (base[i] ?? 0) + 1;
    rest--;
  }
  return base.map((b) => money(m.currency, sign * b === 0 ? 0 : sign * b));
}

function group(n: number, sep: string): string {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += sep;
    out += s[i];
  }
  return out;
}

/** "54 300 kr", "1 234,50 kr", "$1,234.50", "€1,234.50". */
export function fmt(m: Money): string {
  const neg = m.minor < 0;
  const abs = Math.abs(m.minor);
  const major = Math.floor(abs / 100);
  const cents = abs % 100;
  const sign = neg ? '-' : '';
  if (m.currency === 'SEK') {
    const dec = cents === 0 ? '' : ',' + String(cents).padStart(2, '0');
    return `${sign}${group(major, ' ')}${dec} kr`;
  }
  const symbol = m.currency === 'USD' ? '$' : '€';
  return `${sign}${symbol}${group(major, ',')}.${String(cents).padStart(2, '0')}`;
}

/** Parse "55 000 kr", "55,000 SEK", "55000", "55k", "54 300,50 kr" into SEK. Returns null when unclear. */
export function parseKr(text: string): Money | null {
  const t = text.trim().toLowerCase().replace(/ /g, ' ');
  const k = /^(\d+(?:[.,]\d+)?)\s*k(?:r|sek)?\b/.exec(t);
  if (k?.[1]) return sek(Number(k[1].replace(',', '.')) * 1000);
  const m = /^(\d{1,3}(?:[ ,.]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(kr|sek|kronor)?$/.exec(t);
  if (!m?.[1]) return null;
  const whole = Number(m[1].replace(/[ ,.]/g, ''));
  const dec = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return money('SEK', whole * 100 + dec);
}
