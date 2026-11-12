import type { Money } from '@framvera/contracts';

export const HOUR_MS = 3_600_000;

export function fmtMoney(m: Money): string {
  const whole = Math.floor(Math.abs(m.minor) / 100);
  const cents = Math.abs(m.minor) % 100;
  const sign = m.minor < 0 ? '-' : '';
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, m.currency === 'SEK' ? ' ' : ',');
  const frac = cents ? (m.currency === 'SEK' ? ',' : '.') + String(cents).padStart(2, '0') : '';
  if (m.currency === 'SEK') return `${sign}${grouped}${frac} kr`;
  if (m.currency === 'EUR') return `${sign}€${grouped}${frac}`;
  return `${sign}$${grouped}${frac}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(iso: string | number): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

export function iso(ms: number): string {
  return new Date(Math.round(ms)).toISOString();
}
