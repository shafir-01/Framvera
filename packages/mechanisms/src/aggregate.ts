import type { Id, Intent, Money, Plan, SolveReport, Verification, World } from '@framvera/contracts';
import { solve, verifyPlan } from '@framvera/solver';
import { Mip, SOLVER, on, solveMip } from './mip.ts';
import { Checks, allocate, m, t, tierUnit } from './util.ts';

export interface BuyerOrder {
  buyer: Id;
  intent: Intent;
  /** Explicit permission to combine this order with other buyers' orders. */
  consent: { pool: boolean };
}

export interface AggregateOptions {
  /** Largest number of buyers in one pool. Default 4. */
  maxPoolSize?: number;
  /** Cap on candidate pools solved. Default 60. */
  maxCandidates?: number;
  timeLimitMs?: number;
}

export interface TierCrossing {
  offer: Id;
  actor: Id;
  pooledQty: number;
  pooledUnit: Money;
  /** Unit price the largest single member order from this offer would pay alone. */
  aloneUnit: Money;
}

export interface PoolMember {
  buyer: Id;
  intent: Id;
  quantity: number;
  budget: Money;
  /** Cost of the cheapest plan this buyer could buy alone, when one exists. */
  alone: Money | null;
  /** Basis for the split: the alone cost, or the budget when no alone plan exists. */
  reference: Money;
  share: Money;
  saving: Money;
}

export interface PoolStability {
  /** Proper subgroups of two or more members whose own pooled plan was solved. */
  checked: number;
  /** Proper subgroups not solved (candidate cap). */
  unchecked: number;
  /** Subgroups that could buy for less on their own than they pay inside this pool. */
  blocking: { members: Id[]; cost: Money; payNow: Money }[];
  /** true: no subgroup and no single member does better alone. false: a blocking subgroup exists. null: not fully checked. */
  stable: boolean | null;
  text: string;
}

export interface Pool {
  id: Id;
  members: PoolMember[];
  intent: Intent;
  plan: Plan;
  total: Money;
  saving: Money;
  tiersCrossed: TierCrossing[];
  setupFeesShared: number;
  stability: PoolStability;
}

export interface AggregationResult {
  mechanism: 'demand-aggregation';
  rule: string;
  status: 'pooled' | 'no-pool' | 'error';
  pools: Pool[];
  alone: { buyer: Id; intent: Id; plan: Plan | null; status: SolveReport['status'] }[];
  refused: { buyer: Id; reason: string }[];
  totalSaving: Money;
  candidates: { solved: number; truncated: boolean; maxPoolSize: number };
  optimality: string;
  solver: { name: string; version: string; ms: number };
  verification: Verification;
}

export const POOL_RULE =
  'Pooled buyers share one plan that meets the earliest member deadline. Each pays the pooled cost in proportion to its reference: what it would pay alone, or its budget when it cannot buy alone. Nobody pays more than its reference or its budget.';

const norm = (s: string) => s.trim().toLowerCase();

/** The combined request for a pool: summed quantity, earliest deadline, latest request time. */
export function poolIntent(members: { order: BuyerOrder; reference: number }[]): Intent {
  const first = members[0]!.order.intent;
  const deadline = members.map((x) => x.order.intent.deadline).sort((a, b) => t(a) - t(b))[0]!;
  const observedAt = members.map((x) => x.order.intent.provenance.observedAt).sort((a, b) => t(b) - t(a))[0]!;
  const cur = first.budget.currency;
  const cap = members.reduce((a, x) => a + x.reference, 0);
  return {
    id: `pool:${members.map((x) => x.order.intent.id).join('+')}`,
    text: `Pooled order for ${members.length} buyers`,
    quantity: members.reduce((a, x) => a + x.order.intent.quantity, 0),
    budget: m(cur, cap),
    deadline,
    deliverTo: first.deliverTo,
    negotiable: {},
    authority: { mayNegotiate: false, mayReserve: false, mayPreparePayments: false, maxSpend: m(cur, cap) },
    provenance: { source: 'buyer', observedAt, ref: members.map((x) => x.order.buyer).join(',') },
  };
}

function subsets<T>(xs: T[], min: number, max: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (acc.length >= min) out.push(acc.slice());
    if (acc.length === max) return;
    for (let i = start; i < xs.length; i++) {
      acc.push(xs[i]!);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}

/**
 * Pools compatible orders from consenting buyers so the combined quantity crosses price tiers and shares
 * setup fees. Each buyer's alone plan and every candidate pool's plan come from the shared solver and are
 * re-verified; a MIP then picks disjoint pools with the largest total saving. Buyers without consent are
 * never pooled.
 */
export async function aggregateDemand(world: World, orders: BuyerOrder[], opts: AggregateOptions = {}): Promise<AggregationResult> {
  const t0 = performance.now();
  const maxPoolSize = opts.maxPoolSize ?? 4;
  const maxCandidates = opts.maxCandidates ?? 60;
  const timeLimitMs = opts.timeLimitMs ?? 5000;
  const cur = world.currency;
  const refused: AggregationResult['refused'] = [];
  const seenBuyers = new Set<string>();
  const usable: BuyerOrder[] = [];
  for (const o of orders) {
    if (seenBuyers.has(o.buyer)) refused.push({ buyer: o.buyer, reason: 'More than one order from this buyer; only the first is considered.' });
    else if (o.intent.budget.currency !== cur) refused.push({ buyer: o.buyer, reason: `Order is in ${o.intent.budget.currency}, the market trades in ${cur}.` });
    else usable.push(o);
    seenBuyers.add(o.buyer);
  }
  for (const o of usable) if (!o.consent.pool) refused.push({ buyer: o.buyer, reason: 'Buyer has not agreed to pooling; the order is handled alone.' });

  const alone: AggregationResult['alone'] = [];
  const aloneCost = new Map<string, number | null>();
  const alonePlans = new Map<string, Plan>();
  for (const o of usable) {
    const r = await solve(world, o.intent, { timeLimitMs, explain: false });
    const ok = r.plan && verifyPlan(r.plan, world, o.intent).ok ? r.plan : null;
    alone.push({ buyer: o.buyer, intent: o.intent.id, plan: ok, status: r.status });
    aloneCost.set(o.buyer, ok ? ok.total.minor : null);
    if (ok) alonePlans.set(o.buyer, ok);
  }
  const reference = (o: BuyerOrder) => aloneCost.get(o.buyer) ?? Math.min(o.intent.budget.minor, o.intent.authority.maxSpend.minor);

  const consenting = usable.filter((o) => o.consent.pool);
  const groups = new Map<string, BuyerOrder[]>();
  for (const o of consenting) groups.set(norm(o.intent.deliverTo), [...(groups.get(norm(o.intent.deliverTo)) ?? []), o]);
  let all = [...groups.values()].flatMap((g) => subsets(g, 2, maxPoolSize));
  all.sort((a, b) => a.length - b.length);
  const truncated = all.length > maxCandidates;
  all = all.slice(0, maxCandidates);

  const candidates: Pool[] = [];
  const costOf = new Map<string, number | null>();
  for (const set of all) {
    const members = set.map((order) => ({ order, reference: reference(order) }));
    const intent = poolIntent(members);
    const r = await solve(world, intent, { timeLimitMs, explain: false });
    const plan = r.plan && verifyPlan(r.plan, world, intent).ok ? r.plan : null;
    costOf.set(groupKey(set.map((o) => o.buyer)), plan ? plan.total.minor : null);
    if (!plan) continue;
    const refSum = members.reduce((a, x) => a + x.reference, 0);
    if (plan.total.minor >= refSum) continue;
    candidates.push(buildPool(world, members, intent, plan, alonePlans, aloneCost));
  }
  for (const p of candidates) p.stability = stability(p, costOf, cur);

  const solver = () => ({ ...SOLVER, ms: Math.round((performance.now() - t0) * 10) / 10 });
  const finish = (pools: Pool[], status: AggregationResult['status'], optimality: string): AggregationResult => {
    const res: AggregationResult = {
      mechanism: 'demand-aggregation',
      rule: POOL_RULE,
      status,
      pools,
      alone: alone.filter((a) => !pools.some((p) => p.members.some((x) => x.buyer === a.buyer))),
      refused,
      totalSaving: m(cur, pools.reduce((a, p) => a + p.saving.minor, 0)),
      candidates: { solved: all.length, truncated, maxPoolSize },
      optimality,
      solver: solver(),
      verification: { ok: true, checks: [] },
    };
    res.verification = verifyAggregation(res, world, orders);
    return res;
  };
  if (candidates.length === 0) return finish([], 'no-pool', 'No compatible group of consenting buyers saves money by pooling.');

  const model = new Mip();
  model.direction = 'max';
  const z = candidates.map((_, i) => model.bin(`z${i}`));
  model.objective = candidates.map((p, i) => ({ v: z[i]!, c: p.saving.minor }));
  for (const o of consenting) {
    const terms = candidates.flatMap((p, i) => (p.members.some((x) => x.buyer === o.buyer) ? [{ v: z[i]!, c: 1 }] : []));
    if (terms.length > 1) model.row(terms, '<=', 1);
  }
  const r = await solveMip(model, timeLimitMs);
  if (r.status !== 'optimal') return finish([], 'error', `Pool selection did not finish with a proven answer (${r.status}).`);
  const pools = candidates.filter((_, i) => on(r.values, z[i]!));
  return finish(
    pools,
    'pooled',
    truncated
      ? `Largest total saving among the first ${maxCandidates} candidate pools (smallest pools first), proven by HiGHS over that set only.`
      : `Largest total saving over every compatible pool of up to ${maxPoolSize} consenting buyers, proven optimal by HiGHS (gap 0) given each pool's solver plan.`,
  );
}

const groupKey = (buyers: Id[]) => [...buyers].sort().join('|');

function stability(p: Pool, costOf: Map<string, number | null>, cur: Money['currency']): PoolStability {
  const ids = p.members.map((x) => x.buyer);
  const share = new Map(p.members.map((x) => [x.buyer, x.share.minor]));
  const subs = subsets(ids, 2, ids.length - 1);
  let checked = 0;
  let unchecked = 0;
  const blocking: PoolStability['blocking'] = [];
  for (const s of subs) {
    const k = groupKey(s);
    if (!costOf.has(k)) {
      unchecked++;
      continue;
    }
    checked++;
    const cost = costOf.get(k);
    const payNow = s.reduce((a, b) => a + share.get(b)!, 0);
    if (cost != null && cost < payNow) blocking.push({ members: s, cost: m(cur, cost), payNow: m(cur, payNow) });
  }
  const stable = blocking.length ? false : unchecked ? null : true;
  const text = blocking.length
    ? `${blocking.length} subgroup${blocking.length === 1 ? '' : 's'} of this pool could buy for less on ${blocking.length === 1 ? 'its' : 'their'} own than ${blocking.length === 1 ? 'it pays' : 'they pay'} here, so the proportional split is not stable against them.`
    : unchecked
      ? `No blocking subgroup among the ${checked} checked; ${unchecked} subgroups were not solved, so stability is not established.`
      : `No member and no subgroup of this pool (${checked} subgroups checked) could buy for less on its own than it pays inside the pool.`;
  return { checked, unchecked, blocking, stable, text };
}

function buildPool(
  world: World,
  members: { order: BuyerOrder; reference: number }[],
  intent: Intent,
  plan: Plan,
  alonePlans: Map<string, Plan>,
  aloneCost: Map<string, number | null>,
): Pool {
  const cur = world.currency;
  const total = plan.total.minor;
  const shares = allocate(total, members.map((x) => x.reference));
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const tiersCrossed: TierCrossing[] = [];
  for (const a of plan.allocations) {
    const o = offers.get(a.offer)!;
    const largestAlone = Math.max(0, ...members.map((x) => alonePlans.get(x.order.buyer)?.allocations.find((b) => b.offer === a.offer)?.qty ?? x.order.intent.quantity * (world.stages.find((s) => s.id === a.stage)?.perOutcome ?? 1)));
    const aloneQty = Math.min(Math.ceil(largestAlone), a.qty);
    const pooledUnit = tierUnit(o, a.qty);
    const aloneUnit = tierUnit(o, aloneQty);
    if (pooledUnit < aloneUnit) tiersCrossed.push({ offer: o.id, actor: o.actor, pooledQty: a.qty, pooledUnit: m(cur, pooledUnit), aloneUnit: m(cur, aloneUnit) });
  }
  const aloneSetups = members.reduce((acc, x) => acc + (alonePlans.get(x.order.buyer)?.allocations.filter((b) => offers.get(b.offer)!.setupFee.minor > 0).length ?? 0), 0);
  const pooledSetups = plan.allocations.filter((b) => offers.get(b.offer)!.setupFee.minor > 0).length;
  const pm: PoolMember[] = members.map((x, i) => ({
    buyer: x.order.buyer,
    intent: x.order.intent.id,
    quantity: x.order.intent.quantity,
    budget: { ...x.order.intent.budget },
    alone: aloneCost.get(x.order.buyer) == null ? null : m(cur, aloneCost.get(x.order.buyer)!),
    reference: m(cur, x.reference),
    share: m(cur, shares[i]!),
    saving: m(cur, x.reference - shares[i]!),
  }));
  return {
    id: intent.id,
    members: pm,
    intent,
    plan,
    total: m(cur, total),
    saving: m(cur, pm.reduce((a, x) => a + x.saving.minor, 0)),
    tiersCrossed,
    setupFeesShared: Math.max(0, aloneSetups - pooledSetups),
    stability: { checked: 0, unchecked: 0, blocking: [], stable: null, text: '' },
  };
}

/**
 * Independent re-check of an aggregation result: consent, one placement per buyer, compatible pools,
 * the pooled plan re-verified by the plan checker, shares that add up exactly to the pooled cost, follow
 * the stated proportional rule, and stay within each buyer's budget and alone cost.
 */
export function verifyAggregation(result: AggregationResult, world: World, orders: BuyerOrder[]): Verification {
  const c = new Checks();
  const orderOf = new Map(orders.map((o) => [o.buyer, o]));

  const consent: string[] = [];
  for (const p of result.pools) {
    if (p.members.length < 2) consent.push(`Pool ${p.id} has fewer than two buyers.`);
    for (const x of p.members) if (!orderOf.get(x.buyer)?.consent.pool) consent.push(`${x.buyer} is pooled without consent.`);
  }
  c.add('consent', consent, 'Only buyers who agreed to pooling are pooled.');

  const placement: string[] = [];
  const count = new Map<string, number>();
  for (const p of result.pools) for (const x of p.members) count.set(x.buyer, (count.get(x.buyer) ?? 0) + 1);
  for (const a of result.alone) count.set(a.buyer, (count.get(a.buyer) ?? 0) + 1);
  for (const [b, n] of count) if (n > 1) placement.push(`${b} is placed ${n} times.`);
  for (const o of orders) if (!count.has(o.buyer) && !result.refused.some((r) => r.buyer === o.buyer)) placement.push(`${o.buyer} is missing from the result.`);
  c.add('placement', placement, 'Every buyer is placed exactly once.');

  const compat: string[] = [];
  const planProblems: string[] = [];
  const money: string[] = [];
  const limits: string[] = [];
  const stab: string[] = [];
  for (const p of result.pools) {
    const os = p.members.map((x) => orderOf.get(x.buyer)).filter((o): o is BuyerOrder => !!o);
    if (os.length !== p.members.length) {
      compat.push(`Pool ${p.id} has a member without an order.`);
      continue;
    }
    if (new Set(os.map((o) => norm(o.intent.deliverTo))).size > 1) compat.push(`Pool ${p.id} mixes destinations.`);
    if (new Set(os.map((o) => o.intent.budget.currency)).size > 1) compat.push(`Pool ${p.id} mixes currencies.`);
    const qty = os.reduce((a, o) => a + o.intent.quantity, 0);
    if (p.intent.quantity !== qty) compat.push(`Pool ${p.id} asks for ${p.intent.quantity}, members need ${qty}.`);
    const earliest = Math.min(...os.map((o) => t(o.intent.deadline)));
    if (t(p.intent.deadline) > earliest) compat.push(`Pool ${p.id} deadline is later than a member's deadline.`);
    const v = verifyPlan(p.plan, world, p.intent);
    if (!v.ok) planProblems.push(`Pool ${p.id} plan fails: ${v.checks.filter((x) => !x.ok).map((x) => x.text).join(' ')}`);
    if (p.plan.total.minor !== p.total.minor) money.push(`Pool ${p.id} total differs from its plan.`);
    const sum = p.members.reduce((a, x) => a + x.share.minor, 0);
    if (sum !== p.plan.total.minor) money.push(`Pool ${p.id} shares sum to ${sum}, the plan costs ${p.plan.total.minor}.`);
    const expected = allocate(p.plan.total.minor, p.members.map((x) => x.reference.minor));
    p.members.forEach((x, i) => {
      if (x.share.minor !== expected[i]) money.push(`${x.buyer} pays ${x.share.minor}, the proportional rule gives ${expected[i]}.`);
      if (x.saving.minor !== x.reference.minor - x.share.minor) money.push(`${x.buyer} saving does not add up.`);
      const o = orderOf.get(x.buyer)!;
      if (x.share.minor > o.intent.budget.minor) limits.push(`${x.buyer} pays ${x.share.minor}, above its budget of ${o.intent.budget.minor}.`);
      if (x.alone && x.share.minor > x.alone.minor) limits.push(`${x.buyer} pays more than buying alone.`);
      if (x.reference.minor > o.intent.budget.minor) limits.push(`${x.buyer} reference is above its budget.`);
    });
    if (p.saving.minor !== p.members.reduce((a, x) => a + x.saving.minor, 0)) money.push(`Pool ${p.id} saving does not add up.`);
    const st = p.stability;
    for (const b of st.blocking) {
      const pay = b.members.reduce((a, id) => a + (p.members.find((x) => x.buyer === id)?.share.minor ?? NaN), 0);
      if (pay !== b.payNow.minor || !(b.cost.minor < pay)) stab.push(`Pool ${p.id} lists a blocking subgroup that does not block.`);
    }
    if (st.stable === true && (st.blocking.length || st.unchecked)) stab.push(`Pool ${p.id} claims stability it has not established.`);
  }
  for (const a of result.alone) {
    const o = orderOf.get(a.buyer);
    if (a.plan && o && !verifyPlan(a.plan, world, o.intent).ok) planProblems.push(`${a.buyer} alone plan fails verification.`);
  }
  c.add('compatible', compat, 'Every pool combines orders for one destination, sums quantities and meets the earliest deadline.');
  c.add('plans', planProblems, 'Every pooled and alone plan passes the independent plan check.');
  c.add('shares', money, 'Shares add up exactly to each pooled cost and follow the proportional rule.');
  c.add('limits', limits, 'No buyer pays above its budget or above what it would pay alone.');
  c.add('stability', stab, 'Stability statements match the subgroup costs they cite.');
  const total = result.pools.reduce((a, p) => a + p.saving.minor, 0);
  c.add('totals', total === result.totalSaving.minor ? [] : [`Total saving ${result.totalSaving.minor}, recomputed ${total}.`], 'Total saving adds up.');
  return c.result();
}
