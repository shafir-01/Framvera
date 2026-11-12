import { describe, expect, it } from 'vitest';
import { validatePlan } from '@framvera/contracts';
import { checkFeasibility, generateWorld } from '@framvera/market';
import { solve, verifyPlan } from '../src/index.ts';

describe('agreement with the market checker', () => {
  for (const family of ['feasible', 'salvageable', 'impossible'] as const) {
    it(`matches the exact checker on generated ${family} worlds`, async () => {
      for (let seed = 1; seed <= 6; seed++) {
        const { world, intent } = generateWorld(seed, family);
        const r = await solve(world, intent, { explain: false });
        const chk = checkFeasibility(world, intent);
        if (chk.status === 'undetermined') continue;
        expect(r.plan ? 'feasible' : r.status, `${family} ${seed}`).toBe(chk.status);
        if (!r.plan) continue;
        expect(validatePlan(r.plan, world, intent)).toEqual([]);
        expect(verifyPlan(r.plan, world, intent).ok).toBe(true);
        if (chk.plan) expect(r.plan.total.minor).toBeLessThanOrEqual(chk.plan.total.minor);
        if (chk.lowerBound) expect(r.plan.total.minor).toBeGreaterThanOrEqual(chk.lowerBound.minor);
      }
    }, 60000);
  }
});
