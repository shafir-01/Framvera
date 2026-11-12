import { describe, expect, it } from 'vitest';
import { flagshipWorld } from '@framvera/market';
import { negotiate } from '@framvera/negotiation';
import { accept, commitAgreement, proposeAgreement } from '@framvera/obligations';
import { acceptOptions, discoverOptions, robustness, valueOptions } from '../src/index.ts';

describe('flagship market', () => {
  it('discovers, values and stress-tests standby options on the negotiated plan', async () => {
    const fl = flagshipWorld();
    const run = await negotiate(fl.world, fl.intent, fl.truth);
    expect(run.after?.plan).toBeDefined();
    const world = run.world!;
    const intent = run.intentAfter ?? fl.intent;
    let a = proposeAgreement(run.after!.plan!, intent);
    for (const p of a.parties) a = accept(a, { actor: p, message: `m-${p}`, termsHash: a.termsHash, basis: p === 'buyer' ? 'buyer' : 'synthetic-policy' });
    a = commitAgreement(a);

    const disc = discoverOptions(world, intent, a, { truth: fl.truth });
    expect(disc.targets.length).toBeGreaterThan(0);
    for (const o of disc.options) expect(o.check.ok).toBe(true);
    for (const u of disc.unsuitable) expect(u.reason.length).toBeGreaterThan(0);

    const val = await valueOptions(world, intent, a, disc.options, { scenarios: 100, seed: 7 });
    expect(val.fees.minor).toBeLessThanOrEqual(val.budget.minor);
    for (const v of val.options) if (v.buy) expect(v.marginal!.minor).toBeGreaterThan(v.fee.minor);
    expect(val.withOptions.expected.minor).toBeLessThanOrEqual(val.baseline.expected.minor);

    const r = await robustness(world, intent, a, acceptOptions(disc.options, val.buy), { recoverable: false });
    expect(r.total).toBeGreaterThan(0);
    expect(r.covered).toBeLessThanOrEqual(r.total);
  });
});
