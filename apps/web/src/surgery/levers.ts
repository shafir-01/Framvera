import type { Concession, ConstraintRef, Intent, Intervention, Money, NegotiableField, Offer, Plan, World } from '@framvera/contracts';
import { applyConcessions, ESTIMATES, MAX_PRICE_CUT, stageDemand } from '@framvera/solver';
import { concessionSentence, hours, money, singular, weekday } from '../lib/format.ts';
import { latestOffers } from '../lib/world.ts';

export type LeverField = NegotiableField | 'deadline' | 'budget';
export type LeverUnit = 'minutes' | 'units' | 'minor' | 'toggle';

/**
 * One negotiable quantity the user can bend in a what-if. The slider value is always a relaxation:
 * 0 is the published term and every step to the right makes the order easier to fulfil.
 */
export interface Lever {
  key: string;
  field: LeverField;
  /** The user's own term (deadline or budget), not a supplier's. */
  own: boolean;
  offer?: string;
  actor?: string;
  who: string;
  what: string;
  unit: LeverUnit;
  /** Published value: ISO time for time levers, a number otherwise. */
  base: number | string;
  max: number;
  /** Smallest change the slider and the threshold search distinguish. */
  grain: number;
  /** Keyboard step. */
  kb: number;
  stageUnit: string;
  /** For a joint run: the planner's concessions, one per member, used verbatim when switched on. */
  joint?: Concession[];
  members?: string[];
}

const MIN = 60_000;
const SUPPLIER_SHIFT_MIN = 24 * 60;
const OWN_DEADLINE_MIN = 48 * 60;
const OWN_BUDGET_SHARE = 0.3;

const RELEVANT: Partial<Record<ConstraintRef['kind'], LeverField[]>> = {
  capacity: ['capacity'],
  'exclusive-resource': ['capacity'],
  window: ['windowEnd', 'windowStart'],
  'min-qty': ['minQty'],
};

const firstUnit = (o: Offer) => o.tiers.slice().sort((a, b) => a.minQty - b.minQty)[0]?.unit.minor ?? 0;

function offerLever(o: Offer, field: Exclude<NegotiableField, 'joint'>, world: World, intent: Intent): Lever | null {
  if (!o.negotiable.includes(field)) return null;
  const who = world.actors.find((a) => a.id === o.actor)?.name ?? o.actor;
  const stage = world.stages.find((s) => s.id === o.stage);
  const stageUnit = stage?.unit ?? 'units';
  const stageWord = stage?.name.toLowerCase() ?? 'work';
  const common = { key: `${o.id}:${field}`, field, own: false, offer: o.id, actor: o.actor, who, stageUnit };
  const demand = stage ? stageDemand(stage, intent) : intent.quantity;
  switch (field) {
    case 'windowEnd':
      return { ...common, what: `${stageWord}, works until`, unit: 'minutes', base: o.window.end, max: SUPPLIER_SHIFT_MIN, grain: 1, kb: 15 };
    case 'windowStart':
      return { ...common, what: `${stageWord}, can start from`, unit: 'minutes', base: o.window.start, max: SUPPLIER_SHIFT_MIN, grain: 1, kb: 15 };
    case 'capacity':
      return { ...common, what: `${stageWord}, capacity`, unit: 'units', base: o.capacity, max: Math.max(1, demand), grain: 1, kb: Math.max(1, Math.round(demand / 50)) };
    case 'minQty':
      return o.minQty > 0
        ? { ...common, what: `${stageWord}, minimum order`, unit: 'units', base: o.minQty, max: o.minQty, grain: 1, kb: Math.max(1, Math.round(o.minQty / 20)) }
        : null;
    case 'unitPrice': {
      const p = firstUnit(o);
      const max = Math.floor(p * MAX_PRICE_CUT);
      return max > 0 ? { ...common, what: `${stageWord}, price per ${singular(stageUnit)}`, unit: 'minor', base: p, max, grain: 10, kb: 50 } : null;
    }
    case 'setupFee':
      return o.setupFee.minor > 0
        ? { ...common, what: `${stageWord}, setup fee`, unit: 'minor', base: o.setupFee.minor, max: o.setupFee.minor, grain: 100, kb: 1000 }
        : null;
  }
}

export function ownLever(field: 'deadline' | 'budget', intent: Intent): Lever {
  if (field === 'deadline') {
    const max = Math.max(OWN_DEADLINE_MIN, Math.round((intent.negotiable.deadlineHours ?? 0) * 60));
    return { key: 'intent:deadline', field, own: true, who: 'Your', what: 'deadline', unit: 'minutes', base: intent.deadline, max, grain: 1, kb: 15, stageUnit: '' };
  }
  const max = Math.max(Math.round(intent.budget.minor * OWN_BUDGET_SHARE), intent.negotiable.budgetMinor ?? 0);
  return { key: 'intent:budget', field, own: true, who: 'Your', what: 'budget', unit: 'minor', base: intent.budget.minor, max, grain: 100, kb: 50_000, stageUnit: '' };
}

const activeOffers = (world: World) => {
  const active = new Set(world.actors.filter((a) => a.active).map((a) => a.id));
  return latestOffers(world.offers).filter((o) => active.has(o.actor));
};

const terminalStages = (world: World) => {
  const preds = new Set(world.stages.flatMap((s) => s.after));
  return new Set(world.stages.filter((s) => !preds.has(s.id)).map((s) => s.id));
};

/** The levers that can loosen one blocking constraint, most direct first. */
export function leversFor(ref: ConstraintRef, world: World, intent: Intent, joints: Lever[] = []): Lever[] {
  const touching = joints.filter((j) =>
    (j.members ?? []).some((id) => {
      const o = world.offers.find((x) => x.id === id);
      return !!o && (o.id === ref.subject || o.stage === ref.subject || o.actor === ref.subject);
    }),
  );
  return [...directLevers(ref, world, intent), ...touching];
}

function directLevers(ref: ConstraintRef, world: World, intent: Intent): Lever[] {
  const offers = activeOffers(world);
  const pick = (os: Offer[], fields: Exclude<NegotiableField, 'joint'>[]) =>
    os.flatMap((o) => fields.map((f) => offerLever(o, f, world, intent))).filter((l): l is Lever => !!l);
  const relevant = RELEVANT[ref.kind];
  if (relevant) {
    const o = offers.find((x) => x.id === ref.subject);
    return o ? pick([o], relevant as Exclude<NegotiableField, 'joint'>[]) : [];
  }
  switch (ref.kind) {
    case 'demand':
      return pick(offers.filter((o) => o.stage === ref.subject), ['capacity', 'windowEnd', 'minQty']);
    case 'precedence': {
      const [pred] = ref.id.replace(/^precedence:/, '').split('>');
      return [
        ...pick(offers.filter((o) => o.stage === pred), ['windowStart']),
        ...pick(offers.filter((o) => o.stage === ref.subject), ['windowEnd']),
      ];
    }
    case 'deadline': {
      const finals = terminalStages(world);
      return [ownLever('deadline', intent), ...pick(offers.filter((o) => finals.has(o.stage)), ['windowStart'])];
    }
    case 'budget':
      return [ownLever('budget', intent), ...pick(offers, ['unitPrice', 'setupFee'])];
    default:
      return [];
  }
}

/** Joint runs the planner found (shared capacity or a combined order), one switch per run. */
export function jointLevers(interventions: Intervention[], world: World): Lever[] {
  const byRun = new Map<string, Concession[]>();
  for (const iv of interventions)
    for (const c of iv.concessions) {
      if (c.target.kind !== 'offer' || c.target.field !== 'joint') continue;
      const run = String(c.to);
      const list = byRun.get(run) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      byRun.set(run, list);
    }
  return [...byRun].map(([run, cs]): Lever => {
    const members = cs.map((c) => (c.target.kind === 'offer' ? c.target.offer : ''));
    const names = members.map((id) => {
      const o = world.offers.find((x) => x.id === id);
      return world.actors.find((a) => a.id === o?.actor)?.name ?? id;
    });
    const o = world.offers.find((x) => x.id === members[0]);
    const stage = world.stages.find((st) => st.id === o?.stage);
    return {
      key: `joint:${run}`,
      field: 'joint',
      own: false,
      who: names.join(' + '),
      what: `${stage?.name.toLowerCase() ?? 'work'}, one joint run`,
      unit: 'toggle',
      base: 0,
      max: 1,
      grain: 1,
      kb: 1,
      stageUnit: stage?.unit ?? 'units',
      joint: cs,
      members,
    };
  });
}

/** Every lever in the world, used to place a suggested intervention onto the sliders. */
export function allLevers(world: World, intent: Intent, joints: Lever[] = []): Lever[] {
  const fields: Exclude<NegotiableField, 'joint'>[] = ['windowEnd', 'windowStart', 'capacity', 'minQty', 'unitPrice', 'setupFee'];
  return [
    ownLever('deadline', intent),
    ownLever('budget', intent),
    ...joints,
    ...activeOffers(world).flatMap((o) => fields.map((f) => offerLever(o, f, world, intent))).filter((l): l is Lever => !!l),
  ];
}

const shiftIso = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * MIN).toISOString();

/** Absolute value of a lever moved by `delta`. */
export function leverValue(l: Lever, delta: number): number | string {
  switch (l.field) {
    case 'joint':
      return delta ? 'joint' : 'separate';
    case 'windowEnd':
    case 'deadline':
      return shiftIso(String(l.base), delta);
    case 'windowStart':
      return shiftIso(String(l.base), -delta);
    case 'capacity':
    case 'budget':
      return Number(l.base) + delta;
    case 'minQty':
    case 'unitPrice':
    case 'setupFee':
      return Math.max(0, Number(l.base) - delta);
  }
}

export function describeValue(l: Lever, delta: number, currency: Money['currency']): string {
  if (l.unit === 'toggle') return delta ? 'Together' : 'Separately';
  const v = leverValue(l, delta);
  if (l.unit === 'minutes') return weekday(String(v));
  if (l.unit === 'minor') return l.field === 'unitPrice' ? `${money({ currency, minor: Number(v) })} per ${singular(l.stageUnit)}` : money({ currency, minor: Number(v) });
  return `${Number(v).toLocaleString('sv-SE')} ${l.stageUnit}`;
}

export function describeDelta(l: Lever, delta: number, currency: Money['currency']): string {
  if (delta === 0) return 'as published';
  if (l.unit === 'toggle') return 'switched on';
  if (l.unit === 'minutes') return `${hours(delta / 60)} ${l.field === 'windowStart' ? 'earlier' : 'later'}`;
  if (l.unit === 'minor') {
    const m = money({ currency, minor: delta });
    return l.field === 'budget' ? `+${m}` : `−${m}${l.field === 'unitPrice' ? ` per ${singular(l.stageUnit)}` : ''}`;
  }
  return `${l.field === 'minQty' ? '−' : '+'}${delta.toLocaleString('sv-SE')} ${l.stageUnit}`;
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/**
 * A typed concession for a lever position. The estimate uses the planner's published estimate rules
 * and is labelled as an estimate wherever it is shown.
 */
export function toConcessions(l: Lever, delta: number, world: World, intent: Intent, plan?: Plan): Concession[] {
  if (delta <= 0) return [];
  if (l.joint) return l.joint;
  return [toConcession(l, delta, world, intent, plan)];
}

export function toConcession(l: Lever, delta: number, world: World, intent: Intent, plan?: Plan): Concession {
  const currency = intent.budget.currency;
  const from = l.base;
  const to = leverValue(l, delta);
  const offer = l.offer ? world.offers.find((o) => o.id === l.offer) : undefined;
  const p = offer ? firstUnit(offer) : 0;
  const qty = plan?.allocations.find((a) => a.offer === l.offer)?.qty ?? (offer ? Math.min(offer.capacity, stageDemand(world.stages.find((s) => s.id === offer.stage)!, intent)) : 0);
  let estimate = 0;
  switch (l.field) {
    case 'capacity':
      estimate = delta * ESTIMATES.capacityPremium * p;
      break;
    case 'minQty':
      estimate = delta * ESTIMATES.minQtyPerUnit * p;
      break;
    case 'windowEnd':
    case 'windowStart':
      estimate = (delta / 60) * ESTIMATES.windowPerHour * (offer?.ratePerHour ?? 0) * p;
      break;
    case 'unitPrice':
      estimate = delta * qty;
      break;
    case 'setupFee':
    case 'budget':
      estimate = delta;
      break;
    case 'deadline':
    case 'joint':
      estimate = 0;
      break;
  }
  const target: Concession['target'] = l.own
    ? { kind: 'intent', field: l.field as 'deadline' | 'budget' }
    : { kind: 'offer', offer: l.offer!, field: l.field as NegotiableField };
  const sentence = l.own
    ? `You ${l.field === 'deadline' ? 'accept a later deadline' : 'raise your budget'}: ${describeValue(l, delta, currency)} instead of ${describeValue(l, 0, currency)}.`
    : `${l.who} ${l.what}: ${describeValue(l, delta, currency)} instead of ${describeValue(l, 0, currency)}.`;
  return {
    id: `cn-${fnv(`${l.key}:${from}:${to}`)}`,
    target,
    from,
    to,
    estimate: { currency, minor: Math.max(0, Math.round(estimate)) },
    rationale: sentence,
  };
}

/** Lever position for a concession made elsewhere (for example a planner suggestion), or null if no lever expresses it. */
export function deltaFor(c: Concession, levers: Lever[]): { key: string; delta: number } | null {
  if (c.target.kind === 'offer' && c.target.field === 'joint') {
    const run = `joint:${String(c.to)}`;
    return levers.some((l) => l.key === run) ? { key: run, delta: 1 } : null;
  }
  const key = c.target.kind === 'intent' ? `intent:${c.target.field}` : `${c.target.offer}:${c.target.field}`;
  const l = levers.find((x) => x.key === key);
  if (!l) return null;
  const num = (v: number | string) => (typeof v === 'number' ? v : Number(v));
  const mins = (a: number | string, b: number | string) => Math.round((Date.parse(String(b)) - Date.parse(String(a))) / MIN);
  let delta: number;
  switch (l.field) {
    case 'windowEnd':
    case 'deadline':
      delta = mins(l.base, c.to);
      break;
    case 'windowStart':
      delta = mins(c.to, l.base);
      break;
    case 'capacity':
    case 'budget':
      delta = num(c.to) - num(l.base);
      break;
    case 'unitPrice':
      delta = num(c.from) - num(c.to);
      break;
    case 'minQty':
    case 'setupFee':
      delta = num(l.base) - num(c.to);
      break;
    case 'joint':
      delta = 1;
      break;
  }
  return Number.isFinite(delta) && delta >= 0 ? { key, delta: Math.round(delta) } : null;
}

export interface Tight {
  id: string;
  kind: 'capacity' | 'window' | 'deadline' | 'budget';
  text: string;
  /** Remaining room as a share of a natural scale; 0 means the limit is binding. */
  room: number;
}

/**
 * The limits a feasible plan presses hardest against, measured by plain arithmetic on the plan and the
 * terms it was solved under. Each figure is exact; the ordering across kinds uses a stated scale
 * (capacity and budget by share, time by share of a day).
 */
export function tightest(plan: Plan, world: World, intent: Intent): Tight[] {
  const out: Tight[] = [];
  const currency = intent.budget.currency;
  const name = (actor: string) => world.actors.find((a) => a.id === actor)?.name ?? actor;
  for (const a of plan.allocations) {
    const o = world.offers.find((x) => x.id === a.offer && x.actor === a.actor) ?? world.offers.find((x) => x.id === a.offer);
    if (!o) continue;
    const unit = world.stages.find((s) => s.id === o.stage)?.unit ?? 'units';
    const capRoom = o.capacity - a.qty;
    out.push({
      id: `capacity:${o.id}`,
      kind: 'capacity',
      text: capRoom <= 0 ? `${name(o.actor)} is at full capacity (${a.qty} of ${o.capacity} ${unit}).` : `${name(o.actor)} has ${capRoom} ${unit} of room left.`,
      room: o.capacity > 0 ? Math.max(0, capRoom) / o.capacity : 1,
    });
    const workEnd = Date.parse(a.finish) - o.handoffHours * 3_600_000;
    const winRoom = (Date.parse(o.window.end) - workEnd) / MIN;
    out.push({
      id: `window:${o.id}`,
      kind: 'window',
      text: winRoom < 1 ? `${name(o.actor)} finishes exactly as its window closes.` : `${name(o.actor)} finishes ${hours(winRoom / 60)} before its window closes.`,
      room: Math.max(0, winRoom) / (24 * 60),
    });
  }
  const dlRoom = (Date.parse(intent.deadline) - Date.parse(plan.readyAt)) / MIN;
  out.push({
    id: 'deadline',
    kind: 'deadline',
    text: dlRoom < 1 ? 'Ready exactly at your deadline.' : `Ready ${hours(dlRoom / 60)} before your deadline.`,
    room: Math.max(0, dlRoom) / (24 * 60),
  });
  const budgetRoom = intent.budget.minor - plan.total.minor;
  out.push({
    id: 'budget',
    kind: 'budget',
    text: budgetRoom <= 0 ? 'The budget is fully used.' : `${money({ currency, minor: budgetRoom })} of the budget left.`,
    room: intent.budget.minor > 0 ? Math.max(0, budgetRoom) / intent.budget.minor : 1,
  });
  return out.sort((x, y) => x.room - y.room);
}

/** Distinct suppliers a set of concessions would have to ask. The user's own concessions ask nobody. */
export function suppliersAsked(concessions: Concession[], world: World): string[] {
  const actors = new Set<string>();
  for (const c of concessions) {
    if (c.target.kind !== 'offer') continue;
    const offerId = c.target.offer;
    const o = world.offers.find((x) => x.id === offerId);
    if (o) actors.add(o.actor);
  }
  return [...actors];
}

/** Interventions whose every concession can be placed on a lever. */
export function expressible(iv: Intervention, levers: Lever[]): { key: string; delta: number }[] | null {
  const out: { key: string; delta: number }[] = [];
  for (const c of iv.concessions) {
    const d = deltaFor(c, levers);
    if (!d) return null;
    if (!out.some((x) => x.key === d.key)) out.push(d);
  }
  return out;
}

/** One plain sentence for a concession. Joint runs use the planner's own description of who does what. */
export function sentence(c: Concession, world: World): string {
  if (c.target.kind === 'offer' && c.target.field === 'joint') return c.rationale;
  return concessionSentence(c, world);
}

export interface ChangeItem {
  /** Lever key, used to undo the change. */
  key: string;
  text: string;
  own: boolean;
}

function jointSentence(run: string, world: World): string {
  const offer = (id: string) => world.offers.find((o) => o.id === id);
  const name = (id: string) => world.actors.find((a) => a.id === offer(id)?.actor)?.name ?? id;
  const unit = (id: string) => world.stages.find((s) => s.id === offer(id)?.stage)?.unit ?? 'units';
  const shared = run.match(/^joint:shared:([^>]+)>(.+)$/);
  if (shared) {
    const [, cap, op] = shared as unknown as [string, string, string];
    return `${name(op)} uses ${name(cap)}'s capacity (${offer(cap)?.capacity ?? '?'} ${unit(cap)}, was ${offer(op)?.capacity ?? '?'})`;
  }
  const batch = run.match(/^joint:batch:(.+)$/);
  if (batch) return `${batch[1]!.split('+').map(name).join(' and ')} take one joint order`;
  return 'Suppliers work as one joint run';
}

/** One line per change the user would make; the members of a joint run share one line. */
export function changeItems(concessions: readonly Concession[], world: World): ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const c of concessions) {
    if (c.target.kind === 'offer' && c.target.field === 'joint') {
      const key = `joint:${String(c.to)}`;
      if (!out.some((x) => x.key === key)) out.push({ key, text: jointSentence(String(c.to), world), own: false });
      continue;
    }
    const key = c.target.kind === 'intent' ? `intent:${c.target.field}` : `${c.target.offer}:${c.target.field}`;
    out.push({ key, text: concessionSentence(c, world), own: c.target.kind === 'intent' });
  }
  return out;
}

const SHORT: Record<LeverField, string> = {
  windowEnd: 'Works until',
  windowStart: 'Can start from',
  capacity: 'Capacity',
  minQty: 'Minimum order',
  unitPrice: 'Price',
  setupFee: 'Setup fee',
  joint: 'Joint run',
  deadline: 'Deadline',
  budget: 'Budget',
};

/** Label for a lever shown under a card that already names its supplier. */
export function shortLabel(l: Lever): string {
  return l.field === 'unitPrice' ? `Price per ${singular(l.stageUnit)}` : SHORT[l.field];
}

/**
 * Applies a what-if. Moving the buyer's own budget or deadline is the buyer's decision in this view,
 * so those moves widen what the buyer allows instead of being refused; supplier terms keep every bound.
 */
export function applyWhatIf(world: World, intent: Intent, concessions: Concession[]): { world: World; intent: Intent } {
  let budgetMinor = intent.negotiable.budgetMinor ?? 0;
  let deadlineHours = intent.negotiable.deadlineHours ?? 0;
  for (const c of concessions) {
    if (c.target.kind !== 'intent') continue;
    if (c.target.field === 'budget') budgetMinor = Math.max(budgetMinor, Math.round(Number(c.to)) - intent.budget.minor);
    else deadlineHours = Math.max(deadlineHours, (Date.parse(String(c.to)) - Date.parse(intent.deadline)) / 3_600_000);
  }
  return applyConcessions(world, { ...intent, negotiable: { ...intent.negotiable, budgetMinor, deadlineHours } }, concessions);
}
