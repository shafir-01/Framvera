import { describe, expect, it, vi } from 'vitest';
import { flagshipWorld, FLAGSHIP_CREATED } from '@framvera/market';
import { compileIntent, parseIntentText } from '../src/intent.ts';
import { groundedIn, narrate, phraseMessages } from '../src/narrate.ts';
import type { AnthropicLike } from '../src/model.ts';
import type { NegotiationRun } from '../src/types.ts';

function fakeClient(reply: { text: string; stop?: string; model?: string }) {
  const message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: reply.model ?? 'claude-sonnet-5-5',
    content: [{ type: 'text', text: reply.text }],
    stop_reason: reply.stop ?? 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const create = vi.fn(async () => message);
  const client = { beta: { messages: { create } }, messages: { create } } as unknown as AnthropicLike;
  return { client, create };
}

describe('compileIntent', () => {
  const { world, intent: flagship } = flagshipWorld();

  it('reads the flagship request deterministically without a model', async () => {
    const r = await compileIntent(flagship.text, world, { now: FLAGSHIP_CREATED, client: null });
    expect(r.live).toBe(false);
    expect(r.model).toBe('deterministic-parser');
    expect(r.intent.quantity).toBe(500);
    expect(r.intent.budget).toEqual({ currency: 'SEK', minor: 5_500_000 });
    expect(r.intent.deadline).toBe(flagship.deadline);
    expect(r.intent.deliverTo).toBe('Stockholm');
    expect(r.questions).toEqual([]);
    expect(r.intent.provenance.source).toBe('buyer');
  });

  it('parses flexibility and asks about what is missing', () => {
    const f = parseIntentText('Need 1,200 tote bags by Thursday 15:00 for 80k kr, can slip a day', world, FLAGSHIP_CREATED);
    expect(f.quantity).toBe(1200);
    expect(f.budgetMinor).toBe(8_000_000);
    expect(f.deadlineFlexHours).toBe(24);
    expect(f.deadline).toBe('2026-11-19T14:00:00.000Z');
  });

  it('returns clarifying questions when the request is incomplete', async () => {
    const r = await compileIntent('We want kits for our launch', world, { now: FLAGSHIP_CREATED, client: null });
    expect(r.questions.join(' ')).toMatch(/How many/);
    expect(r.questions.join(' ')).toMatch(/spend/);
    expect(r.questions.join(' ')).toMatch(/When/);
  });

  it('uses structured model output when available, validated and grounded in the text', async () => {
    const { client, create } = fakeClient({
      text: JSON.stringify({ quantity: 500, budgetMinor: 5_500_000, currency: 'SEK', deadline: flagship.deadline, deliverTo: 'Stockholm', deadlineFlexHours: null, budgetFlexMinor: null, questions: [] }),
    });
    const r = await compileIntent(flagship.text, world, { now: FLAGSHIP_CREATED, client });
    expect(r.live).toBe(true);
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.intent.provenance.source).toBe('model-proposal');
    expect(r.intent.quantity).toBe(500);
    const args = (create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(args.model).toBe('claude-sonnet-5-5');
    expect((args.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    const prompt = JSON.stringify(args);
    for (const a of world.actors) if (a.description) expect(prompt).not.toContain(a.description);
  });

  it('overrides model numbers that do not appear in the request', async () => {
    const { client } = fakeClient({
      text: JSON.stringify({ quantity: 5000, budgetMinor: 9_900_000, currency: 'SEK', deadline: flagship.deadline, deliverTo: 'Stockholm', deadlineFlexHours: null, budgetFlexMinor: null, questions: ['Is this for one site?'] }),
    });
    const r = await compileIntent(flagship.text, world, { now: FLAGSHIP_CREATED, client });
    expect(r.intent.quantity).toBe(500);
    expect(r.intent.budget.minor).toBe(5_500_000);
    expect(r.notes.length).toBe(2);
    expect(r.questions).toContain('Is this for one site?');
  });

  it('falls back on refusal or unreadable output', async () => {
    const { client } = fakeClient({ text: '', stop: 'refusal' });
    const r = await compileIntent(flagship.text, world, { now: FLAGSHIP_CREATED, client });
    expect(r.live).toBe(false);
    expect(r.intent.quantity).toBe(500);
    expect(r.notes[0]).toMatch(/refusal/);
  });
});

function run(): NegotiationRun {
  return {
    id: 'neg-1',
    worldId: 'w',
    worldVersionBefore: 1,
    intent: 'i',
    outcome: 'feasible',
    queryBudget: 6,
    queriesUsed: 2,
    interventions: [],
    outcomeModel: { solves: 3, ms: 10, feasibleSets: 2 },
    questions: [],
    messages: [],
    decisions: [],
    texts: [],
    accepted: [{ id: 'cn-1', target: { kind: 'offer', offer: 'o-kista', field: 'windowEnd' }, from: '2026-11-19T15:00:00.000Z', to: '2026-11-19T17:00:00.000Z', estimate: { currency: 'SEK', minor: 120000 }, rationale: '' }],
    rejected: [],
    coalitions: [],
    pendingBuyerQuestions: [],
    before: { status: 'infeasible', solver: { name: 'highs', version: '1', ms: 1 }, core: { constraints: [{ id: 'deadline', kind: 'deadline', text: '' }], method: 'deletion-filter', minimal: true, proven: true, summary: 'Assembly cannot finish before Friday 12:00.' } },
    after: { status: 'optimal', solver: { name: 'highs', version: '1', ms: 1 }, plan: { id: 'p-9', worldVersion: 2, intent: 'i', allocations: [], total: { currency: 'SEK', minor: 5_210_000 }, readyAt: '2026-11-20T09:00:00.000Z', objective: 'cost' } },
    verification: { ok: true, checks: [{ id: 'budget', ok: true, text: '' }] },
    startedAt: '2026-11-16T07:00:00.000Z',
    finishedAt: '2026-11-16T07:05:00.000Z',
  };
}

describe('narrate', () => {
  it('uses the template without a model and cites ids', async () => {
    const n = await narrate(run(), undefined, { client: null });
    expect(n.live).toBe(false);
    expect(n.text).toMatch(/p-9/);
    expect(n.text).toMatch(/cn-1/);
    expect(n.text).not.toMatch(/—/);
  });

  it('accepts grounded model text and rejects added facts', async () => {
    const facts = (await narrate(run(), undefined, { client: null })).facts;
    const good = fakeClient({ text: 'No plan was possible at first [deadline]. Kista agreed to work later [cn-1]. The new plan [p-9] costs 52 100 kr and passed the independent check.', model: 'claude-haiku-5-5' });
    const ok = await narrate(run(), undefined, { client: good.client });
    expect(ok.live).toBe(true);
    expect(ok.model).toBe('claude-haiku-5-5');
    const args = (good.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(args.model).toBe('claude-haiku-5-5');

    const bad = fakeClient({ text: 'The new plan [p-9] costs 49 000 kr and Söder Print [o-77] is on standby.' });
    const no = await narrate(run(), undefined, { client: bad.client });
    expect(no.live).toBe(false);
    expect(no.rejected).toBeDefined();
    expect(groundedIn('Plan [p-9] costs 52 100 kr.', facts)).toBeUndefined();
    expect(groundedIn('Plan [p-10] costs 52 100 kr.', facts)).toMatch(/p-10/);
  });
});

describe('phraseMessages', () => {
  it('keeps model wording only where it adds no ids or numbers', async () => {
    const r = run();
    r.texts = [
      { message: 'm1', text: 'Proposal to Kista: keep working until Thu 18:00 for 1 200 kr.', source: 'template' },
      { message: 'm2', text: 'Kista accepts (terms abc123def456).', source: 'template' },
    ];
    const { client } = fakeClient({ text: '1. Could Kista keep working until Thu 18:00 for 1 200 kr?\n2. Kista accepts at 900 kr (terms abc123def456).' });
    const out = await phraseMessages(r, { client });
    expect(out[0]).toEqual({ message: 'm1', text: 'Could Kista keep working until Thu 18:00 for 1 200 kr?', source: 'model-proposal' });
    expect(out[1]).toEqual(r.texts[1]);
    expect(await phraseMessages(r, { client: null })).toEqual(r.texts);
  });
});
