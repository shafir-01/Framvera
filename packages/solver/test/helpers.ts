import type { Intent, World } from '@framvera/contracts';
import { compile } from '../src/index.ts';
import { STRUCTURAL } from '../src/explain.ts';
import { run } from '../src/lp.ts';

/** Solver status with only the given constraint groups active, plus demand and step order, which stay fixed. */
export async function statusWith(world: World, intent: Intent, enabled: Set<string>): Promise<string> {
  const full = compile(world, intent);
  const keep = (g: string) => enabled.has(g) || STRUCTURAL.has(full.refs.get(g)!.kind);
  const c = compile(world, intent, { disabled: new Set([...full.refs.keys()].filter((g) => !keep(g))) });
  c.model.objective = [];
  return (await run(c.model)).status;
}
