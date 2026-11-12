import type { Actor, Agreement, Claim, EvidenceTier, Intent, Offer, Plan, World } from '@framvera/contracts';
import { accept, commitAgreement, proposeAgreement } from '@framvera/obligations';
import { solve } from '@framvera/solver';
import type { StandbyTruth } from '../src/index.ts';

export const NOW = '2026-11-16T08:00:00.000Z';
export const at = (day: number, hour: number) => new Date(Date.UTC(2026, 10, 16 + day, hour)).toISOString();
const sek = (kr: number) => ({ currency: 'SEK' as const, minor: Math.round(kr * 100) });

interface Spec {
  id: string;
  actor: string;
  stage: string;
  capacity: number;
  minQty: number;
  rate: number;
  setup: number;
  price: number;
  window: [number, number, number, number];
  handoff: number;
  tier: EvidenceTier;
  validUntil?: string;
}

const claims: Claim[] = [];
function offer(s: Spec): Offer {
  const id = `cl-cap-${s.id}`;
  claims.push({ id, actor: s.actor, subject: `capacity:${s.id}`, assertion: `Up to ${s.capacity} units.`, value: s.capacity, tier: s.tier, provenance: { source: 'synthetic-market', observedAt: NOW } });
  return {
    id: s.id,
    version: 1,
    actor: s.actor,
    stage: s.stage,
    capacity: s.capacity,
    minQty: s.minQty,
    ratePerHour: s.rate,
    setupFee: sek(s.setup),
    tiers: [{ minQty: 0, unit: sek(s.price) }],
    window: { start: at(s.window[0], s.window[1]), end: at(s.window[2], s.window[3]) },
    handoffHours: s.handoff,
    validUntil: s.validUntil ?? at(10, 0),
    negotiable: [],
    provenance: { source: 'synthetic-market', observedAt: NOW },
    claims: [id],
  };
}

const actor = (id: string, name: string, kind: Actor['kind'] = 'supplier'): Actor => ({ id, name, kind, city: 'Stockholm', description: '', active: true });

/** Print, assemble and deliver 300 kits. The assembler is the weakest link; one backup's public quote lapses Tuesday 00:00. */
export function world(): World {
  claims.length = 0;
  const offers = [
    offer({ id: 'o-print', actor: 'a-print', stage: 'print', capacity: 1000, minQty: 100, rate: 100, setup: 500, price: 10, window: [0, 8, 1, 18], handoff: 2, tier: 'verified' }),
    offer({ id: 'o-print-2', actor: 'a-print2', stage: 'print', capacity: 600, minQty: 100, rate: 80, setup: 400, price: 12, window: [0, 8, 1, 20], handoff: 2, tier: 'corroborated' }),
    offer({ id: 'o-print-3', actor: 'a-print3', stage: 'print', capacity: 600, minQty: 50, rate: 90, setup: 450, price: 13, window: [0, 9, 1, 20], handoff: 2, tier: 'corroborated' }),
    offer({ id: 'o-asm', actor: 'a-asm', stage: 'assemble', capacity: 400, minQty: 200, rate: 50, setup: 1000, price: 20, window: [1, 8, 2, 18], handoff: 1, tier: 'single-claim' }),
    offer({ id: 'o-asm-b', actor: 'a-asmb', stage: 'assemble', capacity: 400, minQty: 100, rate: 60, setup: 1200, price: 26, window: [1, 8, 2, 20], handoff: 1, tier: 'corroborated', validUntil: at(1, 0) }),
    offer({ id: 'o-asm-c', actor: 'a-asmc', stage: 'assemble', capacity: 300, minQty: 100, rate: 30, setup: 800, price: 24, window: [2, 8, 2, 20], handoff: 1, tier: 'corroborated' }),
    offer({ id: 'o-courier', actor: 'a-courier', stage: 'deliver', capacity: 1000, minQty: 0, rate: 300, setup: 800, price: 3, window: [1, 0, 3, 12], handoff: 2, tier: 'corroborated' }),
    offer({ id: 'o-courier-b', actor: 'a-courier2', stage: 'deliver', capacity: 500, minQty: 0, rate: 200, setup: 600, price: 4, window: [2, 0, 3, 12], handoff: 2, tier: 'corroborated' }),
  ];
  claims.push(
    { id: 'cl-rel-a-print', actor: 'a-print', subject: 'reliability', assertion: '98% of orders delivered on terms.', value: 0.98, tier: 'verified', provenance: { source: 'synthetic-market', observedAt: NOW } },
    { id: 'cl-rel-a-asm', actor: 'a-asm', subject: 'reliability', assertion: '80% on-time.', value: 80, tier: 'single-claim', provenance: { source: 'synthetic-market', observedAt: NOW } },
  );
  return {
    id: 'w-options',
    version: 1,
    seed: 7,
    name: 'Kits with backups',
    currency: 'SEK',
    stages: [
      { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 1 },
      { id: 'assemble', name: 'Assembly', unit: 'kits', after: ['print'], perOutcome: 1 },
      { id: 'deliver', name: 'Delivery', unit: 'kits', after: ['assemble'], perOutcome: 1 },
    ],
    actors: [
      actor('buyer', 'Buyer', 'buyer'),
      actor('a-print', 'Sundbyberg Print'),
      actor('a-print2', 'Solna Print'),
      actor('a-print3', 'Kungsholmen Print'),
      actor('a-asm', 'Kista Pack'),
      actor('a-asmb', 'Bromma Assembly'),
      actor('a-asmc', 'Haninge Assembly'),
      actor('a-courier', 'City Courier', 'logistics'),
      actor('a-courier2', 'Night Courier', 'logistics'),
    ],
    offers,
    claims: [...claims],
    family: 'fixture',
    createdAt: NOW,
  };
}

export function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i-options',
    text: '300 kits by Thursday noon',
    quantity: 300,
    budget: sek(25000),
    deadline: at(3, 12),
    deliverTo: 'Stockholm',
    negotiable: {},
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: sek(25000) },
    provenance: { source: 'buyer', observedAt: NOW },
    ...over,
  };
}

export const truth: StandbyTruth = {
  policies: {
    'a-print2': { reservation: {}, riskTolerance: 0 },
    'a-print3': { reservation: {}, riskTolerance: 0.3 },
    'a-asmb': { reservation: { unitPrice: 2500 }, riskTolerance: 0.5 },
    'a-asmc': { reservation: {}, riskTolerance: 0.5 },
    'a-courier2': { reservation: {}, riskTolerance: 0.5 },
  },
};

/** Cost-optimal plan committed through the obligations module, every party accepting the exact terms hash. */
export async function committed(w = world(), i = intent()): Promise<{ plan: Plan; agreement: Agreement }> {
  const report = await solve(w, i);
  if (!report.plan) throw new Error(`fixture plan is ${report.status}`);
  let a = proposeAgreement(report.plan, i);
  for (const p of a.parties) a = accept(a, { actor: p, message: `m-${p}`, termsHash: a.termsHash, basis: p === 'buyer' ? 'buyer' : 'synthetic-policy' });
  return { plan: report.plan, agreement: commitAgreement(a) };
}
