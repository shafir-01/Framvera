import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixtureClient } from './dev/fixtureClient.ts';
import { layoutStages, stageChain, stageDepths } from './graph.ts';
import { outcomeLine, runScenario } from './outcome.ts';
import { familyForSeed, parseSeed } from './seed.ts';
import { StageGraph } from './StageGraph.tsx';
import type { Family } from './types.ts';

async function run(seed: number, family: Family) {
  const c = fixtureClient();
  const s = await c.start({ template: 'unseen', seed, family });
  return runScenario(c, { ...s, template: 'unseen', seed });
}

describe('seed', () => {
  it('maps a seed to the same family every time and spreads across all three', () => {
    expect(familyForSeed(42)).toBe(familyForSeed(42));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => familyForSeed(i + 1)));
    expect(seen.size).toBe(3);
  });
  it('accepts only up to nine digits', () => {
    expect(parseSeed(' 2718 ')).toBe(2718);
    expect(parseSeed('12a')).toBeNull();
    expect(parseSeed('')).toBeNull();
    expect(parseSeed('1234567890')).toBeNull();
  });
});

describe('graph', () => {
  const stages = [
    { id: 'a', name: 'A', unit: 'u', after: [], perOutcome: 1 },
    { id: 'b', name: 'B', unit: 'u', after: [], perOutcome: 1 },
    { id: 'c', name: 'C', unit: 'u', after: ['a', 'b'], perOutcome: 1 },
    { id: 'd', name: 'D', unit: 'u', after: ['c'], perOutcome: 1 },
  ];
  it('layers by longest path and draws one edge per dependency', () => {
    expect([...stageDepths(stages).entries()]).toEqual([['a', 0], ['b', 0], ['c', 1], ['d', 2]]);
    const L = layoutStages(stages);
    expect(L.edges).toHaveLength(3);
    expect(stageChain(stages).slice(-1)).toEqual(['D']);
  });
  it('survives a cycle without looping', () => {
    const cyc = stages.map((s) => (s.id === 'a' ? { ...s, after: ['d'] } : s));
    expect(layoutStages(cyc).nodes).toHaveLength(4);
  });
  it('renders names from the real stages', () => {
    const html = renderToStaticMarkup(<StageGraph stages={stages} label="x" />);
    expect(html).toContain('>C<');
  });
});

describe('outcomes', () => {
  it('feasible family is feasible as published', async () => {
    const o = await run(1, 'feasible');
    expect(outcomeLine(o).label).toBe('Feasible as published');
  });
  it('salvageable family reports the number of changes', async () => {
    const o = await run(2, 'salvageable');
    expect(outcomeLine(o).label).toBe('Made possible by 2 changes');
  });
  it('impossible family states the blocking reason and offers no workaround', async () => {
    const o = await run(3, 'impossible');
    const line = outcomeLine(o);
    expect(o.kind).toBe('impossible');
    expect(line.label.startsWith('Impossible: no combination')).toBe(true);
    expect(line.label).not.toMatch(/[—–]/);
  });
});
