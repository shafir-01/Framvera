import { createHash } from 'node:crypto';
import type { Currency, Iso, Money } from '@framvera/contracts';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export class ObligationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ObligationError';
  }
}

export const ms = (iso: Iso): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new ObligationError('bad-time', `Invalid timestamp: ${iso}`);
  return t;
};
export const iso = (t: number): Iso => new Date(t).toISOString();
export const hours = (a: number, b: number): number => Math.round(((b - a) / HOUR) * 100) / 100;

export const money = (currency: Currency, minor: number): Money => ({ currency, minor: Math.round(minor) });

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new ObligationError('currency', `Currency mismatch: ${a.currency} vs ${b.currency}`);
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function sumMoney(list: Money[], currency: Currency): Money {
  return list.reduce((acc, m) => addMoney(acc, m), money(currency, 0));
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function clone<T>(v: T): T {
  return structuredClone(v);
}
