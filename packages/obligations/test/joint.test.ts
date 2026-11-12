import { describe, expect, it } from 'vitest';
import { flagshipWorld } from '@framvera/market';
import { applyConcessions, solve } from '@framvera/solver';
import { commit, reservations, sign } from '../src/agreement.ts';
import { disrupt } from '../src/disrupt.ts';

const JOINT = 'joint:shared:o-roslagen>o-lindqvist';

describe('a shared delivery in an agreement', async () => {
  const { world, intent, truth } = flagshipWorld();
  const agreed = applyConcessions(world, intent, truth.certificate!.concessions);
  const plan = (await solve(agreed.world, agreed.intent, { explain: false })).plan!;
  const job = plan.allocations.find((a) => a.offer === JOINT)!;
  const proposed = commit(plan, agreed.intent, [], { world: agreed.world, at: agreed.world.createdAt });

  it('gives every member its own obligation with its exact share', () => {
    const parts = proposed.obligations.filter((o) => o.offer === JOINT);
    expect(parts.map((o) => o.actor).sort()).toEqual(['a-lindqvist', 'a-roslagen']);
    expect(parts.reduce((s, o) => s + o.amount.minor, 0)).toBe(job.cost.minor);
    for (const o of parts) expect(o.qty).toBe(job.qty);
    expect(proposed.parties).toEqual(expect.arrayContaining(['a-lindqvist', 'a-roslagen']));
    const total = proposed.obligations.reduce((s, o) => s + o.amount.minor, 0);
    expect(total).toBe(plan.total.minor);
  });

  it('lets each member sign the same terms and counts the van once', () => {
    const r = sign(proposed, agreed.world, undefined, { at: agreed.world.createdAt });
    const signers = r.accepts.map((m) => m.from);
    expect(signers).toEqual(expect.arrayContaining(['a-lindqvist', 'a-roslagen']));
    expect(r.declined.filter((x) => x.actor === 'a-roslagen' || x.actor === 'a-lindqvist')).toEqual([]);
    expect(r.agreement.state).toBe('COMMITTED');
    expect(reservations([r.agreement]).get(JOINT)).toBe(job.qty);
  });

  it('fails both members’ parts when either member withdraws', () => {
    const committed = sign(proposed, agreed.world, undefined, { at: agreed.world.createdAt }).agreement;
    for (const actor of ['a-lindqvist', 'a-roslagen']) {
      const impact = disrupt(committed, agreed.world, { id: `d-${actor}`, kind: 'withdraw', actor, detail: 'withdraws', at: agreed.world.createdAt });
      const failed = impact.failed.filter((o) => o.offer === JOINT).map((o) => o.actor).sort();
      expect(failed).toEqual(['a-lindqvist', 'a-roslagen']);
    }
  });
});
