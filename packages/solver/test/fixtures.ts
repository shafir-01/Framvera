import type { Actor, Intent, NegotiableField, Offer, Stage, World } from '@framvera/contracts';

const NOW = '2026-11-16T08:00:00.000Z';
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, 16 + day, hour)).toISOString();
const sek = (kr: number) => ({ currency: 'SEK' as const, minor: Math.round(kr * 100) });

interface OfferSpec {
  id: string;
  actor: string;
  stage: string;
  capacity: number;
  minQty: number;
  rate: number;
  setup: number;
  tiers: [number, number][];
  window: [number, number, number, number];
  handoff: number;
  negotiable?: NegotiableField[];
  validUntil?: string;
}

export function offer(s: OfferSpec): Offer {
  return {
    id: s.id,
    version: 1,
    actor: s.actor,
    stage: s.stage,
    capacity: s.capacity,
    minQty: s.minQty,
    ratePerHour: s.rate,
    setupFee: sek(s.setup),
    tiers: s.tiers.map(([minQty, kr]) => ({ minQty, unit: sek(kr) })),
    window: { start: at(s.window[0], s.window[1]), end: at(s.window[2], s.window[3]) },
    handoffHours: s.handoff,
    validUntil: s.validUntil ?? at(10, 0),
    negotiable: s.negotiable ?? [],
    provenance: { source: 'synthetic-market', observedAt: NOW },
    claims: [],
  };
}

const actor = (id: string, name: string, kind: Actor['kind'] = 'supplier'): Actor => ({
  id,
  name,
  kind,
  city: 'Stockholm',
  description: '',
  active: true,
});

export const STAGES: Stage[] = [
  { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 2 },
  { id: 'boxes', name: 'Make boxes', unit: 'boxes', after: [], perOutcome: 1 },
  { id: 'assemble', name: 'Assembly', unit: 'kits', after: ['print', 'boxes'], perOutcome: 1 },
  { id: 'deliver', name: 'Delivery', unit: 'kits', after: ['assemble'], perOutcome: 1 },
];

export function kitsWorld(overrides: Partial<Record<string, Partial<Offer>>> = {}): World {
  const offers: Offer[] = [
    offer({ id: 'o-print-a', actor: 'a-print', stage: 'print', capacity: 1200, minQty: 200, rate: 200, setup: 1500, tiers: [[0, 12], [800, 10]], window: [0, 8, 1, 18], handoff: 4 }),
    offer({ id: 'o-print-b', actor: 'a-fastprint', stage: 'print', capacity: 600, minQty: 100, rate: 150, setup: 800, tiers: [[0, 14]], window: [0, 10, 2, 18], handoff: 2, negotiable: ['unitPrice'] }),
    offer({ id: 'o-box', actor: 'a-box', stage: 'boxes', capacity: 600, minQty: 300, rate: 100, setup: 1000, tiers: [[0, 18], [500, 15]], window: [0, 8, 2, 12], handoff: 6 }),
    offer({ id: 'o-asm-kista', actor: 'a-kista', stage: 'assemble', capacity: 300, minQty: 250, rate: 40, setup: 2000, tiers: [[0, 25]], window: [1, 8, 3, 18], handoff: 2, negotiable: ['joint', 'windowEnd'] }),
    offer({ id: 'o-asm-solna', actor: 'a-solna', stage: 'assemble', capacity: 300, minQty: 250, rate: 50, setup: 2500, tiers: [[0, 24]], window: [1, 12, 3, 20], handoff: 2, negotiable: ['joint', 'minQty'] }),
    offer({ id: 'o-asm-big', actor: 'a-big', stage: 'assemble', capacity: 600, minQty: 400, rate: 60, setup: 3000, tiers: [[0, 30]], window: [2, 8, 4, 8], handoff: 1, negotiable: ['unitPrice', 'windowStart', 'capacity'] }),
    offer({ id: 'o-courier', actor: 'a-courier', stage: 'deliver', capacity: 1000, minQty: 0, rate: 500, setup: 1500, tiers: [[0, 3]], window: [1, 0, 4, 10], handoff: 2, negotiable: ['windowEnd', 'setupFee'] }),
  ].map((o) => ({ ...o, ...(overrides[o.id] ?? {}) }));
  return {
    id: 'w-kits',
    version: 1,
    seed: 1,
    name: 'Promotional kits, Stockholm',
    currency: 'SEK',
    stages: STAGES,
    actors: [
      actor('a-buyer', 'Buyer', 'buyer'),
      actor('a-print', 'Sundbyberg Print'),
      actor('a-fastprint', 'Fast Print Solna'),
      actor('a-box', 'Box Works'),
      actor('a-kista', 'Kista Pack'),
      actor('a-solna', 'Solna Assembly'),
      actor('a-big', 'Big Assembly Co'),
      actor('a-courier', 'City Courier', 'logistics'),
    ],
    offers,
    claims: [],
    family: 'fixture',
    createdAt: NOW,
  };
}

export function kitsIntent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i-kits',
    text: '500 promotional kits by Friday noon',
    quantity: 500,
    budget: sek(55000),
    deadline: at(4, 12),
    deliverTo: 'Stockholm',
    negotiable: { deadlineHours: 24, budgetMinor: 500000 },
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: sek(60000) },
    provenance: { source: 'buyer', observedAt: NOW },
    ...over,
  };
}

export { at, sek, NOW };
