import type { InfeasibleCore } from '@framvera/contracts';
import type { Outcome, ScenarioClient, Started } from './types.ts';

const OK = new Set(['optimal', 'feasible']);

export function coreOutcome(core: InfeasibleCore | undefined): Outcome {
  if (!core) return { kind: 'unsolved', reason: 'No reason returned.' };
  return {
    kind: 'impossible',
    summary: core.summary,
    reasons: core.constraints.slice(0, 4).map((c) => c.text),
    smallest: core.minimal && core.proven,
  };
}

/** Solve as published, then search for changes, then ask the suppliers. */
export async function runScenario(client: ScenarioClient, s: Started): Promise<Outcome> {
  const first = await client.analyze(s.market, s.intent);
  if (OK.has(first.report.status)) return { kind: 'feasible' };
  if (first.report.status !== 'infeasible') return { kind: 'unsolved', reason: 'Ran out of time.' };
  const found = await client.invent(s.market, s.intent);
  const unlocking = found.interventions.filter((i) => i.unlocks);
  if (unlocking.length === 0) return coreOutcome(first.report.core);
  const run = await client.negotiate(s.market, s.intent);
  const made = OK.has(run.report.status) && run.verification.ok;
  if (made) return { kind: 'made-possible', changes: Math.max(1, run.intervention?.concessions.length ?? run.accepted.length) };
  return { kind: 'declined', changes: Math.max(1, unlocking[0]?.concessions.length ?? 1) };
}

export interface Line {
  label: string;
  detail?: string;
  tone: 'ok' | 'new' | 'stop' | 'plain';
}

function lead(s: string): string {
  const t = s.trim().replace(/\s*[—–]\s*/g, ', ').replace(/\.$/, '');
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function plural(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}

export function outcomeLine(o: Outcome): Line {
  switch (o.kind) {
    case 'feasible':
      return { label: 'Feasible as published', tone: 'ok' };
    case 'made-possible':
      return { label: `Made possible by ${plural(o.changes)}`, tone: 'new' };
    case 'declined':
      return { label: 'Not made possible', detail: `Needs ${plural(o.changes)}. Suppliers declined.`, tone: 'plain' };
    case 'impossible':
      return { label: `Impossible: ${lead(o.summary)}`, detail: o.smallest ? undefined : 'May not be the smallest cause.', tone: 'stop' };
    case 'unsolved':
      return { label: 'No answer', detail: o.reason, tone: 'plain' };
  }
}
