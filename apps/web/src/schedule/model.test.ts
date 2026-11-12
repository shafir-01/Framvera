import { describe, expect, it } from 'vitest';
import { buildModel } from './model.ts';
import { scenario } from './dev/fixture.ts';

describe('schedule model', () => {
  it('derives windows, handoffs and edges from real intervals', () => {
    const m = buildModel(scenario('plan'));
    const kista = m.lanes.flatMap((l) => l.bars).find((b) => b.offer === 'o_kista')!;
    expect(kista.window!.to).toBeGreaterThan(kista.originalWindow!.to);
    expect(kista.finish - kista.workEnd).toBe(3_600_000);
    expect(m.edges.length).toBe(4);
    expect(m.edges.every((e) => !e.broken)).toBe(true);
    expect(m.marginHours).toBeGreaterThan(0);
  });
  it('marks withdrawn and at-risk bars', () => {
    const st = buildModel(scenario('disrupted')).lanes.flatMap((l) => l.bars).map((b) => `${b.offer}:${b.status}`);
    expect(st).toContain('o_kista:withdrawn');
    expect(st).toContain('o_arsta:at-risk');
  });
  it('shows recovery bars as added or moved and keeps the rest', () => {
    const st = buildModel(scenario('recovered')).lanes.flatMap((l) => l.bars).map((b) => `${b.offer}:${b.status}`);
    expect(st).toContain('o_farsta:added');
    expect(st).toContain('o_arsta:amended');
    expect(st).toContain('o_bromma:kept');
  });
});
