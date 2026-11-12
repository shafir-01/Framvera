import { describe, expect, it } from 'vitest';
import * as market from '@framvera/market';
import { compareMechanisms } from '../src/index.ts';

const flagship = (market as { flagshipWorld?: () => { world: any; intent: any; truth: any } }).flagshipWorld;

describe.skipIf(!flagship)('flagship world', () => {
  it('compares mechanisms against the hidden policies without leaking them', async () => {
    const { world, intent, truth } = flagship!();
    const exp = await compareMechanisms(world, intent, truth, { trials: 4, seed: 2 });
    expect(exp.runs).toHaveLength(4);
    for (const m of exp.mechanisms) {
      expect(m.counted).toBeLessThanOrEqual(m.verified);
      expect(m.belowCost).toBe(0);
    }
    expect(JSON.stringify(exp)).not.toMatch(/"reservation"|"riskTolerance"|"realCapacity"/);
    expect(exp.statement.length).toBeGreaterThan(0);
  }, 120_000);
});
