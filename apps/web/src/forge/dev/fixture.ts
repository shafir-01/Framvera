// Development fixture only. Never imported by the shipped app.
import type { Actor, Claim, Intent, Money, Offer, World } from '@framvera/contracts';

const SEK = (kr: number): Money => ({ currency: 'SEK', minor: Math.round(kr * 100) });
const T = (s: string) => `2026-11-${s}:00.000Z`;
const OBS = '2026-11-12T08:00:00.000Z';
const prov = (ref: string) => ({ source: 'synthetic-market' as const, observedAt: OBS, ref });

type Row = [id: string, name: string, city: string, stage: string, cap: number, price: number, setup: number, start: string, end: string, rate: number, claim: string];

const rows: Row[] = [
  ['kista', 'Kista Pack', 'Kista', 'assembly', 600, 26, 0, '16T07:00', '17T20:00', 120, 'own'],
  ['taby', 'Täby Hantverk', 'Täby', 'assembly', 150, 33, 300, '16T07:00', '17T20:00', 40, 'own'],
  ['arsta', 'Årsta Logistik', 'Årsta', 'delivery', 400, 15.5, 640, '18T06:00', '19T18:00', 200, 'cl_van_1'],
  ['varta', 'Värta Bud', 'Stockholm', 'delivery', 400, 17, 750, '18T06:00', '19T18:00', 200, 'cl_van_1'],
  ['hagsatra', 'Hagsätra Transport', 'Stockholm', 'delivery', 300, 13, 300, '18T06:00', '19T18:00', 150, 'own'],
  ['norrtull', 'Norrtull Cykelbud', 'Stockholm', 'delivery', 120, 11, 0, '18T06:00', '19T18:00', 40, 'own'],
  ['solna', 'Solna Kurir', 'Solna', 'delivery', 260, 14.2, 200, '18T06:00', '19T18:00', 130, 'cl_van_2'],
  ['bromma', 'Bromma Frakt', 'Bromma', 'delivery', 260, 14.8, 200, '18T06:00', '19T18:00', 130, 'cl_van_2'],
];

const actors: Actor[] = [
  { id: 'a_buyer', name: 'Nordljus Events', kind: 'buyer', city: 'Stockholm', description: 'Event producer.', active: true },
  ...rows.map(([id, name, city, stage]): Actor => ({
    id: `a_${id}`,
    name,
    kind: stage === 'delivery' ? 'logistics' : 'supplier',
    city,
    description: `${name} in ${city}.`,
    active: true,
  })),
];

const offers: Offer[] = rows.map(([id, , , stage, cap, price, setup, start, end, rate, claim]) => ({
  id: `o_${id}`,
  version: 1,
  actor: `a_${id}`,
  stage,
  capacity: cap,
  minQty: 0,
  ratePerHour: rate,
  setupFee: SEK(setup),
  tiers: [{ minQty: 0, unit: SEK(price) }],
  window: { start: T(start), end: T(end) },
  handoffHours: stage === 'delivery' ? 0 : 1,
  validUntil: T('15T22:00'),
  negotiable: ['joint'],
  provenance: prov(`offer:o_${id}`),
  claims: [claim === 'own' ? `cl_cap_${id}` : claim],
}));

const claims: Claim[] = [
  ...rows
    .filter((r) => r[10] === 'own')
    .map(([id, , , , cap]): Claim => ({
      id: `cl_cap_${id}`,
      actor: `a_${id}`,
      subject: `capacity:o_${id}`,
      assertion: `Capacity of ${cap} in the offered window.`,
      value: cap,
      tier: 'single-claim',
      provenance: prov(`claim:cl_cap_${id}`),
    })),
  { id: 'cl_van_1', actor: 'a_arsta', subject: 'capacity:van-1', assertion: 'One van, 500 kits per run.', value: 500, tier: 'single-claim', provenance: prov('claim:cl_van_1') },
  { id: 'cl_van_2', actor: 'a_solna', subject: 'capacity:van-2', assertion: 'One van, 400 kits per run.', value: 400, tier: 'single-claim', provenance: prov('claim:cl_van_2') },
];

export const world: World = {
  id: 'w_forge_dev',
  version: 1,
  seed: 7,
  name: 'Promotional kits, Stockholm',
  currency: 'SEK',
  stages: [
    { id: 'assembly', name: 'Assemble kits', unit: 'kits', after: [], perOutcome: 1 },
    { id: 'delivery', name: 'Deliver to venue', unit: 'kits', after: ['assembly'], perOutcome: 1 },
  ],
  actors,
  offers,
  claims,
  family: 'flagship',
  createdAt: OBS,
};

export const intent: Intent = {
  id: 'in_forge_dev',
  text: '500 promotional kits delivered to Kistamässan by Friday.',
  quantity: 500,
  budget: SEK(55000),
  deadline: T('20T12:00'),
  deliverTo: 'Kistamässan',
  negotiable: {},
  authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: false, maxSpend: SEK(55000) },
  provenance: { source: 'buyer', observedAt: OBS },
};

/** Planner estimates of what each supplier could earn elsewhere. Public signals only. */
export const outside: Record<string, Money> = {
  a_arsta: SEK(5200),
  a_varta: SEK(4400),
  a_hagsatra: SEK(3600),
  a_norrtull: SEK(1100),
  a_solna: SEK(3300),
  a_bromma: SEK(3200),
};
