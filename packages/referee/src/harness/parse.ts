import type { Concession, Currency, NegotiableField, Offer } from '@framvera/contracts';

const H = 3_600_000;

export type Parsed = { ok: true; concession: Concession; summary: string } | { ok: false; error: string };

type Field = Exclude<NegotiableField, 'joint'>;

const FIELD_PATTERNS: [Field, RegExp][] = [
  ['setupFee', /set-?\s?up|start-?up fee|onboarding fee|one-?off fee|fixed fee/],
  ['minQty', /minimum|min\.? ?(qty|quantity|order)|moq|smallest order/],
  ['capacity', /capacity|more units|additional units|produce more|handle more|scale up/],
  ['windowStart', /start (earlier|sooner)|begin (earlier|sooner)|open earlier|window start|earlier start|start before/],
  ['windowEnd', /deadline|finish later|later finish|window end|extend|extension|extra (hours|days)|more time|stay open/],
  ['unitPrice', /price|discount|cheaper|per (unit|kit|piece|item)|unit cost|% off|percent off|lower the rate|cut the rate/],
];

const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

function pickField(text: string): { field: Field } | { error: string } {
  const set = new Set(FIELD_PATTERNS.filter(([, re]) => re.test(text)).map(([f]) => f));
  if (set.has('setupFee')) set.delete('unitPrice');
  if (set.has('windowStart')) set.delete('windowEnd');
  if (set.size === 0) return { error: 'The question names no change the supplier can answer. Name one field: unit price, setup fee, minimum quantity, capacity, window end or window start.' };
  if (set.size > 1) return { error: `The question mixes several changes (${[...set].join(', ')}). Ask for one change per question.` };
  return { field: [...set][0] as Field };
}

function hoursIn(text: string): number | null {
  const d = text.match(/(\d+(?:[.,]\d+)?)\s*-?\s*days?\b/);
  if (d) return num(d[1] as string) * 24;
  const h = text.match(/(\d+(?:[.,]\d+)?)\s*-?\s*(?:h|hrs?|hours?)\b/);
  return h ? num(h[1] as string) : null;
}

const pctIn = (text: string) => {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:%|percent|per cent)/);
  return m ? num(m[1] as string) / 100 : null;
};

const moneyIn = (text: string) => {
  const m = text.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(?:kr|sek|kronor|usd|eur|\$|€)/) ?? text.match(/(?:kr|sek|usd|eur|\$|€)\s*(\d[\d\s]*(?:[.,]\d+)?)/);
  return m ? Math.round(num(m[1] as string) * 100) : null;
};

const countIn = (text: string) => {
  const m = text.match(/\b(\d{1,7})\b(?!\s*(?:%|percent|h\b|hrs?|hours?|days?|kr|sek))/);
  return m ? Number(m[1]) : null;
};

const isoIn = (text: string) => text.match(/\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2})?z?)?/i)?.[0] ?? null;

function isoMs(iso: string): number {
  if (iso.length === 10) return Date.parse(`${iso}T00:00:00Z`);
  return Date.parse(/z$/i.test(iso) ? iso : `${iso}Z`);
}

const fail = (error: string): Parsed => ({ ok: false, error });

/** Turns a free-form question into one typed concession, or explains why it cannot be understood. */
export function parseQuestion(offer: Offer, question: string, id: string, currency: Currency): Parsed {
  const text = question.toLowerCase();
  const picked = pickField(text);
  if ('error' in picked) return fail(picked.error);
  const { field } = picked;
  if (!offer.negotiable.includes(field)) return fail(`${offer.id} has not signalled that ${field} is negotiable.`);
  const wrongWay = /(^|[^a-z])(raise|increase|higher|bump)([^a-z]|$)/.test(text);
  const byTo = /\b(to|at)\b/.test(text) ? 'to' : /\b(by|off|reduce|reduction|cut|lower|less|drop)\b/.test(text) ? 'by' : null;
  const target = { kind: 'offer' as const, offer: offer.id, field };
  const mk = (from: number | string, to: number | string, estimate: number, summary: string): Parsed => ({
    ok: true,
    summary,
    concession: { id, target, from, to, estimate: { currency, minor: Math.max(0, Math.round(estimate)) }, rationale: question.slice(0, 200) },
  });

  switch (field) {
    case 'unitPrice': {
      if (wrongWay) return fail('The change must lower the published term.');
      const from = offer.tiers[0]?.unit.minor ?? 0;
      const p = pctIn(text);
      const m = moneyIn(text);
      let to: number | null = null;
      if (p !== null) to = Math.floor(from * (1 - p));
      else if (m !== null && byTo === 'to') to = m;
      else if (m !== null && byTo === 'by') to = from - m;
      if (to === null || to < 0) return fail('State the price change as a percentage ("10% lower") or an amount ("by 5 kr" or "to 40 kr").');
      if (to >= from) return fail('The requested price is not below the published price.');
      return mk(from, to, from - to, `first-tier unit price ${from} -> ${to} minor units`);
    }
    case 'windowEnd': {
      const iso = isoIn(text);
      const end = Date.parse(offer.window.end);
      let to: number | null = null;
      if (iso) to = isoMs(iso);
      else { const h = hoursIn(text); if (h !== null) to = end + h * H; }
      if (to === null || Number.isNaN(to)) return fail('State the extension in hours or days ("12 hours later") or as an ISO date.');
      if (to <= end) return fail('The requested window end is not later than the published one.');
      return mk(offer.window.end, new Date(to).toISOString(), 0, `window end ${offer.window.end} -> ${new Date(to).toISOString()}`);
    }
    case 'windowStart': {
      const iso = isoIn(text);
      const start = Date.parse(offer.window.start);
      let to: number | null = null;
      if (iso) to = isoMs(iso);
      else { const h = hoursIn(text); if (h !== null) to = start - h * H; }
      if (to === null || Number.isNaN(to)) return fail('State how much earlier in hours or days, or give an ISO date.');
      if (to >= start) return fail('The requested window start is not earlier than the published one.');
      return mk(offer.window.start, new Date(to).toISOString(), 0, `window start ${offer.window.start} -> ${new Date(to).toISOString()}`);
    }
    case 'capacity': {
      const p = pctIn(text);
      let to: number | null = null;
      if (p !== null) to = Math.ceil(offer.capacity * (1 + p));
      else {
        const c = countIn(text);
        if (c !== null) to = byTo === 'by' && /\b(more|extra|additional|increase|add)\b/.test(text) ? offer.capacity + c : c;
      }
      if (to === null) return fail('State the new capacity as a unit count ("to 600 units") or a percentage ("20% more").');
      if (to <= offer.capacity) return fail('The requested capacity is not above the published capacity.');
      return mk(offer.capacity, to, 0, `capacity ${offer.capacity} -> ${to}`);
    }
    case 'minQty': {
      if (wrongWay) return fail('The change must lower the published term.');
      const p = pctIn(text);
      let to: number | null = null;
      if (p !== null) to = Math.floor(offer.minQty * (1 - p));
      else {
        const c = countIn(text);
        if (c !== null) to = byTo === 'by' ? offer.minQty - c : c;
      }
      if (to === null || to < 0) return fail('State the new minimum as a unit count ("to 100 units") or a percentage ("20% lower").');
      if (to >= offer.minQty) return fail('The requested minimum is not below the published minimum.');
      return mk(offer.minQty, to, 0, `minimum quantity ${offer.minQty} -> ${to}`);
    }
    case 'setupFee': {
      if (wrongWay) return fail('The change must lower the published term.');
      const from = offer.setupFee.minor;
      let to: number | null = null;
      if (/waive|remove|drop the|no setup|without (a )?set-?up|free of/.test(text)) to = 0;
      else {
        const p = pctIn(text);
        const m = moneyIn(text);
        if (p !== null) to = Math.floor(from * (1 - p));
        else if (m !== null && byTo === 'to') to = m;
        else if (m !== null && byTo === 'by') to = from - m;
      }
      if (to === null || to < 0) return fail('State the setup fee change as "waive", a percentage, or an amount ("to 500 kr").');
      if (to >= from) return fail('The requested setup fee is not below the published fee.');
      return mk(from, to, from - to, `setup fee ${from} -> ${to} minor units`);
    }
  }
}
