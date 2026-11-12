import type { Concession, Currency, Iso, Money, World } from '@framvera/contracts';

const TZ = 'Europe/Stockholm';

function group(n: number): string {
  const s = Math.abs(Math.trunc(n)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const SYMBOL: Record<Currency, { pre?: string; post?: string }> = {
  SEK: { post: ' kr' },
  USD: { pre: '$' },
  EUR: { pre: '€' },
};

export function money(m: Money | undefined, opts: { sign?: boolean } = {}): string {
  if (!m) return '–';
  const neg = m.minor < 0;
  const whole = Math.trunc(Math.abs(m.minor) / 100);
  const frac = Math.abs(m.minor) % 100;
  const body = group(whole) + (frac ? ',' + String(frac).padStart(2, '0') : '');
  const sym = SYMBOL[m.currency] ?? { post: ' ' + m.currency };
  const sign = neg ? '−' : opts.sign ? '+' : '';
  return `${sign}${sym.pre ?? ''}${body}${sym.post ?? ''}`;
}

export function moneyMinor(minor: number, currency: Currency, opts: { sign?: boolean } = {}): string {
  return money({ currency, minor }, opts);
}

export function unitPrice(minor: number, currency: Currency, unit: string): string {
  return `${money({ currency, minor })} per ${singular(unit)}`;
}

export function singular(unit: string): string {
  return unit.endsWith('s') ? unit.slice(0, -1) : unit;
}

const dayTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dayOnly = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const timeOnly = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const weekdayTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const full = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function valid(iso: Iso | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const when = (iso?: Iso) => (valid(iso) ? dayTime.format(valid(iso)).replace(',', '') : '–');
export const day = (iso?: Iso) => (valid(iso) ? dayOnly.format(valid(iso)) : '–');
export const clock = (iso?: Iso) => (valid(iso) ? timeOnly.format(valid(iso)) : '–');
export const weekday = (iso?: Iso) => (valid(iso) ? weekdayTime.format(valid(iso)).replace(',', '') : '–');
export const stamp = (iso?: Iso) => (valid(iso) ? full.format(valid(iso)) : '–');

export function hours(n: number): string {
  if (n === 0) return '0 h';
  const h = Math.floor(Math.abs(n));
  const m = Math.round((Math.abs(n) - h) * 60);
  const s = n < 0 ? '−' : '';
  return m ? `${s}${h} h ${m} min` : `${s}${h} h`;
}

export function diffHours(a: Iso, b: Iso): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

export function shortHash(h?: string, n = 10): string {
  if (!h) return '–';
  return h.length > n + 2 ? `${h.slice(0, n)}…` : h;
}

export function count(n: number, word: string, plural = word + 's'): string {
  return `${n} ${n === 1 ? word : plural}`;
}

/** Stockholm wall-clock time (date + HH:MM) to UTC ISO. */
export function stockholmToIso(date: string, time: string): Iso {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y!, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  const offset = tzOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60_000).toISOString();
}

export function isoToStockholm(iso: Iso): { date: string; time: string } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

function tzOffsetMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return (asUtc - d.getTime()) / 60_000;
}

const FIELD_WORDS: Record<string, string> = {
  unitPrice: 'price',
  windowEnd: 'finish time',
  windowStart: 'start time',
  capacity: 'capacity',
  minQty: 'minimum order',
  setupFee: 'setup fee',
  joint: 'joint run',
};

export function fieldWord(f: string): string {
  return FIELD_WORDS[f] ?? f;
}

function looksIso(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

export function concessionValue(v: number | string, field: string, currency: Currency, unit = 'units'): string {
  if (looksIso(v)) return weekday(v);
  if (typeof v === 'number') {
    if (field === 'unitPrice') return `${money({ currency, minor: v })} per ${singular(unit)}`;
    if (field === 'setupFee' || field === 'budget') return money({ currency, minor: v });
    if (field === 'capacity' || field === 'minQty') return `${group(v)} ${unit}`;
    return String(v);
  }
  return v;
}

/** A plain sentence for a proposed change, e.g. "Kista Pack finishes assembly at Thu 21:00 instead of Thu 18:00". */
export function concessionSentence(c: Concession, world: World | undefined): string {
  const currency = world?.currency ?? 'SEK';
  if (c.target.kind === 'intent') {
    const f = c.target.field;
    const to = concessionValue(c.to, f, currency);
    const from = concessionValue(c.from, f, currency);
    return f === 'deadline' ? `Move your deadline to ${to} (was ${from})` : `Raise your budget to ${to} (was ${from})`;
  }
  const { offer: offerId, field } = c.target;
  const offer = world?.offers.find((o) => o.id === offerId);
  const actor = world?.actors.find((a) => a.id === offer?.actor)?.name ?? offer?.actor ?? offerId;
  const stage = world?.stages.find((s) => s.id === offer?.stage);
  const unit = stage?.unit ?? 'units';
  const to = concessionValue(c.to, field, currency, unit);
  const from = concessionValue(c.from, field, currency, unit);
  switch (field) {
    case 'windowEnd':
      return `${actor} works until ${to} instead of ${from}`;
    case 'windowStart':
      return `${actor} starts at ${to} instead of ${from}`;
    case 'unitPrice':
      return `${actor} lowers its price to ${to} (was ${from})`;
    case 'capacity':
      return `${actor} raises capacity to ${to} (was ${from})`;
    case 'minQty':
      return `${actor} accepts a minimum order of ${to} (was ${from})`;
    case 'setupFee':
      return `${actor} lowers its setup fee to ${to} (was ${from})`;
    case 'joint':
      if (typeof c.to === 'string' && c.to.startsWith('joint:')) return c.rationale || `${actor} joins a shared run`;
      return `${actor} joins a shared run: ${to}`;
    default:
      return `${actor} changes ${fieldWord(field)} from ${from} to ${to}`;
  }
}
