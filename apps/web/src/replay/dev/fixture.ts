// Development fixture only. Never imported by the shipped entry.
import type { Agreement, Allocation, MarketEvent, Money, Obligation, Offer, PaymentIntent, Recovery, World } from '@framvera/contracts';
import type { ReplayApi, ReplayProps } from '../types.ts';

const SEK = (kr: number): Money => ({ currency: 'SEK', minor: kr * 100 });
const iso = (h: number, m = 0, s = 0) => `2026-11-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const MARKET = 'mkt_replay_fixture';

const actor = (id: string, name: string, kind: 'buyer' | 'supplier' | 'logistics') => ({ id, name, kind, city: 'Stockholm', description: '', active: true });

const offer = (id: string, who: string, stage: string, capacity: number, extra: Partial<Offer> = {}): Offer => ({
  id,
  version: 1,
  actor: who,
  stage,
  capacity,
  minQty: 0,
  ratePerHour: 100,
  setupFee: SEK(0),
  tiers: [{ minQty: 0, unit: SEK(20) }],
  window: { start: iso(8), end: iso(20) },
  handoffHours: 1,
  validUntil: iso(23),
  negotiable: [],
  provenance: { source: 'synthetic-market', observedAt: iso(13, 30) },
  claims: [],
  ...extra,
});

const world: World = {
  id: 'w_replay',
  version: 3,
  seed: 1,
  name: 'Promotional kits, Stockholm',
  currency: 'SEK',
  family: 'flagship',
  createdAt: iso(13, 30),
  stages: [
    { id: 'assembly', name: 'Assembly', unit: 'kits', after: [], perOutcome: 1 },
    { id: 'delivery', name: 'Delivery', unit: 'kits', after: ['assembly'], perOutcome: 1 },
  ],
  actors: [actor('a_bromma', 'Bromma Montage', 'supplier'), actor('a_arsta', 'Årsta Logistik', 'logistics'), actor('a_varta', 'Värtan Frakt', 'logistics'), actor('a_kista', 'Kista Pack', 'supplier')],
  offers: [
    offer('o_bromma', 'a_bromma', 'assembly', 500),
    offer('o_arsta', 'a_arsta', 'delivery', 500),
    offer('o_kista', 'a_kista', 'assembly', 300, { version: 2, derivedFrom: { concessions: ['c_1'] } }),
  ],
  claims: [{ id: 'cl_1', actor: 'a_arsta', subject: 'capacity:o_arsta', assertion: 'One van, 500 kits', tier: 'single-claim', provenance: { source: 'synthetic-market', observedAt: iso(13, 30) } }],
};

const alloc = (offerId: string, who: string, stage: string): Allocation => ({ offer: offerId, actor: who, stage, qty: 500, start: iso(9), finish: iso(18), cost: SEK(9250) });

const obligation = (id: string, who: string, stage: string, state: Obligation['state'], replaces?: string): Obligation => ({
  id,
  agreement: 'ag_1',
  actor: who,
  offer: `o_${who.slice(2)}`,
  stage,
  qty: 500,
  start: iso(9),
  due: iso(18),
  amount: SEK(9250),
  state,
  replaces,
});

const agreement: Agreement = {
  id: 'ag_1',
  version: 2,
  intent: 'int_1',
  plan: 'plan_2',
  parties: ['a_bromma', 'a_arsta'],
  state: 'AMENDED',
  termsHash: 'fixturehash',
  obligations: [obligation('ob_1', 'a_bromma', 'assembly', 'ACTIVE'), obligation('ob_2', 'a_arsta', 'delivery', 'REPLACED'), obligation('ob_3', 'a_varta', 'delivery', 'ACTIVE', 'ob_2')],
  acceptances: [],
  createdAt: iso(13, 32),
};

const recovery: Recovery = {
  id: 'rc_1',
  disruption: 'dr_1',
  feasible: true,
  kept: ['ob_1'],
  amended: [],
  cancelled: ['ob_2'],
  added: [alloc('o_varta', 'a_varta', 'delivery')],
  extraCost: SEK(860),
  slipHours: 0,
  rejected: [
    { description: 'Move all 500 kits to Kista Pack and use one courier pickup.', reason: 'It cancels Bromma Montage’s accepted assembly obligation.', extraCost: SEK(440), slipHours: 0 } as Recovery['rejected'][number],
    { description: 'Split delivery between two couriers.', reason: 'One courier reaches the venue after the deadline.' },
  ],
};

const payment = (state: PaymentIntent['state'], status: string): PaymentIntent => ({
  id: 'pi_1',
  operationKey: 'op_1',
  agreement: 'ag_1',
  obligations: ['ob_1'],
  payee: 'a_bromma',
  amount: SEK(9250),
  charged: SEK(9250),
  state,
  paypal: { env: 'sandbox', orderId: 'FIXTURE', refunds: [], status, lastFetchedAt: new Date().toISOString(), debugIds: [] },
});

let seq = 0;
const log: MarketEvent[] = [];
function add(type: MarketEvent['type'], at: string, data: unknown, source: MarketEvent['source'], opts: { actor?: string; causes?: number[] } = {}) {
  seq += 1;
  log.push({ id: `rp_${seq}`, seq, market: MARKET, at, type, actor: opts.actor, data, causes: (opts.causes ?? []).map((n) => `rp_${n}`), source });
  return seq;
}

const opened = add('world.created', iso(13, 30), { world: world.name, actors: 4, offers: 2 }, 'synthetic-market');
const intent = add('intent.compiled', iso(13, 30, 40), { live: false }, 'buyer', { causes: [opened] });
const infeasible = add('solve.completed', iso(13, 30, 41), { status: 'infeasible', core: { summary: 'No combination can finish before Friday 12:00 within 55 000 kr.' }, plan: null }, 'solver', { causes: [intent] });
const found = add('intervention.found', iso(13, 31, 1), { id: 'iv_1' }, 'solver', { causes: [infeasible] });
const accepted = add('negotiation.decision', iso(13, 31, 3), { message: 'm1', accept: true, basis: 'synthetic-policy', reason: 'Kista Pack can start earlier for a small fee.' }, 'synthetic-market', { actor: 'a_kista', causes: [found] });
const verified = add('solve.completed', iso(13, 31, 7), { verification: { ok: true, checks: [] }, plan: 'plan_2' }, 'solver', { causes: [accepted] });
const committed = add('agreement.state', iso(13, 32), { agreement: 'ag_1', state: 'COMMITTED' }, 'solver', { causes: [verified] });
add('obligation.state', iso(13, 32), { obligation: 'ob_1', state: 'ACTIVE' }, 'solver', { actor: 'a_bromma', causes: [committed] });
add('obligation.state', iso(13, 32), { obligation: 'ob_2', state: 'ACTIVE' }, 'solver', { actor: 'a_arsta', causes: [committed] });
const issued = add('payment.state', iso(13, 32, 30), { approval: 'issued', payee: 'a_bromma', amount: SEK(9250) }, 'buyer', { causes: [committed] });
const order = add('payment.state', iso(13, 33), { payment: 'pi_1', state: 'ORDER_CREATED', paypalStatus: 'CREATED' }, 'paypal-sandbox', { causes: [issued] });
const captured = add('payment.state', iso(13, 33, 40), { payment: 'pi_1', state: 'CAPTURE_COMPLETED', paypalStatus: 'COMPLETED' }, 'paypal-sandbox', { causes: [order] });
const disrupted = add('disruption.applied', iso(13, 40), { disruption: { id: 'dr_1', kind: 'withdraw', actor: 'a_arsta', detail: 'Årsta Logistik withdrew: its only van failed inspection.', at: iso(13, 40) }, affected: ['ob_2'] }, 'solver', { actor: 'a_arsta' });
add('recovery.proposed', iso(13, 40, 1), recovery, 'solver', { causes: [disrupted, captured] });

export const replayEvents: MarketEvent[] = log;

export const replayApi: ReplayApi = {
  events: async () => replayEvents,
  subscribe: () => () => {},
  payment: async () => payment('CAPTURE_COMPLETED', 'COMPLETED'),
};

export const replayProps: ReplayProps = {
  market: MARKET,
  api: replayApi,
  world,
  agreement,
  recovery: { recovery, agreement },
};
