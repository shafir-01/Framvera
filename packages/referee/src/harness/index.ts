import type { Intent, World } from '@framvera/contracts';
import type { RunConfig } from '../strategies.ts';
import type { Deps, HiddenTruthLike, Outcome } from '../types.ts';
import { HARNESS_DEFAULTS, runAgentEpisode, type HarnessOptions } from './agent.ts';
import { Meter } from './meter.ts';
import { liveModel, type ModelClient } from './model.ts';

export { HARNESS_DEFAULTS, SYSTEM_PROMPT, runAgentEpisode, taskText } from './agent.ts';
export type { HarnessOptions } from './agent.ts';
export { BudgetExhausted, CALL_BUDGET, MODEL_ID, Meter, SPEND_FILE } from './meter.ts';
export { liveModel } from './model.ts';
export type { ModelClient, ModelRequest } from './model.ts';
export { parseQuestion } from './parse.ts';

let override: ModelClient | null = null;
let meter: Meter | null = null;
let live: ModelClient | null = null;
let options: HarnessOptions = HARNESS_DEFAULTS;

/** Tests inject a scripted model; pass null to return to the live client. */
export function setHarnessModel(m: ModelClient | null): void {
  override = m;
}

export function setHarnessOptions(o: Partial<HarnessOptions>): void {
  options = { ...HARNESS_DEFAULTS, ...o };
}

export function harnessMeter(): Meter {
  return (meter ??= new Meter());
}

export async function runAgentHarness(deps: Deps, world: World, intent: Intent, truth: HiddenTruthLike, cfg: RunConfig): Promise<Outcome> {
  const m = override ?? (live ??= liveModel(harnessMeter()));
  const out = await runAgentEpisode(m, deps, world, intent, truth, cfg, options);
  if (!override) harnessMeter().episode();
  return out;
}
