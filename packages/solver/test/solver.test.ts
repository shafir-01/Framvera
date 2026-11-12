import { describe, expect, it } from 'vitest';
import type { Intent, World } from '@framvera/contracts';
import { applyCoalition, compile, applyConcessions, explainInfeasible, findInterventions, solve, verifyPlan } from '../src/index.ts';
import { statusWith } from './helpers.ts';
import { at, kitsIntent, kitsWorld, sek } from './fixtures.ts';

const feasibleWith = statusWith;

describe('solve', () => {
  it('finds the cheapest plan and it passes the independent check', async () => {
    const w = kitsWorld();
    const i = kitsIntent();
    const r = await solve(w, i);
    expect(r.status).toBe('optimal');
    expect(r.solver.name).toBe('HiGHS');
    expect(r.plan!.total).toEqual(sek(39750));
    expect(verifyPlan(r.plan!, w, i).ok).toBe(true);
    expect(Date.parse(r.plan!.readyAt)).toBeLessThanOrEqual(Date.parse(i.deadline));
  });

  it('uses the cheaper volume tier when buying more is cheaper overall', async () => {
    const w = kitsWorld();
    const r = await solve(w, kitsIntent());
    const box = r.plan!.allocations.find((a) => a.offer === 'o-box')!;
    expect(box.qty).toBe(500);
    expect(box.cost.minor).toBe(500 * 1500 + 100000);
  });

  it('reports a proven infeasibility with a core when the deadline is too tight', async () => {
    const w = kitsWorld();
    const i = kitsIntent({ deadline: at(1, 20) });
    const r = await solve(w, i);
    expect(r.status).toBe('infeasible');
    expect(r.plan).toBeUndefined();
    expect(r.core!.proven).toBe(true);
    expect(r.core!.minimal).toBe(true);
    expect(r.core!.constraints.map((c) => c.id)).toContain('deadline');
  });

  it('respects expired offers and inactive suppliers', async () => {
    const w = kitsWorld({ 'o-print-b': { validUntil: at(-1, 0) } });
    w.actors = w.actors.map((a) => (a.id === 'a-solna' ? { ...a, active: false } : a));
    const i = kitsIntent({ deadline: at(4, 12) });
    const r = await solve(w, i);
    expect(r.plan!.allocations.some((a) => a.offer === 'o-print-b' || a.offer === 'o-asm-solna')).toBe(false);
    expect(verifyPlan(r.plan!, w, i).ok).toBe(true);
  });
});

describe('infeasible core', () => {
  const cases: [string, Intent][] = [
    ['deadline', kitsIntent({ deadline: at(1, 20) })],
    ['budget', kitsIntent({ budget: sek(30000) })],
    ['both', kitsIntent({ deadline: at(1, 21), budget: sek(38000) })],
  ];
  for (const [label, intent] of cases) {
    it(`is minimal with respect to constraint groups (${label})`, async () => {
      const w = kitsWorld();
      const core = await explainInfeasible(w, intent);
      expect(core.proven).toBe(true);
      expect(core.minimal).toBe(true);
      const ids = new Set(core.constraints.map((c) => c.id));
      expect(ids.size).toBeGreaterThan(0);
      expect(await feasibleWith(w, intent, ids)).toBe('infeasible');
      for (const id of ids) {
        const without = new Set([...ids].filter((x) => x !== id));
        expect(await feasibleWith(w, intent, without), `dropping ${id}`).toBe('optimal');
      }
      for (const c of core.constraints) expect(c.text.length).toBeGreaterThan(10);
      expect(core.summary).toMatch(/cannot all hold/);
    });
  }

  it('says so when a plan exists', async () => {
    const core = await explainInfeasible(kitsWorld(), kitsIntent());
    expect(core.constraints).toEqual([]);
    expect(core.proven).toBe(false);
  });
});

describe('interventions', () => {
  it('finds verified changes only on negotiable fields', async () => {
    const w = kitsWorld();
    const i = kitsIntent({ deadline: at(1, 20) });
    const ivs = await findInterventions(w, i);
    expect(ivs.length).toBeGreaterThan(0);
    for (const iv of ivs) {
      expect(iv.unlocks).toBe(true);
      for (const c of iv.concessions) {
        if (c.target.kind === 'offer') {
          const t = c.target;
          expect(w.offers.find((o) => o.id === t.offer)!.negotiable).toContain(t.field);
        } else {
          expect(c.rationale).toMatch(/consent/);
        }
      }
      const next = applyConcessions(w, i, iv.concessions);
      const r = await solve(next.world, next.intent);
      expect(['optimal', 'feasible']).toContain(r.status);
      expect(verifyPlan(r.plan!, next.world, next.intent).ok).toBe(true);
      expect(iv.minimality).toMatch(/Supplier acceptance is unknown/);
    }
    expect(ivs[0]!.concessions).toHaveLength(1);
    expect(ivs[0]!.concessions[0]!.target).toEqual({ kind: 'offer', offer: 'o-asm-big', field: 'windowStart' });
  });

  it('proposes nothing when no field is negotiable', async () => {
    const w = kitsWorld();
    w.offers = w.offers.map((o) => ({ ...o, negotiable: [] }));
    const i = kitsIntent({ deadline: at(1, 20), negotiable: {} });
    expect(await findInterventions(w, i)).toEqual([]);
  });

  it('returns an empty list when the request is already feasible', async () => {
    expect(await findInterventions(kitsWorld(), kitsIntent())).toEqual([]);
  });

  it('honours maxChanges', async () => {
    const w = kitsWorld();
    const i = kitsIntent({ deadline: at(1, 20), negotiable: {} });
    const ivs = await findInterventions(w, i, { maxChanges: 1, k: 5 });
    for (const iv of ivs) expect(iv.concessions.length).toBeLessThanOrEqual(1);
  });

  it('returns distinct change sets', async () => {
    const w = kitsWorld();
    const i = kitsIntent({ deadline: at(1, 20) });
    const ivs = await findInterventions(w, i, { k: 4 });
    const sets = ivs.map((iv) => iv.concessions.map((c) => JSON.stringify(c.target)).sort().join('|'));
    expect(new Set(sets).size).toBe(sets.length);
  });
});

describe('applyConcessions', () => {
  it('is pure, versioned and records where offers came from', async () => {
    const w = kitsWorld();
    const i = kitsIntent({ deadline: at(1, 20) });
    const before = JSON.stringify(w);
    const ivs = await findInterventions(w, i, { userOptions: false });
    const next = applyConcessions(w, i, ivs[0]!.concessions);
    expect(JSON.stringify(w)).toBe(before);
    expect(next.world.version).toBe(w.version + 1);
    const changed = next.world.offers.find((o) => o.id === 'o-asm-big')!;
    expect(changed.version).toBe(2);
    expect(changed.derivedFrom!.concessions).toEqual([ivs[0]!.concessions[0]!.id]);
  });

  it('lets one member offer serve only one job: its own order or one joint offer', () => {
    const w = kitsWorld();
    w.actors.push({ id: 'a-van2', name: 'Second Crew', kind: 'supplier', city: 'Stockholm', description: '', active: true });
    const solna = w.offers.find((o) => o.id === 'o-asm-solna')!;
    w.offers.push({ ...solna, id: 'o-asm-solna2', actor: 'a-van2', capacity: 100 });
    w.offers = w.offers.map((o) => (o.id === 'o-asm-solna' ? { ...o, capacity: 100 } : o));
    const joined = applyCoalition(applyCoalition(w, 'joint:shared:o-asm-kista>o-asm-solna'), 'joint:shared:o-asm-kista>o-asm-solna2');
    const c = compile(joined, kitsIntent());
    const row = c.model.rows.find((r) => r.group === 'exclusive:o-asm-kista')!;
    const users = ['o-asm-kista', 'joint:shared:o-asm-kista>o-asm-solna', 'joint:shared:o-asm-kista>o-asm-solna2'].map((id) => c.offers.find((o) => o.offer.id === id)!.u);
    expect(row.terms.map((t) => t.v).sort()).toEqual(users.sort());
    expect(row.sense).toBe('<=');
    expect(row.rhs).toBe(1);
  });

  it('sells every quantity at exactly the agreed unit price', () => {
    const w = kitsWorld();
    const next = applyConcessions(w, kitsIntent(), [
      { id: 'p', target: { kind: 'offer', offer: 'o-print-a', field: 'unitPrice' }, from: 9999, to: 1100, estimate: sek(0), rationale: '' },
    ]);
    const tiers = next.world.offers.find((o) => o.id === 'o-print-a')!.tiers;
    expect(tiers).toEqual([{ minQty: 0, unit: sek(11) }]);
  });

  it('applies a supplier counter on any field but refuses joint work from an offer not open to it', () => {
    const w = kitsWorld();
    const next = applyConcessions(w, kitsIntent(), [
      { id: 'x', target: { kind: 'offer', offer: 'o-box', field: 'setupFee' }, from: 100000, to: 120000, estimate: sek(200), rationale: '' },
    ]);
    expect(next.world.offers.find((o) => o.id === 'o-box')!.setupFee.minor).toBe(120000);
    expect(() =>
      applyConcessions(w, kitsIntent(), [
        { id: 'y', target: { kind: 'offer', offer: 'o-box', field: 'joint' }, from: 'separate', to: 'joint:shared:o-box>o-print-a', estimate: sek(0), rationale: '' },
      ]),
    ).toThrow(/not open to joint work/);
  });
});
