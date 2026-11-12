import { beforeAll, describe, expect, it } from 'vitest';
import type { Agreement, Disruption, Intent, World } from '@framvera/contracts';
import { verifyPlan } from '@framvera/solver';
import {
  acceptOptions,
  assessRisk,
  createStandbyDesk,
  decideStandby,
  discoverOptions,
  exerciseOption,
  robustness,
  termsHashOf,
  valueOptions,
  type Discovery,
  type RequestStandby,
  type StandbyOption,
  type StandbyTerms,
  type Valuation,
} from '../src/index.ts';
import { at, committed, intent as mkIntent, truth, world as mkWorld } from './fixtures.ts';

let w: World;
let i: Intent;
let agreement: Agreement;
let disc: Discovery;
let val: Valuation;
let bought: StandbyOption[];

const asmOb = () => agreement.obligations.find((o) => o.offer === 'o-asm')!;
const courierOb = () => agreement.obligations.find((o) => o.offer === 'o-courier')!;
const optFor = (offer: string) => disc.options.find((o) => o.terms.offer === offer)!;

beforeAll(async () => {
  w = mkWorld();
  i = mkIntent();
  agreement = (await committed(w, i)).agreement;
  disc = discoverOptions(w, i, agreement, { truth });
  val = await valueOptions(w, i, agreement, disc.options, { scenarios: 200, seed: 42 });
  bought = acceptOptions(disc.options, val.buy);
});

describe('risk model', () => {
  it('labels estimates and keeps the failure modes consistent', () => {
    const risks = assessRisk(w, agreement);
    expect(risks).toHaveLength(3);
    for (const r of risks) {
      expect(r.label).toBe('planner-estimate');
      expect(r.modes.withdraw + r.modes['capacity-drop'] + r.modes.delay).toBeCloseTo(r.pFail, 12);
      expect(r.pFail).toBeGreaterThan(0);
      expect(r.pFail).toBeLessThan(1);
    }
    const by = new Map(risks.map((r) => [r.offer, r]));
    expect(by.get('o-asm')!.pFail).toBeGreaterThan(by.get('o-courier')!.pFail);
    expect(by.get('o-courier')!.pFail).toBeGreaterThan(by.get('o-print')!.pFail);
    expect(by.get('o-asm')!.reliability).toMatchObject({ declared: 0.8, tier: 'single-claim' });
  });

  it('raises the risk when a capacity claim is contradicted', () => {
    const w2 = structuredClone(w);
    w2.claims.find((c) => c.id === 'cl-cap-o-courier')!.contradictedBy = ['cl-other'];
    const before = assessRisk(w, agreement).find((r) => r.offer === 'o-courier')!;
    const after = assessRisk(w2, agreement).find((r) => r.offer === 'o-courier')!;
    expect(after.modes['capacity-drop']).toBeGreaterThan(before.modes['capacity-drop'] * 5);
  });
});

describe('standby desk', () => {
  const terms = (): StandbyTerms => ({
    option: 'opt-test',
    buyer: 'buyer',
    supplier: 'a-courier2',
    offer: 'o-courier-b',
    stage: 'deliver',
    covers: ['x'],
    qty: 300,
    minExercise: 0,
    fee: { currency: 'SEK', minor: 100000 },
    strikeUnit: { currency: 'SEK', minor: 500 },
    setupFee: { currency: 'SEK', minor: 60000 },
    window: { start: at(2, 0), end: at(3, 12) },
    ratePerHour: 200,
    handoffHours: 2,
    expires: at(2, 0),
  });
  const req = (t = terms()): RequestStandby => ({ type: 'RequestStandby', id: 'r1', from: 'buyer', to: t.supplier, terms: t, termsHash: termsHashOf(t, i.id), expires: at(1, 8), at: at(0, 8) });

  it('accepts terms inside its private limits and signs the exact hash', () => {
    const r = decideStandby(req(), truth.policies['a-courier2']!, w, i.id);
    expect(r.decision).toMatchObject({ accept: true, basis: 'synthetic-policy' });
    expect(r.reply).toMatchObject({ type: 'Accept', termsHash: req().termsHash });
  });

  it('counters below its floors with the closest terms it can commit to', () => {
    const t: StandbyTerms = { ...terms(), fee: { currency: 'SEK', minor: 1 }, strikeUnit: { currency: 'SEK', minor: 300 } };
    const r = decideStandby(req(t), truth.policies['a-courier2']!, w, i.id);
    expect(r.decision.accept).toBe(false);
    expect(r.decision.counter!.strikeUnit.minor).toBe(Math.ceil(400 * 1.05));
    expect(r.decision.counter!.fee.minor).toBe(Math.ceil(0.05 * 420 * 300));
    expect(r.reply.type).toBe('CounterStandby');
    const again = decideStandby(req(r.decision.counter!), truth.policies['a-courier2']!, w, i.id);
    expect(again.decision.accept).toBe(true);
  });

  it('declines when unwilling, on a tampered hash, or for another supplier’s offer', () => {
    expect(decideStandby(req(), { reservation: {}, riskTolerance: 1, standby: { willing: false } }, w, i.id).decision.accept).toBe(false);
    expect(decideStandby({ ...req(), termsHash: 'f'.repeat(64) }, truth.policies['a-courier2']!, w, i.id).decision.reason).toMatch(/hash/);
    expect(decideStandby({ ...req(), to: 'a-asmb' }, truth.policies['a-asmb']!, w, i.id).decision.accept).toBe(false);
  });

  it('records a seller terminal answer with its own basis', () => {
    const desk = createStandbyDesk(truth, w, i.id, () => ({ accept: true, reason: 'Held by hand.' }));
    expect(desk.respond(req()).decision.basis).toBe('seller-terminal');
  });
});

describe('option discovery', () => {
  it('targets the riskiest obligations and explains backups that are too slow', () => {
    expect(disc.targets[0]).toBe(asmOb().id);
    expect(disc.unsuitable).toContainEqual(expect.objectContaining({ obligation: asmOb().id, offer: 'o-asm-c', reason: expect.stringMatching(/after it is needed/) }));
  });

  it('quotes standby terms signed by the supplier, not yet binding on the buyer', () => {
    expect(disc.options.length).toBeGreaterThanOrEqual(3);
    for (const o of disc.options) {
      expect(o.status).toBe('quoted');
      expect(o.termsHash).toBe(termsHashOf(o.terms, i.id));
      expect(o.agreement.state).toBe('PROPOSED');
      expect(o.agreement.acceptances).toEqual([expect.objectContaining({ actor: o.terms.supplier, termsHash: o.termsHash, basis: 'synthetic-policy' })]);
      expect(o.messages.at(-1)).toMatchObject({ type: 'Accept', from: o.terms.supplier, termsHash: o.termsHash });
      expect(o.check.ok).toBe(true);
      expect(Date.parse(o.readyBy)).toBeLessThanOrEqual(Date.parse(o.needBy));
      expect(o.agreement.obligations[0]).toMatchObject({ amount: o.terms.fee, due: o.terms.expires, qty: o.terms.qty });
    }
    const asm = optFor('o-asm-b');
    expect(asm.terms.covers).toEqual([asmOb().id]);
    expect(Date.parse(asm.terms.expires)).toBeGreaterThanOrEqual(Date.parse(asmOb().start));
  });
});

describe('option value', () => {
  it('buys only options whose expected loss avoided beats the fee, within budget', () => {
    expect(val.label).toBe('planner-estimate');
    expect(val.buy).toContain(optFor('o-asm-b').id);
    expect(val.buy).toContain(optFor('o-courier-b').id);
    expect(val.buy).not.toContain(optFor('o-print-2').id);
    for (const v of val.options) {
      if (v.buy) expect(v.marginal!.minor).toBeGreaterThan(v.fee.minor);
      else expect(v.reason.length).toBeGreaterThan(0);
    }
    expect(val.fees.minor).toBeLessThanOrEqual(val.budget.minor);
    expect(val.withOptions.expected.minor).toBeLessThan(val.baseline.expected.minor);
    expect(val.withOptions.cvar90!.minor).toBeLessThan(val.baseline.cvar90!.minor);
    expect(val.withOptions.pMiss).toBeLessThan(val.baseline.pMiss);
  });

  it('is reproducible for a fixed seed', async () => {
    const again = await valueOptions(w, i, agreement, disc.options, { scenarios: 200, seed: 42 });
    expect({ ...again, ms: 0 }).toEqual({ ...val, ms: 0 });
  });

  it('reports CVaR only when the tail holds at least ten scenarios', async () => {
    const small = await valueOptions(w, i, agreement, disc.options, { scenarios: 50, seed: 42 });
    expect(small.baseline.cvar90).toBeNull();
    expect(val.baseline.cvar90).not.toBeNull();
  });

  it('buys nothing over budget or without authority to hold capacity', async () => {
    const tight = await valueOptions(w, i, agreement, disc.options, { scenarios: 100, seed: 42, budget: { currency: 'SEK', minor: 5000 } });
    expect(tight.buy).toEqual([]);
    expect(tight.options.find((o) => o.option === optFor('o-asm-b').id)!.reason).toMatch(/does not fit/);
    const noAuth = await valueOptions(w, { ...i, authority: { ...i.authority, mayReserve: false } }, agreement, disc.options, { scenarios: 100, seed: 42 });
    expect(noAuth.buy).toEqual([]);
  });
});

describe('acceptance', () => {
  it('commits bought options as their own agreements and lets the rest lapse', () => {
    for (const o of bought) {
      if (val.buy.includes(o.id)) {
        expect(o.status).toBe('purchased');
        expect(o.agreement.state).toBe('COMMITTED');
        expect(o.agreement.acceptances.map((a) => a.basis).sort()).toEqual(['buyer', 'synthetic-policy']);
        expect(o.agreement.acceptances.every((a) => a.termsHash === o.termsHash)).toBe(true);
        expect(o.agreement.obligations[0]!.state).toBe('ACTIVE');
      } else {
        expect(o.status).toBe('lapsed');
        expect(o.agreement.state).toBe('CANCELLED');
      }
    }
  });

  it('cannot accept after the supplier’s quote has expired', () => {
    const late = acceptOptions(disc.options, val.buy, { at: at(5, 0) });
    expect(late.every((o) => o.status === 'lapsed')).toBe(true);
  });
});

describe('exercise during recovery', () => {
  const withdraw = (actor: string, when: string): Disruption => ({ id: `d-${actor}`, kind: 'withdraw', actor, detail: 'Supplier withdraws.', at: when });

  it('replaces exactly one obligation and keeps the deadline when the assembler withdraws', () => {
    const ex = exerciseOption(agreement, w, i, withdraw('a-asm', at(1, 7)), bought);
    expect(ex.exercised).toBe(true);
    expect(ex.recovery).toMatchObject({ feasible: true, amended: [asmOb().id], cancelled: [], added: [], slipHours: 0 });
    expect(ex.recovery!.kept.sort()).toEqual(agreement.obligations.filter((o) => o.id !== asmOb().id).map((o) => o.id).sort());
    expect(ex.verification!.ok).toBe(true);
    expect(Date.parse(ex.plan!.readyAt)).toBeLessThanOrEqual(Date.parse(i.deadline));
    const kept = ex.amendment!.obligations.filter((o) => !o.replaces);
    for (const k of kept) expect(k).toEqual(agreement.obligations.find((o) => o.id === k.id));
    const rep = ex.amendment!.obligations.find((o) => o.replaces === asmOb().id)!;
    expect(rep.actor).toBe('a-asmb');
    expect(ex.recovery!.extraCost.minor).toBe(rep.amount.minor - asmOb().amount.minor);
    const asm = ex.options.find((o) => o.terms.offer === 'o-asm-b')!;
    expect(asm.status).toBe('exercised');
    expect(asm.agreement.state).toBe('SETTLED');
    expect(ex.notices[0]).toMatchObject({ type: 'ExerciseStandby', termsHash: asm.termsHash, replaces: asmOb().id });
    const check = verifyPlan(ex.plan!, ex.world, { ...i, provenance: { ...i.provenance, observedAt: at(1, 7) } }, { fixed: kept.map((o) => ({ offer: o.offer, actor: o.actor, stage: o.stage, qty: o.qty, start: o.start, finish: o.due, cost: o.amount })) });
    expect(check.ok).toBe(true);
  });

  it('gives the same answer when handed the world after the disruption', () => {
    const d = withdraw('a-asm', at(1, 7));
    const first = exerciseOption(agreement, w, i, d, bought);
    const again = exerciseOption(agreement, first.world, i, d, bought);
    expect(again.exercised).toBe(true);
    expect(again.recovery!.amended).toEqual(first.recovery!.amended);
    expect(again.replacements).toEqual(first.replacements);
  });

  it('never exercises a quote the buyer did not accept', () => {
    const ex = exerciseOption(agreement, w, i, withdraw('a-asm', at(1, 7)), disc.options);
    expect(ex.exercised).toBe(false);
    expect(ex.reason).toMatch(/No purchased option/);
  });

  it('refuses an expired option and hands over to the full recovery', () => {
    const ex = exerciseOption(agreement, w, i, withdraw('a-asm', at(1, 10)), bought);
    expect(ex.exercised).toBe(false);
    expect(ex.attempts.some((a) => /expired/.test(a.reason))).toBe(true);
  });

  it('leaves a delay the plan can absorb to the due-time amendment', () => {
    const d = { id: 'd-late', kind: 'delay', offer: courierOb().offer, detail: 'Late 6 hours.', at: at(1, 15), params: { delayHours: 6 } } as Disruption;
    const ex = exerciseOption(agreement, w, i, d, bought);
    expect(ex).toMatchObject({ exercised: false, absorbed: true });
  });
});

describe('robust feasibility', () => {
  it('covers every assembly and delivery failure with the bought options and reports the printing gap', async () => {
    const r = await robustness(w, i, agreement, bought);
    expect(r.total).toBe(9);
    expect(r.robustFeasible).toBe(false);
    expect(r.robustWithoutOptions).toBe(false);
    const uncovered = r.disturbances.filter((d) => d.outcome === 'uncovered');
    expect(uncovered.every((d) => d.obligation === agreement.obligations.find((o) => o.offer === 'o-print')!.id)).toBe(true);
    expect(uncovered.every((d) => d.recoverable === true)).toBe(true);
    const none = await robustness(w, i, agreement, [], { recoverable: false });
    expect(none.covered).toBeLessThan(r.covered);
  });

  it('is robust feasible across the whole family when every quote is bought', async () => {
    const all = acceptOptions(disc.options, disc.options.map((o) => o.id));
    const r = await robustness(w, i, agreement, all, { recoverable: false });
    expect(r.robustFeasible).toBe(true);
    expect(r.covered).toBe(r.total);
  });
});
