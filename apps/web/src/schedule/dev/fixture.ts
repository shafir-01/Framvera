// Development fixture for the schedule view. Used only by dev/main.tsx, never imported by the app.
import type { Actor, Agreement, Allocation, Disruption, Money, Obligation, Offer, Plan, Recovery, Stage, World } from '@framvera/contracts';
import type { ScheduleProps } from '../model.ts';

const SEK = (kr: number): Money => ({ currency: 'SEK', minor: Math.round(kr * 100) });
const T = (s: string) => `2026-11-${s}:00.000Z`;
const OBS = '2026-11-12T13:30:00.000Z';

const stages: Stage[] = [
  { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 1 },
  { id: 'boxes', name: 'Fold gift boxes', unit: 'boxes', after: [], perOutcome: 1 },
  { id: 'goods', name: 'Brand bottles', unit: 'bottles', after: [], perOutcome: 1 },
  { id: 'assembly', name: 'Assemble kits', unit: 'kits', after: ['print', 'boxes', 'goods'], perOutcome: 1 },
  { id: 'delivery', name: 'Deliver to venue', unit: 'kits', after: ['assembly'], perOutcome: 1 },
];

interface Row {
  id: string;
  name: string;
  stage: string;
  price: number;
  rate: number;
  setup: number;
  handoff: number;
  win: [string, string];
  negotiable?: Offer['negotiable'];
}

const rows: Row[] = [
  { id: 'soder', name: 'Söder Tryck', stage: 'print', price: 12.5, rate: 120, setup: 0, handoff: 2, win: ['17T06:00', '17T16:00'] },
  { id: 'ulv', name: 'Ulvsunda Kartong', stage: 'boxes', price: 18.8, rate: 70, setup: 0, handoff: 3, win: ['17T07:00', '17T20:00'] },
  { id: 'nacka', name: 'Nacka Flaskor', stage: 'goods', price: 29, rate: 90, setup: 0, handoff: 2, win: ['17T06:00', '17T17:00'] },
  { id: 'kista', name: 'Kista Pack', stage: 'assembly', price: 26, rate: 22, setup: 0, handoff: 1, win: ['18T09:00', '18T22:00'], negotiable: ['windowEnd'] },
  { id: 'bromma', name: 'Bromma Montage', stage: 'assembly', price: 38, rate: 30, setup: 0, handoff: 1, win: ['18T09:00', '19T10:00'] },
  { id: 'farsta', name: 'Farsta Lager', stage: 'assembly', price: 29, rate: 25, setup: 400, handoff: 2, win: ['19T02:00', '19T20:00'], negotiable: ['windowEnd'] },
  { id: 'arsta', name: 'Årsta Logistik', stage: 'delivery', price: 15.5, rate: 40, setup: 640, handoff: 0, win: ['19T09:00', '20T08:00'], negotiable: ['windowStart', 'windowEnd', 'joint'] },
  { id: 'varta', name: 'Värta Bud', stage: 'delivery', price: 17, rate: 25, setup: 750, handoff: 0, win: ['19T09:00', '20T08:00'], negotiable: ['windowStart', 'windowEnd', 'joint'] },
];

const actors: Actor[] = [
  { id: 'a_buyer', name: 'Nordljus Events', kind: 'buyer', city: 'Stockholm', description: 'Event producer.', active: true },
  ...rows.map((r): Actor => ({ id: `a_${r.id}`, name: r.name, kind: r.stage === 'delivery' ? 'logistics' : 'supplier', city: 'Stockholm', description: r.name, active: true })),
];

const offer = (r: Row, version = 1, extra: Partial<Offer> = {}): Offer => ({
  id: `o_${r.id}`,
  version,
  actor: `a_${r.id}`,
  stage: r.stage,
  capacity: 1000,
  minQty: 0,
  ratePerHour: r.rate,
  setupFee: SEK(r.setup),
  tiers: [{ minQty: 0, unit: SEK(r.price) }],
  window: { start: T(r.win[0]), end: T(r.win[1]) },
  handoffHours: r.handoff,
  validUntil: T('15T22:00'),
  negotiable: r.negotiable ?? [],
  provenance: { source: 'synthetic-market', observedAt: OBS },
  claims: [],
  ...extra,
});

const baseOffers = rows.map((r) => offer(r));
const row = (id: string) => rows.find((r) => r.id === id)!;

const world = (offers: Offer[], version: number): World => ({ id: 'w1', version, seed: 1, name: 'Promotional kits, Stockholm', currency: 'SEK', stages, actors, offers, claims: [], family: 'flagship', createdAt: OBS });

export const originalWorld = world(baseOffers, 1);

const negotiatedOffers: Offer[] = [
  ...baseOffers,
  offer(row('kista'), 2, { window: { start: T('18T09:00'), end: T('19T02:00') }, derivedFrom: { concessions: ['cn_kista_end'] } }),
  offer(row('arsta'), 2, { derivedFrom: { concessions: ['cn_joint'], coalition: 'co_1' } }),
  offer(row('varta'), 2, { derivedFrom: { concessions: ['cn_joint'], coalition: 'co_1' } }),
];
export const negotiatedWorld = world(negotiatedOffers, 2);

function alloc(id: string, qty: number, start: string): Allocation {
  const r = row(id);
  const s = new Date(T(start)).getTime();
  const work = (qty / r.rate) * 3_600_000;
  return {
    offer: `o_${id}`,
    actor: `a_${id}`,
    stage: r.stage,
    qty,
    start: new Date(s).toISOString(),
    finish: new Date(s + work + r.handoff * 3_600_000).toISOString(),
    cost: SEK(r.price * qty + r.setup),
  };
}

const allocations: Allocation[] = [
  alloc('soder', 500, '17T07:00'),
  alloc('ulv', 500, '17T08:00'),
  alloc('nacka', 500, '17T07:00'),
  alloc('kista', 300, '18T10:00'),
  alloc('bromma', 200, '18T12:00'),
  alloc('arsta', 300, '19T10:00'),
  alloc('varta', 200, '19T10:00'),
];

const sum = (list: Allocation[]) => SEK(list.reduce((s, a) => s + a.cost.minor, 0) / 100);

export const plan: Plan = {
  id: 'plan_2',
  worldVersion: 2,
  intent: 'int_1',
  allocations,
  total: sum(allocations),
  readyAt: allocations.reduce((m, a) => (a.finish > m ? a.finish : m), ''),
  objective: 'Lowest total cost',
};

const ob = (i: number, a: Allocation, extra: Partial<Obligation> = {}): Obligation => ({
  id: `ob_${i}`,
  agreement: 'ag_1',
  actor: a.actor,
  offer: a.offer,
  stage: a.stage,
  qty: a.qty,
  start: a.start,
  due: a.finish,
  amount: a.cost,
  state: 'ACTIVE',
  ...extra,
});

const baseObligations = allocations.map((a, i) => ob(i + 1, a));

export const agreement: Agreement = {
  id: 'ag_1',
  version: 1,
  intent: 'int_1',
  plan: plan.id,
  parties: ['a_buyer', ...allocations.map((a) => a.actor)],
  state: 'COMMITTED',
  termsHash: 'fixture',
  obligations: baseObligations,
  acceptances: [],
  createdAt: '2026-11-12T13:32:00.000Z',
};

export const disruption: Disruption = { id: 'dr_1', kind: 'withdraw', actor: 'a_kista', offer: 'o_kista', detail: 'Kista Pack withdrew: its packing line is down.', at: '2026-11-12T13:40:00.000Z' };

export const disruptedAgreement: Agreement = {
  ...agreement,
  state: 'FULFILLING',
  obligations: baseObligations.map((o) => (o.actor === 'a_arsta' || o.actor === 'a_varta' ? { ...o, state: 'AT_RISK' } : o.actor === 'a_kista' ? { ...o, state: 'AT_RISK' } : o)),
};

const farsta = alloc('farsta', 300, '19T02:00');
const arsta2 = alloc('arsta', 300, '19T16:30');
const varta2 = alloc('varta', 200, '19T16:30');

export const recovery: Recovery = {
  id: 'rc_1',
  disruption: 'dr_1',
  feasible: true,
  kept: ['ob_1', 'ob_2', 'ob_3', 'ob_5'],
  amended: ['ob_6', 'ob_7'],
  cancelled: ['ob_4'],
  added: [farsta],
  extraCost: SEK(1300),
  slipHours: 0,
  rejected: [],
};

export const recoveredAgreement: Agreement = {
  ...agreement,
  version: 2,
  state: 'AMENDED',
  obligations: [
    baseObligations[0]!,
    baseObligations[1]!,
    baseObligations[2]!,
    { ...baseObligations[3]!, state: 'REPLACED' },
    baseObligations[4]!,
    { ...baseObligations[5]!, state: 'REPLACED' },
    { ...baseObligations[6]!, state: 'REPLACED' },
    ob(8, farsta, { replaces: 'ob_4' }),
    ob(9, arsta2, { replaces: 'ob_6' }),
    ob(10, varta2, { replaces: 'ob_7' }),
  ],
};

export const recoveredPlan: Plan = {
  ...plan,
  id: 'plan_3',
  allocations: [...allocations.slice(0, 3), allocations[4]!, farsta, arsta2, varta2],
  total: sum([...allocations.slice(0, 3), allocations[4]!, farsta, arsta2, varta2]),
  readyAt: arsta2.finish > varta2.finish ? arsta2.finish : varta2.finish,
};

export const DEADLINE = T('20T10:00');

export type Scenario = 'plan' | 'disrupted' | 'recovered' | 'plain';

export function scenario(s: Scenario): ScheduleProps {
  const common = { world: negotiatedWorld, originalWorld, deadline: DEADLINE };
  if (s === 'disrupted') return { ...common, plan, agreement: disruptedAgreement, disruption };
  if (s === 'recovered') return { ...common, plan: recoveredPlan, agreement: recoveredAgreement, recovery, disruption };
  if (s === 'plain') return { plan, agreement };
  return { ...common, plan, agreement };
}
