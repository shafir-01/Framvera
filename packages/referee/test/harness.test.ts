import { afterEach, describe, expect, it } from 'vitest';
import { cells } from '../src/aggregate.ts';
import { DEFAULTS, runBenchmark } from '../src/benchmark.ts';
import { BudgetExhausted, Meter, parseQuestion, setHarnessModel, setHarnessOptions, type ModelClient, type ModelRequest } from '../src/harness/index.ts';
import { fakeDeps, fakeGenerate } from './fakes.ts';

type Call = { name: string; input: Record<string, unknown> };

/** A scripted stand-in for the model: each entry is the tool calls of one turn. */
function scripted(turns: Call[][], seen: ModelRequest[] = []): ModelClient {
  let i = 0;
  return {
    async create(req) {
      seen.push(structuredClone(req));
      const calls = turns[i++] ?? [];
      return {
        id: `m${i}`, type: 'message', role: 'assistant', model: 'scripted', stop_reason: calls.length ? 'tool_use' : 'end_turn',
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: calls.length
          ? calls.map((c, k) => ({ type: 'tool_use', id: `t${i}-${k}`, name: c.name, input: c.input }))
          : [{ type: 'text', text: 'done' }],
      } as never;
    },
  };
}

const run = (family: 'salvageable' | 'impossible' | 'feasible', turns: Call[][], seeds = 1) =>
  runBenchmark(fakeDeps(), { ...DEFAULTS, seeds, families: [family], strategies: ['agent-harness'] }).then((r) => r.records);

afterEach(() => { setHarnessModel(null); setHarnessOptions({}); });

const ask = (offer_id: string, question: string): Call => ({ name: 'ask_supplier', input: { offer_id, question } });
const propose = (offer_id: string, qty: number, start = '2026-01-01T00:00:00.000Z'): Call => ({ name: 'propose_plan', input: { allocations: [{ offer_id, qty, start }] } });
const done = (feasible: boolean, plan_id?: string): Call => ({ name: 'final_answer', input: { feasible, plan_id, summary: 's' } });

describe('question parser', () => {
  const { world } = fakeGenerate(1, 'salvageable');
  const offer = { ...world.offers[0]!, negotiable: ['unitPrice', 'windowEnd', 'capacity', 'minQty', 'setupFee'] as never, setupFee: { currency: 'SEK' as const, minor: 50_000 }, minQty: 100 };
  const p = (q: string) => parseQuestion(offer, q, 'c', 'SEK');

  it('reads a percentage price cut against the first tier', () => {
    const r = p('Could you lower the unit price by 10%?');
    expect(r.ok && r.concession.to).toBe(90);
    expect(r.ok && r.concession.from).toBe(100);
  });
  it('reads a window extension in hours or days', () => {
    const r = p('Can you extend the window end by 12 hours?');
    expect(r.ok && Date.parse(String(r.concession.to)) - Date.parse(offer.window.end)).toBe(12 * 3_600_000);
    const d = p('Please extend the deadline by 2 days');
    expect(d.ok && Date.parse(String(d.concession.to)) - Date.parse(offer.window.end)).toBe(48 * 3_600_000);
  });
  it('reads absolute and waived fees', () => {
    expect(p('Could you waive the setup fee?')).toMatchObject({ ok: true, concession: { to: 0 } });
    expect(p('Reduce the setup fee to 200 kr')).toMatchObject({ ok: true, concession: { to: 20_000 } });
  });
  it('reads capacity and minimum quantity', () => {
    expect(p('Can you raise capacity to 500 units?')).toMatchObject({ ok: true, concession: { to: 500 } });
    expect(p('Could the minimum order be 50% lower?')).toMatchObject({ ok: true, concession: { to: 50 } });
  });
  it('rejects mixed, vague, non-concession and non-negotiable questions', () => {
    expect(p('Lower the price by 10% and extend the deadline by 5 hours').ok).toBe(false);
    expect(p('Can you do better for us?').ok).toBe(false);
    expect(p('Raise the price by 10%').ok).toBe(false);
    expect(parseQuestion({ ...offer, negotiable: [] }, 'Lower the price by 10%', 'c', 'SEK').ok).toBe(false);
  });
});

describe('agent episode', () => {
  it('finds and verifies a plan through a negotiated extension', async () => {
    const seen: ModelRequest[] = [];
    setHarnessModel(scripted([[ask('oa', 'Could you extend the window end by 12 hours?')], [propose('oa', 100)], [done(true, 'plan-1')]], seen));
    const [r] = await run('salvageable', []);
    expect(r?.claimed && r.trulyFeasible && !r.falseClaim).toBe(true);
    expect(r?.questions).toBe(1);
    expect(r?.accepted).toBe(1);
    expect(r?.costMinor).toBe(10_000);
    const last = JSON.stringify(seen.at(-1)?.messages);
    expect(last).toContain('"verified\\":true');
    expect(JSON.stringify(seen[0]?.tools.map((t) => t.name))).not.toMatch(/solve|intervention|voi/i);
  });

  it('records a false claim when the agent asserts feasibility the verifier rejected', async () => {
    setHarnessModel(scripted([[propose('oa', 100)], [done(true, 'plan-1')]]));
    const [r] = await run('salvageable', []);
    expect(r?.claimed).toBe(true);
    expect(r?.falseClaim).toBe(true);
    expect(r?.falseReasons.join()).toContain('verifier');
  });

  it('counts every claimed success in an impossible world as false', async () => {
    setHarnessModel(scripted([[propose('oa', 20)], [done(true, 'plan-1')]]));
    const [r] = await run('impossible', []);
    expect(r?.falseClaim).toBe(true);
    expect(r?.falseReasons.join()).toContain('impossible');
  });

  it('scores an honest "not feasible" as no claim', async () => {
    setHarnessModel(scripted([[done(false)]]));
    const [r] = await run('impossible', []);
    expect(r?.claimed).toBe(false);
    expect(r?.falseClaim).toBe(false);
  });

  it('does not count questions that are not understood or not negotiable', async () => {
    setHarnessModel(scripted([[ask('oa', 'Please be nicer'), ask('oa', 'Lower the price by 10%')], [done(false)]]));
    const [r] = await run('salvageable', []);
    expect(r?.questions).toBe(0);
  });

  it('stops asking at the shared question budget', async () => {
    const q = Array.from({ length: 4 }, (_, i) => ask('oa', `Could you extend the window end by ${i + 1} hours?`));
    setHarnessModel(scripted([q, [done(false)]]));
    const [r] = await runBenchmark(fakeDeps(), { ...DEFAULTS, budget: 2, seeds: 1, families: ['salvageable'], strategies: ['agent-harness'] }).then((x) => x.records);
    expect(r?.questions).toBe(2);
  });

  it('makes no claim when it runs out of turns', async () => {
    setHarnessOptions({ maxTurns: 2 });
    setHarnessModel(scripted([[propose('oa', 100)], [propose('oa', 100)], [done(true)]]));
    const [r] = await run('salvageable', []);
    expect(r?.claimed).toBe(false);
    expect(r?.notes.join()).toContain('no final answer');
  });

  it('is a separate row beside the other strategies', async () => {
    setHarnessModel(scripted([[done(false)]]));
    const { records } = await runBenchmark(fakeDeps(), { ...DEFAULTS, seeds: 2, families: ['salvageable'], strategies: ['agent-harness', 'oracle'] });
    const c = cells(records).find((x) => x.strategy === 'agent-harness')!;
    expect(c.n).toBe(2);
  });
});

describe('spend meter', () => {
  it('stops at the call budget and totals usage', () => {
    const m = new Meter(null, 3);
    for (let i = 0; i < 3; i++) { m.reserve(); m.record({ input_tokens: 1000, output_tokens: 100 }); }
    expect(() => m.reserve()).toThrow(BudgetExhausted);
    expect(m.state.calls).toBe(3);
    expect(m.state.inputTokens).toBe(3000);
    expect(m.state.usdEstimate).toBeCloseTo((3000 * 0.1 + 300 * 0.5) / 1e6, 8);
  });
});
