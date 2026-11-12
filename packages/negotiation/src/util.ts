import { fmt, hashTerms } from '@framvera/contracts';
import type { Concession, Currency, Iso, Money, NegotiableField, Offer, World } from '@framvera/contracts';

export const HOUR = 3_600_000;

export function money(currency: Currency, minor: number): Money {
  return { currency, minor: Math.round(minor) };
}

export const fmtMoney = fmt;

const stockholm = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function fmtTime(iso: Iso): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : stockholm.format(d).replace(',', '');
}

export const sha256 = hashTerms;

export function termsOf(c: Concession) {
  return { target: c.target, from: c.from, to: c.to };
}

export function targetKey(c: Concession): string {
  return c.target.kind === 'offer' ? `offer:${c.target.offer}:${c.target.field}` : `intent:${c.target.field}`;
}

/** Identity of a concession across interventions: same target, same requested value. */
export function concessionKey(c: Concession): string {
  return `${targetKey(c)}=${String(c.to)}`;
}

export function findOffer(world: World, id: string): Offer | undefined {
  return world.offers.find((o) => o.id === id);
}

export function actorName(world: World, id: string): string {
  return world.actors.find((a) => a.id === id)?.name ?? id;
}

export function buyerId(world: World): string {
  return world.actors.find((a) => a.kind === 'buyer')?.id ?? 'buyer';
}

export function platformId(world: World): string {
  return world.actors.find((a) => a.kind === 'platform')?.id ?? 'framvera';
}

/** +1 when a larger value is better for the supplier granting it, -1 when smaller is better. */
export function supplierDirection(field: NegotiableField): 1 | -1 {
  switch (field) {
    case 'capacity':
    case 'windowEnd':
      return -1;
    default:
      return 1;
  }
}

export function isTimeField(field: string): boolean {
  return field === 'windowEnd' || field === 'windowStart' || field === 'deadline';
}

/** Numeric form of a term value: epoch ms for times, the number itself otherwise. */
export function numeric(field: string, v: number | string | boolean | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (isTimeField(field)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  if (/^(yes|true)$/i.test(v)) return 1;
  if (/^(no|false)$/i.test(v)) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** Express a numeric limit back in the same type as the original term value. */
export function sameKind(field: string, like: number | string, n: number): number | string {
  if (typeof like === 'string' && isTimeField(field)) return new Date(n).toISOString();
  return n;
}

export function unitPriceAt(offer: Offer, qty: number): number {
  let price = offer.tiers[0]?.unit.minor ?? 0;
  for (const t of offer.tiers) if (qty >= t.minQty) price = t.unit.minor;
  return price;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export class Clock {
  private t: number;
  constructor(start: Iso, private readonly stepMs = 60_000) {
    this.t = Date.parse(start);
  }
  next(): Iso {
    const iso = new Date(this.t).toISOString();
    this.t += this.stepMs;
    return iso;
  }
  peek(offsetMs = 0): Iso {
    return new Date(this.t + offsetMs).toISOString();
  }
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}
