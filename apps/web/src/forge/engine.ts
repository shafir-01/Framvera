import type { Coalition, Intent, Plan, SolveReport, World } from '@framvera/contracts';
import type { ForgeEngine, SplitResult } from './analyze.ts';

type SolveFn = (world: World, intent: Intent, opts?: { coalitions?: Coalition[]; timeLimitMs?: number }) => Promise<SolveReport>;

/** The in-browser solver worker owned by the surgery module, when it has landed. */
const surgery = import.meta.glob<Record<string, unknown>>('../surgery/solver.ts');

async function loadSolve(): Promise<SolveFn> {
  const load = Object.values(surgery)[0];
  if (load) {
    const mod = await load();
    if (typeof mod.solveInBrowser === 'function') return mod.solveInBrowser as SolveFn;
  }
  const mod = await import('@framvera/solver');
  return mod.solve as unknown as SolveFn;
}

async function loadSplit(): Promise<ForgeEngine['split']> {
  try {
    const mod = (await import('@framvera/negotiation')) as Record<string, unknown>;
    if (typeof mod.splitCoalition === 'function') return mod.splitCoalition as ForgeEngine['split'];
  } catch {
    /* fall through to the module file */
  }
  const mod = await import('../../../../packages/negotiation/src/coalition.ts');
  return mod.splitCoalition as unknown as ForgeEngine['split'];
}

let cached: Promise<ForgeEngine> | undefined;

export function defaultEngine(): Promise<ForgeEngine> {
  cached ??= (async () => {
    const [solve, split, verifier] = await Promise.all([loadSolve(), loadSplit(), import('@framvera/solver')]);
    return {
      solve,
      split: split as (c: Coalition, p: never, ctx: never) => SplitResult,
      verify: (plan: Plan, world: World, intent: Intent) => verifier.verifyPlan(plan, world, intent),
    } as ForgeEngine;
  })();
  cached.catch(() => {
    cached = undefined;
  });
  return cached;
}
