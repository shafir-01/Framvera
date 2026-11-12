import type { Actor, Intent, Offer, World } from '@framvera/contracts';
import type { PackageBid } from '../src/index.ts';

export const NOW = '2026-11-16T08:00:00.000Z';
export const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, 16 + day, hour)).toISOString();
export const kr = (n: number) => ({ currency: 'SEK' as const, minor: Math.round(n * 100) });

interface Spec {
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
}

export function offer(s: Spec): Offer {
  return {
    id: s.id,
    version: 1,
    actor: s.actor,
    stage: s.stage,
    capacity: s.capacity,
    minQty: s.minQty,
    ratePerHour: s.rate,
    setupFee: kr(s.setup),
    tiers: s.tiers.map(([minQty, unit]) => ({ minQty, unit: kr(unit) })),
    window: { start: at(s.window[0], s.window[1]), end: at(s.window[2], s.window[3]) },
    handoffHours: s.handoff,
    validUntil: at(10, 0),
    negotiable: ['unitPrice', 'setupFee'],
    provenance: { source: 'synthetic-market', observedAt: NOW },
    claims: [],
  };
}

const actor = (id: string, name: string, kind: Actor['kind'] = 'supplier'): Actor => ({ id, name, kind, city: 'Stockholm', description: '', active: true });

export function world(extra: Offer[] = []): World {
  return {
    id: 'w-mech',
    version: 1,
    seed: 7,
    name: 'Gift boxes, Stockholm',
    currency: 'SEK',
    stages: [
      { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 1 },
      { id: 'assemble', name: 'Assembly', unit: 'kits', after: ['print'], perOutcome: 1 },
      { id: 'deliver', name: 'Delivery', unit: 'kits', after: ['assemble'], perOutcome: 1 },
    ],
    actors: [
      actor('b1', 'Buyer', 'buyer'),
      actor('s-print-a', 'Bromma Print'),
      actor('s-print-b', 'Solna Print'),
      actor('s-combo', 'Kista Print and Pack'),
      actor('s-asm-a', 'Nacka Assembly'),
      actor('s-courier', 'City Courier', 'logistics'),
    ],
    offers: [
      offer({ id: 'o-pa', actor: 's-print-a', stage: 'print', capacity: 600, minQty: 100, rate: 100, setup: 1000, tiers: [[0, 10], [250, 7]], window: [0, 8, 2, 18], handoff: 2 }),
      offer({ id: 'o-pb', actor: 's-print-b', stage: 'print', capacity: 400, minQty: 50, rate: 80, setup: 500, tiers: [[0, 12]], window: [0, 8, 2, 18], handoff: 2 }),
      offer({ id: 'o-pc', actor: 's-combo', stage: 'print', capacity: 500, minQty: 100, rate: 100, setup: 1500, tiers: [[0, 11]], window: [0, 8, 2, 18], handoff: 1 }),
      offer({ id: 'o-ac', actor: 's-combo', stage: 'assemble', capacity: 500, minQty: 100, rate: 50, setup: 2000, tiers: [[0, 20]], window: [1, 0, 3, 18], handoff: 1 }),
      offer({ id: 'o-aa', actor: 's-asm-a', stage: 'assemble', capacity: 400, minQty: 200, rate: 40, setup: 2500, tiers: [[0, 22], [300, 19]], window: [1, 0, 3, 18], handoff: 2 }),
      offer({ id: 'o-c', actor: 's-courier', stage: 'deliver', capacity: 1000, minQty: 0, rate: 300, setup: 800, tiers: [[0, 3]], window: [1, 0, 4, 18], handoff: 2 }),
      ...extra,
    ],
    claims: [],
    family: 'fixture',
    createdAt: NOW,
  };
}

export function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i-1',
    text: '300 gift boxes by Friday noon',
    quantity: 300,
    budget: kr(30000),
    deadline: at(4, 12),
    deliverTo: 'Stockholm',
    negotiable: {},
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: kr(30000) },
    provenance: { source: 'buyer', observedAt: NOW },
    ...over,
  };
}

export function bid(id: string, bidder: string, items: [string, number][], price: number, group?: string): PackageBid {
  return {
    id,
    bidder,
    items: items.map(([offer, qty]) => ({ offer, qty })),
    price: kr(price),
    ...(group ? { exclusiveGroup: group } : {}),
    provenance: { source: 'seller-terminal', observedAt: NOW },
  };
}

/** Private reservation limits for the selector experiment (test-only stand-in for the market's hidden truth). */
export const truth = {
  policies: {
    's-print-a': { reservation: { unitPrice: 800, setupFee: 60000 } },
    's-print-b': { reservation: { unitPrice: 1000, setupFee: 30000 } },
    's-combo': { offers: { 'o-pc': { unitPrice: 850, setupFee: 100000 }, 'o-ac': { unitPrice: 1500, setupFee: 120000 } } },
    's-asm-a': { reservation: { unitPrice: 1800, setupFee: 200000 } },
    's-courier': { reservation: { unitPrice: 250, setupFee: 50000 } },
  },
};
