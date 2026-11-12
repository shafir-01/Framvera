import type { Actor, Intent, SolveReport, Stage, World } from '@framvera/contracts';
import { familyForSeed } from '../seed.ts';
import type { Family, NegotiateOut, ScenarioClient, StartRequest } from '../types.ts';

const T0 = '2026-11-12T08:00:00.000Z';

const SHAPES: Record<string, Stage[]> = {
  flagship: [
    { id: 'print', name: 'Print inserts', unit: 'inserts', after: [], perOutcome: 1 },
    { id: 'source', name: 'Source goods', unit: 'items', after: [], perOutcome: 3 },
    { id: 'assemble', name: 'Assemble', unit: 'kits', after: ['print', 'source'], perOutcome: 1 },
    { id: 'pack', name: 'Pack', unit: 'kits', after: ['assemble'], perOutcome: 1 },
    { id: 'ship', name: 'Ship', unit: 'pallets', after: ['pack'], perOutcome: 1 },
  ],
  exhibition: [
    { id: 'venue', name: 'Book venue', unit: 'days', after: [], perOutcome: 1 },
    { id: 'av', name: 'Audiovisual', unit: 'rigs', after: [], perOutcome: 1 },
    { id: 'labour', name: 'Crew', unit: 'shifts', after: ['venue'], perOutcome: 1 },
    { id: 'freight', name: 'Freight', unit: 'loads', after: ['av'], perOutcome: 1 },
    { id: 'build', name: 'Build stand', unit: 'stands', after: ['labour', 'freight'], perOutcome: 1 },
  ],
  circular: [
    { id: 'goods', name: 'Surplus goods', unit: 'lots', after: [], perOutcome: 1 },
    { id: 'services', name: 'Spare hours', unit: 'hours', after: [], perOutcome: 1 },
    { id: 'swap', name: 'Exchange cycle', unit: 'swaps', after: ['goods', 'services'], perOutcome: 1 },
    { id: 'cash', name: 'Cash adjust', unit: 'transfers', after: ['swap'], perOutcome: 1 },
  ],
  unseen: [
    { id: 'a', name: 'Cut', unit: 'parts', after: [], perOutcome: 1 },
    { id: 'b', name: 'Finish', unit: 'parts', after: ['a'], perOutcome: 1 },
    { id: 'c', name: 'Test', unit: 'units', after: ['b'], perOutcome: 1 },
  ],
};

function world(req: StartRequest): { w: World; i: Intent; family: Family | 'flagship' } {
  const key = req.template ?? 'unseen';
  const family = key === 'flagship' ? 'flagship' : (req.family ?? familyForSeed(req.seed ?? 1));
  const count = key === 'flagship' ? 22 : 8 + ((req.seed ?? 0) % 9);
  const actors: Actor[] = Array.from({ length: count }, (_, n) => ({ id: `a${n}`, name: `Supplier ${n + 1}`, kind: 'supplier', city: 'Stockholm', description: '', active: true }));
  const w: World = { id: `w-${key}-${req.seed ?? 0}`, version: 1, seed: req.seed ?? 0, name: key, currency: 'SEK', stages: SHAPES[key] ?? SHAPES.unseen!, actors, offers: [], claims: [], family, createdAt: T0 };
  const i: Intent = {
    id: 'i1',
    text: '',
    quantity: key === 'flagship' ? 500 : 120,
    budget: { currency: 'SEK', minor: 5_500_000 },
    deadline: '2026-11-20T11:00:00.000Z',
    deliverTo: 'Stockholm',
    negotiable: {},
    authority: { mayNegotiate: true, mayReserve: true, mayPreparePayments: true, maxSpend: { currency: 'SEK', minor: 5_500_000 } },
    provenance: { source: 'buyer', observedAt: T0 },
  };
  return { w, i, family };
}

function report(status: SolveReport['status'], core?: SolveReport['core']): SolveReport {
  return { status, solver: { name: 'fixture', version: '0', ms: 1 }, core };
}

export function fixtureClient(): ScenarioClient {
  const kept = new Map<string, Family | 'flagship'>();
  let n = 0;
  return {
    async start(req) {
      const { w, i, family } = world(req);
      const market = `fx-${++n}`;
      kept.set(market, family);
      return { market, world: w, intent: i };
    },
    async analyze(market) {
      const f = kept.get(market);
      if (f === 'feasible') return { report: report('optimal') };
      return {
        report: report('infeasible', {
          constraints: [
            { id: 'deadline', kind: 'deadline', text: 'The last stage must be ready by Friday 12:00.' },
            { id: 'capacity:o3', kind: 'capacity', text: 'No supplier can finish the middle stage in time.' },
          ],
          method: 'deletion-filter',
          minimal: true,
          proven: true,
          summary: 'No combination can finish the middle stage before Friday 12:00 within 55 000 kr.',
        }),
      };
    },
    async invent(market) {
      const f = kept.get(market);
      if (f === 'impossible') return { interventions: [] };
      return { interventions: [{ id: 'iv1', concessions: [], unlocks: true, method: 'elastic-mip', minimality: 'fixture' }] };
    },
    async negotiate() {
      const out: NegotiateOut = {
        accepted: [],
        report: report('optimal'),
        verification: { ok: true, checks: [] },
        intervention: { id: 'iv1', concessions: [{ id: 'c1', target: { kind: 'intent', field: 'deadline' }, from: 0, to: 1, estimate: { currency: 'SEK', minor: 0 }, rationale: '' }, { id: 'c2', target: { kind: 'intent', field: 'budget' }, from: 0, to: 1, estimate: { currency: 'SEK', minor: 0 }, rationale: '' }], unlocks: true, method: 'elastic-mip', minimality: 'fixture' },
      };
      return out;
    },
  };
}
