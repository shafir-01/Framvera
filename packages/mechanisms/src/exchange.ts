import type { Currency, Id, Money, Verification } from '@framvera/contracts';
import { Mip, SOLVER, on, solveMip, type Term } from './mip.ts';
import { Checks, allocate, fnv, m } from './util.ts';

/** A lot a participant is willing to give away: surplus goods or idle capacity. */
export interface SurplusLot {
  id: Id;
  owner: Id;
  good: string;
  qty: number;
  unit: string;
  /** Declared value to the owner of keeping the lot: the least it must get back in value or cash. */
  reserve: Money;
}

/** Something a participant would take, with the most it would give for one lot of it. */
export interface Want {
  id: Id;
  participant: Id;
  good: string;
  /** Smallest lot that is useful. */
  minQty: number;
  /** Declared value of receiving one matching lot. */
  value: Money;
  /** How many lots of this good the participant takes at most. Default 1. */
  count?: number;
}

export interface ExchangeMarket {
  id: Id;
  currency: Currency;
  participants: { id: Id; name: string }[];
  lots: SurplusLot[];
  wants: Want[];
}

export type SplitRule = 'equal' | 'min-cash';

export interface ExchangeOptions {
  /** Longest cycle searched (participants per cycle). Default 4. */
  maxLength?: number;
  /** Candidate lot-and-want options kept per ordered pair of participants. Default 3. */
  perPair?: number;
  /** Cap on enumerated cycles. Default 20000. */
  maxCycles?: number;
  split?: SplitRule;
  timeLimitMs?: number;
}

export interface CycleTransfer {
  lot: Id;
  want: Id;
  from: Id;
  to: Id;
  good: string;
  qty: number;
}

export interface CycleParty {
  participant: Id;
  gives: Id;
  receives: Id;
  /** Declared value of the lot received. */
  valueIn: Money;
  /** Declared reserve of the lot given. */
  valueOut: Money;
  /** Positive: receives cash. Negative: pays cash. */
  cash: Money;
  /** valueIn - valueOut + cash, under declared values. */
  gain: Money;
}

export interface ExchangeCycle {
  id: Id;
  transfers: CycleTransfer[];
  parties: CycleParty[];
  surplus: Money;
  cashMoved: Money;
}

export interface ExchangeResult {
  mechanism: 'circular-exchange';
  market: Id;
  split: SplitRule;
  splitNote: string;
  status: 'cleared' | 'no-cycles' | 'error';
  cycles: ExchangeCycle[];
  totalSurplus: Money;
  /** Declared value of all lots moved. */
  valueMoved: Money;
  /** Sum of cash payments. */
  cashMoved: Money;
  candidates: { cycles: number; truncated: boolean; maxLength: number; perPair: number };
  optimality: string;
  solver: { name: string; version: string; ms: number };
  verification: Verification;
}

export const SPLIT_NOTES: Record<SplitRule, string> = {
  equal: 'Each cycle’s surplus is split equally among its members; cash settles the difference between what each gives and gets.',
  'min-cash': 'Cash covers only what members who give more than they get must receive; members who gain pay it in proportion to their gain. Least cash moved, every member at least breaks even.',
};

interface Arc {
  lot: SurplusLot;
  want: Want;
  gain: number;
}

/**
 * Finds exchange cycles: A's surplus lot goes to B, B's to C, C's back to A. Cycles up to `maxLength`
 * participants are enumerated over the want graph; a set-packing MIP picks cycles with the largest total
 * declared surplus, using each lot once and each want at most its count. Cash per cycle sums to zero and
 * leaves every member individually rational under its declared values.
 */
export async function findExchangeCycles(market: ExchangeMarket, opts: ExchangeOptions = {}): Promise<ExchangeResult> {
  const t0 = performance.now();
  const maxLength = opts.maxLength ?? 4;
  const perPair = opts.perPair ?? 3;
  const maxCycles = opts.maxCycles ?? 20000;
  const split = opts.split ?? 'equal';
  const cur = market.currency;
  const ids = market.participants.map((p) => p.id);
  const index = new Map(ids.map((id, i) => [id, i]));

  const arcs = new Map<string, Arc[]>();
  for (const lot of market.lots) {
    if (!index.has(lot.owner) || lot.reserve.currency !== cur) continue;
    for (const want of market.wants) {
      if (want.participant === lot.owner || !index.has(want.participant) || want.good !== lot.good) continue;
      if (lot.qty < want.minQty || want.value.currency !== cur) continue;
      const key = `${lot.owner}>${want.participant}`;
      arcs.set(key, [...(arcs.get(key) ?? []), { lot, want, gain: want.value.minor - lot.reserve.minor }]);
    }
  }
  for (const [k, list] of arcs) arcs.set(k, list.sort((a, b) => b.gain - a.gain || a.lot.id.localeCompare(b.lot.id)).slice(0, perPair));
  const next = new Map<string, string[]>();
  for (const k of arcs.keys()) {
    const [a, b] = k.split('>') as [string, string];
    next.set(a, [...(next.get(a) ?? []), b]);
  }

  const cycles: Arc[][] = [];
  let truncated = false;
  const expand = (path: string[]) => {
    const choices = path.map((p, i) => arcs.get(`${p}>${path[(i + 1) % path.length]}`)!);
    const pick = (i: number, acc: Arc[]) => {
      if (truncated) return;
      if (i === choices.length) {
        if (acc.reduce((s, a) => s + a.gain, 0) > 0) {
          if (cycles.length >= maxCycles) truncated = true;
          else cycles.push(acc.slice());
        }
        return;
      }
      for (const a of choices[i]!) {
        acc.push(a);
        pick(i + 1, acc);
        acc.pop();
      }
    };
    pick(0, []);
  };
  for (const root of ids) {
    const r = index.get(root)!;
    const dfs = (path: string[]) => {
      if (truncated) return;
      const last = path[path.length - 1]!;
      for (const n of next.get(last) ?? []) {
        if (n === root && path.length >= 2) expand(path);
        else if (index.get(n)! > r && !path.includes(n) && path.length < maxLength) dfs([...path, n]);
      }
    };
    dfs([root]);
  }

  const solver = () => ({ ...SOLVER, ms: Math.round((performance.now() - t0) * 10) / 10 });
  const candidates = { cycles: cycles.length, truncated, maxLength, perPair };
  const empty = (status: 'no-cycles' | 'error', optimality: string): ExchangeResult => {
    const r: ExchangeResult = {
      mechanism: 'circular-exchange', market: market.id, split, splitNote: SPLIT_NOTES[split], status, cycles: [],
      totalSurplus: m(cur, 0), valueMoved: m(cur, 0), cashMoved: m(cur, 0), candidates, optimality, solver: solver(),
      verification: { ok: true, checks: [] },
    };
    r.verification = verifyExchange(r, market);
    return r;
  };
  if (cycles.length === 0) return empty('no-cycles', `No cycle of up to ${maxLength} participants has positive declared surplus.`);

  const model = new Mip();
  model.direction = 'max';
  const y = cycles.map((_, i) => model.bin(`y${i}`));
  model.objective = cycles.map((c, i) => ({ v: y[i]!, c: c.reduce((s, a) => s + a.gain, 0) }));
  const lotUse = new Map<string, Term[]>();
  const wantUse = new Map<string, Term[]>();
  cycles.forEach((c, i) => {
    for (const a of c) {
      lotUse.set(a.lot.id, [...(lotUse.get(a.lot.id) ?? []), { v: y[i]!, c: 1 }]);
      wantUse.set(a.want.id, [...(wantUse.get(a.want.id) ?? []), { v: y[i]!, c: 1 }]);
    }
  });
  for (const terms of lotUse.values()) if (terms.length > 1) model.row(terms, '<=', 1);
  const wantById = new Map(market.wants.map((w) => [w.id, w]));
  for (const [w, terms] of wantUse) {
    const count = wantById.get(w)!.count ?? 1;
    if (terms.length > count) model.row(terms, '<=', count);
  }
  const r = await solveMip(model, opts.timeLimitMs ?? 10_000);
  if (r.status !== 'optimal') return empty('error', `Cycle selection did not finish with a proven answer (${r.status}).`);

  const chosen = cycles.filter((_, i) => on(r.values, y[i]!));
  const out = chosen.map((c) => settle(c, split, cur));
  const total = out.reduce((s, c) => s + c.surplus.minor, 0);
  const result: ExchangeResult = {
    mechanism: 'circular-exchange',
    market: market.id,
    split,
    splitNote: SPLIT_NOTES[split],
    status: 'cleared',
    cycles: out,
    totalSurplus: m(cur, total),
    valueMoved: m(cur, out.reduce((s, c) => s + c.parties.reduce((a, p) => a + p.valueIn.minor, 0), 0)),
    cashMoved: m(cur, out.reduce((s, c) => s + c.cashMoved.minor, 0)),
    candidates,
    optimality: truncated
      ? `Largest declared surplus among the first ${maxCycles} enumerated cycles (enumeration was cut off), proven by HiGHS over that set only.`
      : `Largest total declared surplus over all cycles of up to ${maxLength} participants using the ${perPair} best lots per pair, proven optimal by HiGHS (gap 0).`,
    solver: solver(),
    verification: { ok: true, checks: [] },
  };
  result.verification = verifyExchange(result, market);
  return result;
}

function settle(cycle: Arc[], split: SplitRule, cur: Currency): ExchangeCycle {
  const transfers: CycleTransfer[] = cycle.map((a) => ({ lot: a.lot.id, want: a.want.id, from: a.lot.owner, to: a.want.participant, good: a.lot.good, qty: a.lot.qty }));
  const members = cycle.map((a) => a.lot.owner);
  const inOf = (p: Id) => cycle.find((a) => a.want.participant === p)!;
  const outOf = (p: Id) => cycle.find((a) => a.lot.owner === p)!;
  const u = members.map((p) => inOf(p).want.value.minor - outOf(p).lot.reserve.minor);
  const surplus = u.reduce((a, b) => a + b, 0);
  let cash: number[];
  if (split === 'equal') {
    const shares = allocate(surplus, members.map(() => 1));
    cash = members.map((_, i) => shares[i]! - u[i]!);
  } else {
    const deficit = u.reduce((a, x) => a + Math.max(0, -x), 0);
    const pay = allocate(deficit, u.map((x) => Math.max(0, x)));
    cash = u.map((x, i) => (x < 0 ? -x : -pay[i]!));
  }
  const parties: CycleParty[] = members.map((p, i) => ({
    participant: p,
    gives: outOf(p).lot.id,
    receives: inOf(p).lot.id,
    valueIn: m(cur, inOf(p).want.value.minor),
    valueOut: m(cur, outOf(p).lot.reserve.minor),
    cash: m(cur, cash[i] === 0 ? 0 : cash[i]!),
    gain: m(cur, u[i]! + cash[i]!),
  }));
  const key = transfers.map((x) => `${x.lot}>${x.to}`).join('|');
  return {
    id: `cycle-${fnv(key)}`,
    transfers,
    parties,
    surplus: m(cur, surplus),
    cashMoved: m(cur, cash.reduce((a, x) => a + Math.max(0, x), 0)),
  };
}

/**
 * Independent re-check of an exchange result from the declared market alone: lots move once and only from
 * their owners, receivers want what they get, each cycle is one closed loop, cash sums to zero per cycle,
 * every member's gain is recomputed and non-negative, and the totals add up.
 */
export function verifyExchange(result: ExchangeResult, market: ExchangeMarket): Verification {
  const c = new Checks();
  const cur = market.currency;
  const lotOf = new Map(market.lots.map((l) => [l.id, l]));
  const wantOf = new Map(market.wants.map((w) => [w.id, w]));
  const parts = new Set(market.participants.map((p) => p.id));

  const lotProblems: string[] = [];
  const wantProblems: string[] = [];
  const moved = new Set<string>();
  const wantUsed = new Map<string, number>();
  for (const cy of result.cycles) {
    for (const x of cy.transfers) {
      const lot = lotOf.get(x.lot);
      const want = wantOf.get(x.want);
      if (!lot) lotProblems.push(`Lot ${x.lot} does not exist.`);
      else {
        if (lot.owner !== x.from) lotProblems.push(`Lot ${x.lot} is given by ${x.from}, not its owner.`);
        if (moved.has(x.lot)) lotProblems.push(`Lot ${x.lot} moves twice.`);
        if (lot.good !== x.good || lot.qty !== x.qty) lotProblems.push(`Lot ${x.lot} is described wrongly.`);
      }
      moved.add(x.lot);
      if (!want) wantProblems.push(`Want ${x.want} does not exist.`);
      else {
        if (want.participant !== x.to) wantProblems.push(`Want ${x.want} belongs to ${want.participant}, not ${x.to}.`);
        if (lot && (want.good !== lot.good || lot.qty < want.minQty)) wantProblems.push(`${x.to} does not want lot ${x.lot}.`);
        wantUsed.set(x.want, (wantUsed.get(x.want) ?? 0) + 1);
      }
      if (!parts.has(x.from) || !parts.has(x.to) || x.from === x.to) lotProblems.push(`Transfer of ${x.lot} has invalid parties.`);
    }
  }
  for (const [w, n] of wantUsed) if (n > (wantOf.get(w)?.count ?? 1)) wantProblems.push(`Want ${w} is filled ${n} times.`);
  c.add('lots', lotProblems, 'Every lot moves at most once, from its owner.');
  c.add('wants', wantProblems, 'Every receiver wants what it gets, within its count.');

  const loopProblems: string[] = [];
  const cashProblems: string[] = [];
  const irProblems: string[] = [];
  let total = 0;
  let valueMoved = 0;
  let cashMoved = 0;
  for (const cy of result.cycles) {
    const givers = cy.transfers.map((x) => x.from);
    const takers = cy.transfers.map((x) => x.to);
    if (cy.transfers.length < 2 || new Set(givers).size !== givers.length || new Set(takers).size !== takers.length) {
      loopProblems.push(`Cycle ${cy.id}: each member must give once and receive once.`);
    } else {
      const nextOf = new Map(cy.transfers.map((x) => [x.from, x.to]));
      let p = givers[0]!;
      let steps = 0;
      do {
        p = nextOf.get(p) ?? '';
        steps++;
      } while (p && p !== givers[0] && steps <= givers.length);
      if (p !== givers[0] || steps !== givers.length) loopProblems.push(`Cycle ${cy.id} is not one closed loop.`);
    }
    if (new Set(cy.parties.map((x) => x.participant)).size !== cy.parties.length || cy.parties.length !== cy.transfers.length) loopProblems.push(`Cycle ${cy.id} lists its members wrongly.`);
    let cashSum = 0;
    let surplus = 0;
    for (const p of cy.parties) {
      const inT = cy.transfers.find((x) => x.to === p.participant);
      const outT = cy.transfers.find((x) => x.from === p.participant);
      if (!inT || !outT) {
        loopProblems.push(`${p.participant} does not both give and receive in ${cy.id}.`);
        continue;
      }
      if (p.cash.currency !== cur || !Number.isSafeInteger(p.cash.minor)) cashProblems.push(`${p.participant} has an invalid cash amount.`);
      const vin = wantOf.get(inT.want)?.value.minor ?? NaN;
      const vout = lotOf.get(outT.lot)?.reserve.minor ?? NaN;
      const gain = vin - vout + p.cash.minor;
      if (!(gain >= 0)) irProblems.push(`${p.participant} would lose ${-gain} minor units in ${cy.id}.`);
      if (gain !== p.gain.minor) irProblems.push(`${p.participant} gain is stated as ${p.gain.minor}, recomputed ${gain}.`);
      cashSum += p.cash.minor;
      surplus += vin - vout;
      valueMoved += vin;
      cashMoved += Math.max(0, p.cash.minor);
    }
    if (cashSum !== 0) cashProblems.push(`Cash in ${cy.id} sums to ${cashSum}, not zero.`);
    if (surplus !== cy.surplus.minor) cashProblems.push(`Cycle ${cy.id} surplus is stated as ${cy.surplus.minor}, recomputed ${surplus}.`);
    total += surplus;
  }
  c.add('loops', loopProblems, 'Every cycle is one closed loop where each member gives once and receives once.');
  c.add('cash', cashProblems, 'Cash in every cycle sums to exactly zero.');
  c.add('rational', irProblems, 'Every member gains or breaks even under its declared values.');
  const totals: string[] = [];
  if (total !== result.totalSurplus.minor) totals.push(`Total surplus ${result.totalSurplus.minor}, recomputed ${total}.`);
  if (valueMoved !== result.valueMoved.minor) totals.push(`Value moved ${result.valueMoved.minor}, recomputed ${valueMoved}.`);
  if (cashMoved !== result.cashMoved.minor) totals.push(`Cash moved ${result.cashMoved.minor}, recomputed ${cashMoved}.`);
  c.add('totals', totals, 'Totals add up exactly.');
  return c.result();
}
