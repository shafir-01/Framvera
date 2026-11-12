import type { Allocation, Id, Intent, Money, Plan, Provenance, Verification, World } from '@framvera/contracts';
import { effectiveCapacity, isUsable } from '@framvera/contracts';
import { Mip, SOLVER, on, solveMip, type Term } from './mip.ts';
import {
  Checks,
  HOUR,
  TIME_TOLERANCE_MS,
  allocate,
  earliestSchedule,
  fnv,
  iso,
  m,
  publishedPrice,
  scheduleProblems,
  stageDemand,
  t,
} from './util.ts';

/** Units drawn from one of the bidder's own published offers. */
export interface BidItem {
  offer: Id;
  qty: number;
}

/** An all-or-nothing package: the bidder delivers every item for one total price. */
export interface PackageBid {
  id: Id;
  bidder: Id;
  items: BidItem[];
  price: Money;
  /** Bids sharing a group are alternatives from one menu: at most one of them wins. */
  exclusiveGroup?: Id;
  provenance: Provenance;
}

export interface AuctionOptions {
  timeLimitMs?: number;
  /** Rounds of winner determination and schedule check before giving up. */
  maxRounds?: number;
}

export interface AuctionWinner {
  bid: Id;
  bidder: Id;
  items: BidItem[];
  price: Money;
  /** What the same units cost at the bidder's published prices. */
  published: Money;
}

export interface AuctionResult {
  mechanism: 'combinatorial-reverse-auction';
  paymentRule: 'pay-as-bid';
  paymentRuleNote: string;
  status: 'awarded' | 'no-award' | 'error';
  winners: AuctionWinner[];
  plan?: Plan;
  total?: Money;
  /** Cost of the awarded units at published prices, for comparison with the bids. */
  publishedTotal?: Money;
  /** Units bought above each stage's demand because packages are indivisible. */
  extraUnits: Record<string, number>;
  rejected: { bid: Id; reason: string }[];
  losing: Id[];
  rounds: number;
  /** Winner sets the schedule check refused, each excluded by a cut before re-solving. */
  scheduleCuts: { bids: Id[]; reason: string }[];
  optimality: string;
  diagnosis: string[];
  solver: { name: string; version: string; ms: number };
  verification: Verification;
}

export const PAYMENT_RULE_NOTE =
  'Each winner is paid exactly its own bid. Under this rule a bidder can gain by asking above its cost, so the prices reflect bids, not costs.';

const OBJECTIVE = 'Lowest total payment over the valid package bids (pay-as-bid), each stage covered, no offer over capacity, within budget.';

/** Checks one bid against the world and request; returns the reason it is invalid, or null. */
export function bidProblem(bid: PackageBid, world: World, intent: Intent): string | null {
  const actor = world.actors.find((a) => a.id === bid.bidder);
  if (!actor) return 'Unknown bidder.';
  if (!actor.active) return 'Bidder is not active.';
  if (actor.kind !== 'supplier' && actor.kind !== 'logistics') return 'Only suppliers can bid.';
  if (bid.price.currency !== intent.budget.currency) return `Bid is in ${bid.price.currency}, the request is in ${intent.budget.currency}.`;
  if (!Number.isSafeInteger(bid.price.minor) || bid.price.minor <= 0) return 'Bid price must be a positive whole amount.';
  if (bid.items.length === 0) return 'Bid has no items.';
  const now = t(intent.provenance.observedAt);
  const seen = new Set<string>();
  for (const it of bid.items) {
    const o = world.offers.find((x) => x.id === it.offer);
    if (!o) return `Offer ${it.offer} does not exist.`;
    if (o.actor !== bid.bidder) return `Offer ${it.offer} belongs to another supplier.`;
    if (seen.has(o.id)) return `Offer ${it.offer} appears twice in one bid.`;
    seen.add(o.id);
    if (!world.stages.some((s) => s.id === o.stage)) return `Offer ${it.offer} names an unknown stage.`;
    if (!Number.isInteger(it.qty) || it.qty < 1) return `Quantity ${it.qty} is not a positive whole number.`;
    if (it.qty < o.minQty) return `${it.qty} is below the offer minimum of ${o.minQty}.`;
    const cap = effectiveCapacity(world, o);
    if (it.qty > cap) return cap < o.capacity ? `${it.qty} is above the ${cap} units left after recorded bookings.` : `${it.qty} is above the offer capacity of ${cap}.`;
    if (!isUsable(world, o) || t(o.validUntil) < now) return `Offer ${it.offer} expired before the request.`;
    if (!(o.ratePerHour > 0)) return `Offer ${it.offer} has no production rate.`;
    const start = Math.max(t(o.window.start), now);
    if (start + (it.qty / o.ratePerHour) * HOUR > t(o.window.end) + TIME_TOLERANCE_MS) return `${it.qty} units do not fit inside the offer window.`;
  }
  return null;
}

/**
 * Winner determination for package bids. A MIP picks bids so every stage is covered, no published offer
 * is drawn beyond its capacity, at most one bid per exclusive group wins and the total stays in budget,
 * at the lowest total payment. The winning set is then scheduled; a set that cannot meet the windows or
 * deadline is cut off and the MIP re-solved, so the award is the cheapest set that also schedules.
 */
export async function runReverseAuction(
  world: World,
  intent: Intent,
  bids: PackageBid[],
  opts: AuctionOptions = {},
): Promise<AuctionResult> {
  const t0 = performance.now();
  const currency = intent.budget.currency;
  const maxRounds = opts.maxRounds ?? 30;
  const rejected: AuctionResult['rejected'] = [];
  const valid: PackageBid[] = [];
  const ids = new Set<string>();
  for (const b of bids) {
    const problem = ids.has(b.id) ? 'Duplicate bid id.' : bidProblem(b, world, intent);
    ids.add(b.id);
    if (problem) rejected.push({ bid: b.id, reason: problem });
    else valid.push(b);
  }

  const demand = new Map(world.stages.map((s) => [s.id, stageDemand(s, intent)]));
  const offerOf = new Map(world.offers.map((o) => [o.id, o]));
  const base = {
    mechanism: 'combinatorial-reverse-auction' as const,
    paymentRule: 'pay-as-bid' as const,
    paymentRuleNote: PAYMENT_RULE_NOTE,
    rejected,
    extraUnits: {},
  };

  const build = (withBudget: boolean) => {
    const model = new Mip();
    const x = valid.map((_, i) => model.bin(`x${i}`));
    model.objective = valid.map((b, i) => ({ v: x[i]!, c: b.price.minor }));
    for (const [stage, need] of demand) {
      if (need <= 0) continue;
      const terms: Term[] = [];
      valid.forEach((b, i) => {
        const q = b.items.filter((it) => offerOf.get(it.offer)!.stage === stage).reduce((a, it) => a + it.qty, 0);
        if (q > 0) terms.push({ v: x[i]!, c: q });
      });
      model.row(terms, '>=', need);
    }
    const byOffer = new Map<string, Term[]>();
    valid.forEach((b, i) => b.items.forEach((it) => byOffer.set(it.offer, [...(byOffer.get(it.offer) ?? []), { v: x[i]!, c: it.qty }])));
    for (const [offer, terms] of byOffer) if (terms.length > 1) model.row(terms, '<=', effectiveCapacity(world, offerOf.get(offer)!));
    const groups = new Map<string, string[]>();
    valid.forEach((b, i) => b.exclusiveGroup && groups.set(b.exclusiveGroup, [...(groups.get(b.exclusiveGroup) ?? []), x[i]!]));
    for (const vs of groups.values()) if (vs.length > 1) model.row(vs.map((v) => ({ v, c: 1 })), '<=', 1);
    if (withBudget) model.row(model.objective, '<=', intent.budget.minor);
    return { model, x };
  };

  const solverInfo = () => ({ ...SOLVER, ms: Math.round((performance.now() - t0) * 10) / 10 });
  const fail = (status: 'no-award' | 'error', rounds: number, cuts: AuctionResult['scheduleCuts'], diagnosis: string[], optimality: string): AuctionResult => {
    const r: AuctionResult = { ...base, status, winners: [], losing: valid.map((b) => b.id), rounds, scheduleCuts: cuts, optimality, diagnosis, solver: solverInfo(), verification: { ok: true, checks: [] } };
    r.verification = verifyAuction(r, world, intent, bids);
    return r;
  };

  if (valid.length === 0) return fail('no-award', 0, [], ['No valid bids.'], 'No award: there were no valid bids.');

  const { model, x } = build(true);
  const cuts: AuctionResult['scheduleCuts'] = [];
  for (let round = 1; round <= maxRounds; round++) {
    const left = Math.max(200, (opts.timeLimitMs ?? 10_000) - (performance.now() - t0));
    const r = await solveMip(model, left);
    if (r.status === 'infeasible') {
      const diagnosis = await diagnose(world, intent, valid, demand, build, round > 1);
      const proof = round === 1
        ? 'No award: HiGHS proved that no combination of valid bids covers every stage within capacity and budget.'
        : `No award: after ${cuts.length} winner sets failed the schedule check, HiGHS proved no other combination covers every stage within capacity and budget.`;
      return fail('no-award', round, cuts, diagnosis, proof);
    }
    if (r.status !== 'optimal') {
      return fail('error', round, cuts, [`Winner determination stopped without a proven answer (${r.status}).`], 'No award: the solver did not finish.');
    }
    const chosen = valid.filter((_, i) => on(r.values, x[i]!));
    const qty = new Map<string, number>();
    for (const b of chosen) for (const it of b.items) qty.set(it.offer, (qty.get(it.offer) ?? 0) + it.qty);
    const sched = earliestSchedule(world, intent, qty);
    if (!sched.ok) {
      const chosenIdx = new Set(chosen.map((b) => valid.indexOf(b)));
      model.row(x.map((v, i) => ({ v, c: chosenIdx.has(i) ? -1 : 1 })), '>=', 1 - chosenIdx.size);
      cuts.push({ bids: chosen.map((b) => b.id), reason: sched.problems.includes('deadline') ? 'Cannot finish by the deadline.' : 'Work does not fit inside an offer window.' });
      continue;
    }

    const allocations = toAllocations(world, chosen, qty, sched.times, currency);
    const total = chosen.reduce((a, b) => a + b.price.minor, 0);
    const body = allocations.map((a) => `${a.offer}:${a.qty}:${a.start}:${a.cost.minor}`).join('|');
    const plan: Plan = {
      id: `plan-auction-${fnv(`${world.id}:${world.version}:${intent.id}:${body}`)}`,
      worldVersion: world.version,
      intent: intent.id,
      allocations,
      total: m(currency, total),
      readyAt: iso(sched.readyAt),
      objective: OBJECTIVE,
    };
    const extraUnits: Record<string, number> = {};
    for (const [stage, need] of demand) {
      const got = allocations.filter((a) => a.stage === stage).reduce((acc, a) => acc + a.qty, 0);
      if (got > need) extraUnits[stage] = got - need;
    }
    const winners: AuctionWinner[] = chosen.map((b) => ({
      bid: b.id,
      bidder: b.bidder,
      items: b.items.map((it) => ({ ...it })),
      price: { ...b.price },
      published: m(currency, b.items.reduce((acc, it) => acc + publishedPrice(offerOf.get(it.offer)!, it.qty), 0)),
    }));
    const result: AuctionResult = {
      ...base,
      extraUnits,
      status: 'awarded',
      winners,
      plan,
      total: m(currency, total),
      publishedTotal: m(currency, [...qty].reduce((acc, [o, q]) => acc + publishedPrice(offerOf.get(o)!, q), 0)),
      losing: valid.filter((b) => !chosen.includes(b)).map((b) => b.id),
      rounds: round,
      scheduleCuts: cuts,
      optimality: `Lowest total payment among valid bids whose award can be scheduled, proven optimal by HiGHS (gap 0)${cuts.length ? ` after ${cuts.length} schedule cut${cuts.length === 1 ? '' : 's'}` : ''}.`,
      diagnosis: [],
      solver: solverInfo(),
      verification: { ok: true, checks: [] },
    };
    result.verification = verifyAuction(result, world, intent, bids);
    return result;
  }
  return fail('no-award', maxRounds, cuts, [`Stopped after ${maxRounds} rounds; every cheaper winner set failed the schedule check.`], 'No award within the round limit. This is not a proof that no schedulable award exists.');
}

function toAllocations(
  world: World,
  chosen: PackageBid[],
  qty: Map<string, number>,
  times: Map<string, { start: number; finish: number }>,
  currency: Money['currency'],
): Allocation[] {
  const offerOf = new Map(world.offers.map((o) => [o.id, o]));
  const cost = new Map<string, number>();
  for (const b of chosen) {
    const parts = allocate(b.price.minor, b.items.map((it) => publishedPrice(offerOf.get(it.offer)!, it.qty)));
    b.items.forEach((it, k) => cost.set(it.offer, (cost.get(it.offer) ?? 0) + parts[k]!));
  }
  return world.offers
    .filter((o) => qty.has(o.id))
    .map((o) => ({
      offer: o.id,
      actor: o.actor,
      stage: o.stage,
      qty: qty.get(o.id)!,
      start: iso(times.get(o.id)!.start),
      finish: iso(times.get(o.id)!.finish),
      cost: m(currency, cost.get(o.id)!),
    }));
}

async function diagnose(
  world: World,
  intent: Intent,
  valid: PackageBid[],
  demand: Map<string, number>,
  build: (withBudget: boolean) => { model: Mip },
  hadCuts: boolean,
): Promise<string[]> {
  const out: string[] = [];
  const offerOf = new Map(world.offers.map((o) => [o.id, o]));
  for (const s of world.stages) {
    const need = demand.get(s.id) ?? 0;
    if (need <= 0) continue;
    const cap = new Map<string, number>();
    for (const b of valid) for (const it of b.items) if (offerOf.get(it.offer)!.stage === s.id) cap.set(it.offer, Math.max(cap.get(it.offer) ?? 0, it.qty));
    const reach = [...cap.entries()].reduce((a, [o, q]) => a + Math.min(effectiveCapacity(world, offerOf.get(o)!), q), 0);
    if (reach < need) out.push(`${s.name}: bids reach at most ${reach} of ${need} ${s.unit}.`);
  }
  if (out.length === 0 && !hadCuts) {
    const r = await solveMip(build(false).model, 5000);
    if (r.status === 'optimal') out.push(`The cheapest covering award costs ${Math.round(r.objective)} minor units, above the budget of ${intent.budget.minor}.`);
  }
  if (hadCuts) out.push('Some cheaper winner sets could not meet the windows or deadline.');
  return out;
}

/**
 * Independent re-check of an auction result from the bids, the world and the request, without the solver:
 * bid validity, coverage, capacity, exclusive groups, budget, pay-as-bid payments that add up exactly, and
 * the schedule against published windows, rates, precedence and the deadline.
 */
export function verifyAuction(result: AuctionResult, world: World, intent: Intent, bids: PackageBid[]): Verification {
  const c = new Checks();
  const byId = new Map(bids.map((b) => [b.id, b]));
  const offerOf = new Map(world.offers.map((o) => [o.id, o]));
  const currency = intent.budget.currency;

  c.add('rule', result.paymentRule === 'pay-as-bid' ? [] : [`Unknown payment rule ${String(result.paymentRule)}.`], 'Payment rule is pay-as-bid, stated with its limits.');
  if (result.status !== 'awarded') {
    c.add('no-award', result.winners.length || result.plan ? ['A result without an award lists winners or a plan.'] : [], 'No award, no payments.');
    return c.result();
  }

  const bidProblems: string[] = [];
  const seen = new Set<string>();
  for (const w of result.winners) {
    const b = byId.get(w.bid);
    if (!b) bidProblems.push(`Winning bid ${w.bid} was never submitted.`);
    else {
      const p = bidProblem(b, world, intent);
      if (p) bidProblems.push(`Winning bid ${w.bid} is invalid: ${p}`);
      if (b.bidder !== w.bidder) bidProblems.push(`Winning bid ${w.bid} names the wrong bidder.`);
      if (JSON.stringify(b.items) !== JSON.stringify(w.items)) bidProblems.push(`Winning bid ${w.bid} items differ from the submitted bid.`);
    }
    if (seen.has(w.bid)) bidProblems.push(`Bid ${w.bid} wins twice.`);
    seen.add(w.bid);
  }
  c.add('bids', bidProblems, 'Every winning bid was submitted, is valid and wins once.');
  if (bidProblems.length) return c.result();
  const winning = result.winners.map((w) => byId.get(w.bid)!);

  const groupProblems: string[] = [];
  const groups = new Map<string, number>();
  for (const b of winning) if (b.exclusiveGroup) groups.set(b.exclusiveGroup, (groups.get(b.exclusiveGroup) ?? 0) + 1);
  for (const [g, n] of groups) if (n > 1) groupProblems.push(`${n} bids win from exclusive group ${g}.`);
  c.add('exclusive', groupProblems, 'At most one bid wins from each exclusive menu.');

  const qty = new Map<string, number>();
  for (const b of winning) for (const it of b.items) qty.set(it.offer, (qty.get(it.offer) ?? 0) + it.qty);
  const capProblems = [...qty].filter(([o, q]) => q > effectiveCapacity(world, offerOf.get(o)!)).map(([o, q]) => `Offer ${o} is drawn for ${q}, above its capacity of ${effectiveCapacity(world, offerOf.get(o)!)}.`);
  c.add('capacity', capProblems, 'No published offer is drawn beyond its capacity.');

  const coverProblems: string[] = [];
  for (const s of world.stages) {
    const need = stageDemand(s, intent);
    const got = [...qty].filter(([o]) => offerOf.get(o)!.stage === s.id).reduce((a, [, q]) => a + q, 0);
    if (got < need) coverProblems.push(`${s.name} gets ${got} of ${need} ${s.unit}.`);
  }
  c.add('coverage', coverProblems, 'Every stage is covered.');

  const payProblems: string[] = [];
  let total = 0;
  for (const w of result.winners) {
    const b = byId.get(w.bid)!;
    if (w.price.minor !== b.price.minor || w.price.currency !== b.price.currency) payProblems.push(`Bid ${w.bid} is paid ${w.price.minor}, not its bid of ${b.price.minor}.`);
    total += b.price.minor;
  }
  if (!result.total || result.total.minor !== total || result.total.currency !== currency) payProblems.push(`Total ${result.total?.minor} does not equal the sum of winning bids ${total}.`);
  c.add('payments', payProblems, 'Each winner is paid exactly its bid and the total adds up.');
  c.add('budget', total > intent.budget.minor ? [`Total ${total} exceeds the budget of ${intent.budget.minor}.`] : [], 'Total payment is within budget.');

  const plan = result.plan;
  const planProblems: string[] = [];
  if (!plan) planProblems.push('Awarded result has no plan.');
  else {
    if (plan.worldVersion !== world.version || plan.intent !== intent.id) planProblems.push('Plan does not match this world version and request.');
    const offersSeen = new Set<string>();
    let sum = 0;
    for (const a of plan.allocations) {
      const o = offerOf.get(a.offer);
      if (!o || o.actor !== a.actor || o.stage !== a.stage) planProblems.push(`Allocation on ${a.offer} names the wrong offer, supplier or stage.`);
      if (offersSeen.has(a.offer)) planProblems.push(`Offer ${a.offer} is allocated twice.`);
      offersSeen.add(a.offer);
      if (a.qty !== qty.get(a.offer)) planProblems.push(`Allocation on ${a.offer} has ${a.qty} units, the winning bids promise ${qty.get(a.offer) ?? 0}.`);
      if (!Number.isSafeInteger(a.cost.minor) || a.cost.currency !== currency) planProblems.push(`Allocation on ${a.offer} has an invalid amount.`);
      sum += a.cost.minor;
    }
    for (const o of qty.keys()) if (!offersSeen.has(o)) planProblems.push(`Offer ${o} won but has no allocation.`);
    if (sum !== total || plan.total.minor !== total) planProblems.push(`Plan amounts sum to ${sum}, payments to ${total}.`);
  }
  c.add('plan', planProblems, 'The plan carries exactly the winning units and payments.');
  if (plan && planProblems.length === 0) c.add('schedule', scheduleProblems(world, intent, plan.allocations, plan.readyAt), 'The schedule meets every window, rate, precedence and the deadline.');
  return c.result();
}

/**
 * Single-offer bids at published prices: one menu per offer with the quantities a buyer would need.
 * Useful as the posted-price reference inside the same auction.
 */
export function publishedBids(world: World, intent: Intent, levels = [0.25, 0.5, 0.75, 1]): PackageBid[] {
  const out: PackageBid[] = [];
  const now = intent.provenance.observedAt;
  for (const s of world.stages) {
    const need = stageDemand(s, intent);
    if (need <= 0) continue;
    for (const o of world.offers.filter((x) => x.stage === s.id && isUsable(world, x))) {
      for (const q of quantityLevels(need, o.minQty, effectiveCapacity(world, o), levels)) {
        out.push({
          id: `pub:${o.id}:${q}`,
          bidder: o.actor,
          items: [{ offer: o.id, qty: q }],
          price: m(intent.budget.currency, publishedPrice(o, q)),
          exclusiveGroup: `pub:${o.id}`,
          provenance: { source: 'synthetic-market', observedAt: now, ref: o.id },
        });
      }
    }
  }
  return out;
}

/** Distinct whole quantities at given shares of the need, clamped to [minQty, capacity], plus the full need or capacity. */
export function quantityLevels(need: number, minQty: number, capacity: number, levels: readonly number[]): number[] {
  const out = new Set<number>();
  for (const l of [...levels, 1]) {
    const q = Math.min(capacity, Math.ceil(need * l));
    if (q >= Math.max(1, minQty)) out.add(q);
  }
  const full = Math.min(capacity, need);
  if (full >= Math.max(1, minQty)) out.add(full);
  return [...out].sort((a, b) => a - b);
}
