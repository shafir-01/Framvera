import { describe, expect, it } from 'vitest';
import { branchOf, chapterOf, reasonFor, snapshotAt, spans } from './model.ts';
import { replayEvents, replayProps } from './dev/fixture.ts';

const last = replayEvents.length - 1;
const world = replayProps.world;

describe('replay model', () => {
  it('detects all six chapters in order', () => {
    expect(spans(chapterOf(replayEvents)).map((s) => s.chapter)).toEqual(['Impossible', 'Invention', 'Agreement', 'Payment', 'Disruption', 'Recovery']);
  });

  it('hides everything after the cursor', () => {
    const early = snapshotAt(replayEvents, world, 2);
    expect(early.obligations).toHaveLength(0);
    expect(early.payments).toHaveLength(0);
    expect(early.offers.some((o) => o.derived)).toBe(false);
    expect(early.solve?.status).toBe('infeasible');
  });

  it('shows derived offers only after an accepted decision', () => {
    expect(snapshotAt(replayEvents, world, 4).offers.some((o) => o.derived)).toBe(true);
  });

  it('records PayPal status verbatim and marks obligations at risk after disruption', () => {
    const end = snapshotAt(replayEvents, world, last);
    expect(end.payments[0]?.paypalStatus).toBe('COMPLETED');
    expect(end.obligations.find((o) => o.id === 'ob_2')?.state).toBe('AT_RISK');
  });

  it('reports recorded causes and falls back honestly', () => {
    expect(reasonFor(replayEvents, last, world)?.recorded).toBe(true);
    const bare = replayEvents.map((e) => ({ ...e, causes: [] }));
    const r = reasonFor(bare, 3, world);
    expect(r?.recorded).toBe(false);
    expect(r?.prior?.index).toBe(2);
  });

  it('builds the branch comparison without inventing costs', () => {
    const b = branchOf(snapshotAt(replayEvents, world, last).recovery);
    expect(b?.rejected).toHaveLength(2);
    expect(b?.cheaperRejected).toBe(true);
    expect(b?.rejected[1]?.extraCost).toBeUndefined();
  });
});
