import type { Deps } from './types.ts';

const REQUIRED: Record<string, string[]> = {
  '@framvera/market': ['generateWorld', 'flagshipWorld'],
  '@framvera/solver': ['solve', 'findInterventions', 'applyConcessions', 'verifyPlan'],
  '@framvera/negotiation': ['selectQuestions', 'decide', 'challengeClaims', 'splitCoalition'],
  '@framvera/obligations': ['commit', 'disrupt', 'recover'],
};

export async function loadDeps(): Promise<Deps> {
  const mods: Record<string, Record<string, unknown>> = {};
  const missing: string[] = [];
  for (const [name, fns] of Object.entries(REQUIRED)) {
    const m = (await import(name)) as Record<string, unknown>;
    mods[name] = m;
    for (const f of fns) if (typeof m[f] !== 'function') missing.push(`${name}.${f}`);
  }
  if (missing.length) throw new Error(`modules not ready, missing exports: ${missing.join(', ')}`);
  return {
    market: mods['@framvera/market'] as unknown as Deps['market'],
    solver: mods['@framvera/solver'] as unknown as Deps['solver'],
    negotiation: mods['@framvera/negotiation'] as unknown as Deps['negotiation'],
    obligations: mods['@framvera/obligations'] as unknown as Deps['obligations'],
  };
}
