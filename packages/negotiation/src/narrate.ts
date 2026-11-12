import type { World } from '@framvera/contracts';
import { type AnthropicLike, defaultClient, plainText } from './model.ts';
import type { NegotiationRun } from './types.ts';
import { actorName, fmtMoney, fmtTime, targetKey } from './util.ts';
import { changePhrase } from './voi.ts';

export interface Narration {
  text: string;
  live: boolean;
  model: string;
  facts: string[];
  /** Why model text was discarded in favour of the template. */
  rejected?: string;
}

/** The verified facts of a run, one plain sentence each, citing record ids. */
export function factsOf(run: NegotiationRun, world?: World): string[] {
  const f: string[] = [];
  const phrase = (c: NegotiationRun['accepted'][number]) =>
    world ? changePhrase(c, world) : `${targetKey(c)} from ${String(c.from)} to ${String(c.to)}`;
  if (run.before.plan && (run.before.status === 'optimal' || run.before.status === 'feasible')) {
    f.push(`The published offers already allowed a plan [${run.before.plan.id}].`);
  } else if (run.before.core) {
    f.push(`Before negotiating, no plan was possible: ${run.before.core.summary} [${run.before.core.constraints.map((c) => c.id).join(', ')}]`);
  } else {
    f.push(`Before negotiating, the solver returned ${run.before.status}.`);
  }
  f.push(`${run.queriesUsed} of ${run.queryBudget} supplier questions were used [${run.id}].`);
  for (const c of run.accepted) f.push(`Agreed: ${phrase(c)} [${c.id}].`);
  for (const c of run.rejected) f.push(`Not agreed: ${phrase(c)} [${c.id}].`);
  const plan = run.after?.plan;
  if (plan && run.outcome !== 'already-feasible') {
    const budget = run.intentAfter?.budget;
    f.push(
      `The new plan [${plan.id}] costs ${fmtMoney(plan.total)}${budget ? ` against a budget of ${fmtMoney(budget)}` : ''} and is ready ${fmtTime(plan.readyAt)}.`,
    );
    if (world) {
      const who = [...new Set(plan.allocations.map((a) => actorName(world, a.actor)))];
      f.push(`It uses ${who.join(', ')}.`);
    }
  }
  if (run.verification) {
    const failed = run.verification.checks.filter((c) => !c.ok).map((c) => c.id);
    f.push(
      run.verification.ok
        ? `An independent check of the plan passed all ${run.verification.checks.length} tests.`
        : `The independent check failed [${failed.join(', ')}].`,
    );
  }
  if (run.pendingBuyerQuestions.length) {
    f.push(`Your answer is needed on ${run.pendingBuyerQuestions.length} change${run.pendingBuyerQuestions.length > 1 ? 's' : ''} to the deadline or budget [${run.pendingBuyerQuestions.map((q) => q.concession.id).join(', ')}].`);
  }
  return f;
}

function numberSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[   ]\d{3})*(?:[.,:]\d+)?/g)) out.add(m[0].replace(/[   ]/g, ''));
  return out;
}

/** Rejects model text that cites an id or number absent from the facts. */
export function groundedIn(text: string, facts: string[]): string | undefined {
  const all = facts.join('\n');
  for (const m of text.matchAll(/\[([^\]]+)\]/g)) {
    for (const id of m[1]!.split(/,\s*/)) if (!all.includes(id.trim())) return `unknown id ${id.trim()}`;
  }
  for (const m of text.matchAll(/\b[a-z][\w-]*[-:]?\d[\w:-]*\b/gi)) {
    if (!all.includes(m[0])) return `unknown id ${m[0]}`;
  }
  const allowed = numberSet(all);
  for (const n of numberSet(text)) if (!allowed.has(n)) return `unsupported number ${n}`;
  if (/—/.test(text)) return 'style';
  return undefined;
}

const SYSTEM = [
  'Explain an already verified purchasing result to the buyer in three to five short, plain sentences.',
  'Use only the facts provided. Cite record ids in square brackets exactly as written.',
  'Do not add numbers, names, ids, causes, predictions or advice that are not in the facts. Do not use em dashes.',
].join(' ');

/**
 * Short plain explanation of a finished run. The inexpensive model may rephrase the verified facts;
 * any id or number it introduces that is not in the facts discards its text for the template.
 */
export async function narrate(
  run: NegotiationRun,
  world?: World,
  opts: { client?: AnthropicLike | null } = {},
): Promise<Narration> {
  const facts = factsOf(run, world);
  const template = facts.join(' ');
  const client = opts.client === null ? undefined : (opts.client ?? defaultClient());
  if (!client) return { text: template, live: false, model: 'template', facts };
  const res = await plainText(client, { system: SYSTEM, user: facts.map((x) => `- ${x}`).join('\n') });
  if (!res.ok) return { text: template, live: false, model: 'template', facts, rejected: res.error };
  const problem = groundedIn(res.data, facts);
  if (problem) return { text: template, live: false, model: 'template', facts, rejected: problem };
  return { text: res.data, live: true, model: res.model, facts };
}

const PHRASE_SYSTEM = [
  'Rewrite each numbered negotiation message as one short, polite business sentence.',
  'Keep every name, amount, time and id exactly as written; add nothing. Return the same numbering, one line per message. Do not use em dashes.',
].join(' ');

/**
 * Optional wording pass over a run's message texts. The model only rephrases; the typed messages and the
 * decisions are unchanged, and any line that introduces an id or number not in its template is discarded.
 */
export async function phraseMessages(run: NegotiationRun, opts: { client?: AnthropicLike | null } = {}): Promise<NegotiationRun['texts']> {
  const client = opts.client === null ? undefined : (opts.client ?? defaultClient());
  if (!client || !run.texts.length) return run.texts;
  const res = await plainText(client, {
    system: PHRASE_SYSTEM,
    user: run.texts.map((t, i) => `${i + 1}. ${t.text}`).join('\n'),
    maxTokens: 400 + run.texts.length * 80,
  });
  if (!res.ok) return run.texts;
  const lines = new Map<number, string>();
  for (const line of res.data.split('\n')) {
    const m = /^\s*(\d+)[.)]\s*(.+)$/.exec(line);
    if (m) lines.set(Number(m[1]), m[2]!.trim());
  }
  return run.texts.map((t, i) => {
    const text = lines.get(i + 1);
    return text && !groundedIn(text, [t.text]) ? { message: t.message, text, source: 'model-proposal' as const } : t;
  });
}
