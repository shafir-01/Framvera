import type { Actor, Claim, Concession, Intent, Intervention, Offer, World } from '@framvera/contracts';
import type { PolicyLike } from '../src/types.ts';

const T0 = '2026-11-09T07:00:00.000Z';
const prov = { source: 'synthetic-market' as const, observedAt: T0 };
const sek = (minor: number) => ({ currency: 'SEK' as const, minor });

function actor(id: string, name: string, kind: Actor['kind'], description = ''): Actor {
  return { id, name, kind, city: 'Stockholm', description, active: true };
}

function offer(p: Partial<Offer> & Pick<Offer, 'id' | 'actor' | 'stage'>): Offer {
  return {
    version: 1,
    capacity: 300,
    minQty: 0,
    ratePerHour: 50,
    setupFee: sek(0),
    tiers: [{ minQty: 0, unit: sek(5000) }],
    window: { start: '2026-11-10T07:00:00.000Z', end: '2026-11-11T16:00:00.000Z' },
    handoffHours: 2,
    validUntil: '2026-11-20T00:00:00.000Z',
    negotiable: ['unitPrice', 'capacity', 'windowEnd'],
    provenance: prov,
    claims: [],
    ...p,
  };
}

export function smallWorld(descriptions: Record<string, string> = {}): World {
  const actors: Actor[] = [
    actor('buyer', 'Buyer AB', 'buyer'),
    actor('framvera', 'Framvera', 'platform'),
    actor('a1', 'Tryckeri Nord', 'supplier', descriptions.a1),
    actor('a2', 'Kista Pack', 'supplier', descriptions.a2),
    actor('a3', 'Solna Print', 'supplier', descriptions.a3),
    actor('a4', 'Ultra Print', 'supplier', descriptions.a4),
  ];
  const claims: Claim[] = [
    { id: 'c1', actor: 'a1', subject: 'capacity:o1', assertion: 'Line 1 runs 300 inserts per day', value: 300, tier: 'corroborated', provenance: prov },
    { id: 'c2', actor: 'a2', subject: 'capacity:o2', assertion: 'Packing 400 kits', value: 400, tier: 'single-claim', provenance: prov },
  ];
  const offers: Offer[] = [
    offer({ id: 'o1', actor: 'a1', stage: 'print', capacity: 300, tiers: [{ minQty: 0, unit: sek(4000) }], claims: ['c1'] }),
    offer({ id: 'o2', actor: 'a2', stage: 'assemble', capacity: 400, tiers: [{ minQty: 0, unit: sek(6000) }], setupFee: sek(120000), claims: ['c2'] }),
    offer({ id: 'o3', actor: 'a3', stage: 'print', capacity: 250, tiers: [{ minQty: 0, unit: sek(4600) }] }),
    offer({ id: 'o4', actor: 'a4', stage: 'print', capacity: 300, tiers: [{ minQty: 0, unit: sek(3900) }], negotiable: ['unitPrice'] }),
  ];
  return {
    id: 'w-small',
    version: 1,
    seed: 1,
    name: 'Promotional kits, Stockholm',
    currency: 'SEK',
    stages: [
      { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 1 },
      { id: 'assemble', name: 'Assemble kits', unit: 'kits', after: ['print'], perOutcome: 1 },
    ],
    actors,
    offers,
    claims,
    family: 'salvageable',
    createdAt: T0,
  };
}

export function smallIntent(): Intent {
  return {
    id: 'i-small',
    text: '500 kits by Friday under 55,000 kr',
    quantity: 500,
    budget: sek(5_500_000),
    deadline: '2026-11-13T11:00:00.000Z',
    deliverTo: 'Stockholm',
    negotiable: {},
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: false, maxSpend: sek(5_500_000) },
    provenance: { source: 'buyer', observedAt: T0 },
  };
}

export function policies(): Record<string, PolicyLike> {
  return {
    a1: { reservation: { unitPrice: 3600, capacity: 360 }, riskTolerance: 0.6, outside: sek(900_000), maxExtensionHours: 6 },
    a2: { reservation: { unitPrice: 5600, capacity: 520 }, riskTolerance: 0.4, outside: sek(2_400_000), maxExtensionHours: 4 },
    a3: { reservation: { unitPrice: 4400, capacity: 260 }, riskTolerance: 0.2, outside: sek(1_000_000) },
    a4: { reservation: { unitPrice: 3900 }, riskTolerance: 0.5, outside: sek(1_100_000) },
  };
}

export function concession(id: string, offerId: string, field: Concession['target'] extends infer T ? T extends { kind: 'offer'; field: infer F } ? F : never : never, from: number | string, to: number | string): Concession {
  return { id, target: { kind: 'offer', offer: offerId, field }, from, to, estimate: sek(10_000), rationale: 'test' };
}

/** Interventions a solver could plausibly return for the small world (hand-built, test only). */
export function smallInterventions(): Intervention[] {
  return [
    {
      id: 'iv1',
      concessions: [concession('k1', 'o1', 'capacity', 300, 350), concession('k2', 'o2', 'capacity', 400, 500)],
      unlocks: true,
      totalAfter: sek(5_300_000),
      method: 'elastic-mip',
      minimality: 'test',
    },
    {
      id: 'iv2',
      concessions: [concession('k3', 'o4', 'unitPrice', 3900, 2600), concession('k2b', 'o2', 'capacity', 400, 500)],
      unlocks: true,
      totalAfter: sek(4_900_000),
      method: 'elastic-mip',
      minimality: 'test',
    },
  ];
}
