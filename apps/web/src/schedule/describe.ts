import { hours, money, weekday } from '../lib/format.ts';
import type { Bar, BarStatus, Model } from './model.ts';

const iso = (t: number) => new Date(t).toISOString();

export const STATUS_TEXT: Record<BarStatus, string> = {
  planned: 'Planned',
  kept: 'Kept exactly as agreed',
  withdrawn: 'Withdrawn: this supplier can no longer deliver',
  superseded: 'Replaced by a moved version of the same work',
  'at-risk': 'At risk: its inputs or timing no longer hold',
  added: 'New in the recovery plan',
  amended: 'Moved by the recovery plan',
};

export function windowText(b: Bar): string | undefined {
  if (!b.window) return undefined;
  const w = b.window;
  const o = b.originalWindow;
  const base = `Allowed ${weekday(iso(w.from))} to ${weekday(iso(w.to))}`;
  if (!o || (o.from === w.from && o.to === w.to)) return base;
  const parts: string[] = [];
  if (w.to !== o.to) parts.push(`ends ${weekday(iso(w.to))} instead of ${weekday(iso(o.to))} (${w.to > o.to ? '+' : '−'}${hours(Math.abs(w.to - o.to) / 3_600_000)})`);
  if (w.from !== o.from) parts.push(`starts ${weekday(iso(w.from))} instead of ${weekday(iso(o.from))} (${w.from < o.from ? '+' : '−'}${hours(Math.abs(w.from - o.from) / 3_600_000)})`);
  return `Negotiated window ${parts.join(' and ')}`;
}

export function describe(b: Bar, model: Model): { title: string; lines: string[]; label: string } {
  const title = `${b.actorName}: ${b.qty} ${b.unit}`;
  const lines = [
    `${money(b.cost)} for ${b.qty} ${b.unit}`,
    `Works ${weekday(iso(b.start))} to ${weekday(iso(b.workEnd))}`,
    b.handoffHours > 0 ? `Handoff ${hours(b.handoffHours)}, output ready ${weekday(iso(b.finish))}` : `Output ready ${weekday(iso(b.finish))}`,
  ];
  const w = windowText(b);
  if (w) lines.push(w);
  if (model.deadline !== undefined && b.stage === model.lanes[model.lanes.length - 1]?.stage && b.status !== 'withdrawn' && b.status !== 'superseded') {
    const m = (model.deadline - b.finish) / 3_600_000;
    lines.push(m >= 0 ? `${hours(m)} before the deadline` : `${hours(-m)} after the deadline`);
  }
  if (b.status !== 'planned' || model.adapting) lines.push(STATUS_TEXT[b.status]);
  return { title, lines, label: `${b.actorName}, ${b.qty} ${b.unit}. ${lines.join('. ')}.` };
}
