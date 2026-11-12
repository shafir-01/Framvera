import { money } from '@framvera/contracts';
import type { Agreement, Allocation, Disruption, Id, Intent, Iso, Money, Obligation, StageId, World } from '@framvera/contracts';
import { LIVE_OBLIGATION, impactOf } from '@framvera/obligations';
import { solve } from '@framvera/solver';
import { assessRisk, supplierHazard } from './risk.ts';
import { absorbsLate, planExercise, spendable, withStandby } from './standby.ts';
import type { FailureMode, LossStats, ObligationRisk, OptionLike, OptionValue, StandbyOption, Valuation, ValueAssumptions } from './types.ts';
import { HOUR, downstream, fmtKr, iso, ms, pick, rng, toAllocation } from './util.ts';

export const DEFAULT_SEED = 20261112;

export interface ValueOptions {
  seed?: number;
  scenarios?: number;
  risks?: ObligationRisk[];
  at?: Iso;
  /** Cap on total fees. The default is the budget and spending authority left after the committed plan. */
  budget?: Money;
  lossOnMiss?: Money;
  availability?: number;
  rushPremiums?: number[];
  noticeHours?: number[];
  delayHours?: number[];
  capacityShares?: number[];
  timeLimitMs?: number;
}

type Disrupt = Disruption & { params?: { capacity?: number; delayHours?: number } };

interface Event {
  obligation: Obligation;
  mode: FailureMode;
  at: number;
  capacity?: number;
  delayHours?: number;
}

interface Scenario {
  i: number;
  events: Event[];
  at: number;
  unavailable: Set<Id>;
  rush: number;
  backupDown: Set<Id>;
}

interface Base {
  world: World;
  failed: Obligation[];
  kept: Allocation[];
  absorbed: boolean;
  relevant: Set<StageId>;
  market: World;
  key: string;
}

/** Fixed-seed scenarios over the risk model plus market conditions at the moment a failure surfaces. */
function sample(
  risks: ObligationRisk[],
  live: Obligation[],
  world: World,
  options: readonly OptionLike[],
  a: ValueAssumptions,
  n: number,
  seed: number,
  now: number,
): Scenario[] {
  const r = rng(seed);
  const byId = new Map(live.map((o) => [o.id, o]));
  const committed = new Map<Id, number>();
  for (const o of live) committed.set(o.offer, (committed.get(o.offer) ?? 0) + o.qty);
  const open = world.offers.filter((o) => !committed.has(o.id)).map((o) => o.id).sort();
  const backups = [...new Set(options.map((o) => o.terms.supplier))].sort();
  const backupFail = new Map(backups.map((id) => [id, 1 - supplierHazard(world, id).effective]));
  const ordered = [...risks].sort((x, y) => (x.obligation < y.obligation ? -1 : 1));
  const offerOf = new Map(world.offers.map((o) => [o.id, o]));
  const out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const events: Event[] = [];
    for (const risk of ordered) {
      const ob = byId.get(risk.obligation);
      const hits = new Set<FailureMode>();
      for (const f of risk.factors) if (r() < f.p) hits.add(f.mode);
      const uLevel = r();
      const uNotice = r();
      if (!ob || !hits.size) continue;
      const mode: FailureMode = hits.has('withdraw') ? 'withdraw' : hits.has('capacity-drop') ? 'capacity-drop' : 'delay';
      const at = Math.max(now, ms(ob.start) - pick(a.noticeHours, uNotice) * HOUR);
      if (mode === 'capacity-drop') {
        const keep = Math.floor(pick(a.capacityShares, uLevel) * ob.qty);
        events.push({ obligation: ob, mode, at, capacity: (committed.get(ob.offer) ?? ob.qty) - ob.qty + keep });
      } else if (mode === 'delay') events.push({ obligation: ob, mode, at, delayHours: pick(a.delayHours, uLevel) });
      else events.push({ obligation: ob, mode, at });
    }
    const at = events.length ? Math.max(...events.map((e) => e.at)) : now;
    const unavailable = new Set<Id>();
    for (const id of open) {
      const u = r();
      const offer = offerOf.get(id)!;
      if (u >= a.availability || ms(offer.validUntil) < at) unavailable.add(id);
    }
    const rush = pick(a.rushPremiums, r());
    const backupDown = new Set<Id>();
    for (const id of backups) if (r() < (backupFail.get(id) ?? 0)) backupDown.add(id);
    out.push({ i, events, at, unavailable, rush, backupDown });
  }
  return out;
}

function disruptionsOf(s: Scenario): Disrupt[] {
  const out: Disrupt[] = [];
  const withdrawn = new Set<Id>();
  for (const e of s.events) {
    const id = `scenario-${s.i}-${e.obligation.id}`;
    const at = iso(e.at);
    if (e.mode === 'withdraw') {
      if (withdrawn.has(e.obligation.actor)) continue;
      withdrawn.add(e.obligation.actor);
      out.push({ id, kind: 'withdraw', actor: e.obligation.actor, detail: 'Supplier withdraws.', at });
    } else if (e.mode === 'capacity-drop') {
      out.push({ id, kind: 'capacity-drop', offer: e.obligation.offer, detail: `Capacity falls to ${e.capacity}.`, at, params: { capacity: e.capacity } });
    } else out.push({ id, kind: 'delay', offer: e.obligation.offer, detail: `Delayed ${e.delayHours} hours.`, at, params: { delayHours: e.delayHours } });
  }
  return out;
}

function lossStats(losses: number[], miss: boolean[], disrupted: number, currency: Money['currency']): LossStats {
  const n = losses.length;
  const mean = losses.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(losses.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = (1.96 * sd) / Math.sqrt(n);
  const sorted = [...losses].sort((x, y) => x - y);
  const tail = Math.ceil(0.1 * n);
  const m = (x: number) => money(currency, Math.round(x));
  return {
    expected: m(mean),
    ci95: [m(mean - half), m(mean + half)],
    var90: m(sorted[Math.max(0, Math.ceil(0.9 * n) - 1)] ?? 0),
    cvar90: tail >= 10 ? m(sorted.slice(n - tail).reduce((s, x) => s + x, 0) / tail) : null,
    pMiss: miss.filter(Boolean).length / n,
    pDisrupted: disrupted / n,
  };
}

function meanCi(diff: number[]): [number, number, number] {
  const n = diff.length;
  const mean = diff.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diff.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = (1.96 * sd) / Math.sqrt(n);
  return [mean, mean - half, mean + half];
}

/**
 * Expected loss avoided by each standby option under a fixed-seed sample of disruptions, with every candidate
 * evaluated on the same scenarios. Losses come from the exercise check or, when no option applies, from a
 * solver recovery that keeps unaffected obligations fixed. Options are bought greedily by net marginal value,
 * only while that value is positive and the fees fit the budget.
 */
export async function valueOptions(
  world: World,
  intent: Intent,
  agreement: Agreement,
  options: readonly StandbyOption[],
  opts: ValueOptions = {},
): Promise<Valuation> {
  const t0 = performance.now();
  const currency = intent.budget.currency;
  const at = opts.at ?? agreement.createdAt;
  const now = ms(at);
  const seed = opts.seed ?? DEFAULT_SEED;
  const n = opts.scenarios ?? 200;
  const assumptions: ValueAssumptions = {
    lossOnMiss: opts.lossOnMiss ?? intent.budget,
    availability: opts.availability ?? 0.7,
    rushPremiums: opts.rushPremiums ?? [0, 0.1, 0.2, 0.3],
    noticeHours: opts.noticeHours ?? [0, 6, 12, 24],
    delayHours: opts.delayHours ?? [4, 12, 24],
    capacityShares: opts.capacityShares ?? [0.25, 0.5, 0.75],
  };
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const oldTotal = live.reduce((s, o) => s + o.amount.minor, 0);
  const candidates = options.filter((o) => o.status === 'quoted' || o.status === 'purchased');
  const risks = opts.risks ?? assessRisk(world, agreement, { at });
  const scenarios = sample(risks, live, world, candidates, assumptions, n, seed, now);
  const committed = new Set(live.map((o) => o.offer));
  let solves = 0;

  const bases = new Map<number, Base | null>();
  const baseOf = (s: Scenario): Base | null => {
    if (bases.has(s.i)) return bases.get(s.i)!;
    if (!s.events.length) return bases.set(s.i, null), null;
    let w = world;
    const failedIds = new Set<Id>();
    const must = new Set<Id>();
    for (const d of disruptionsOf(s)) {
      const imp = impactOf(agreement, w, d, { notBefore: s.at });
      w = imp.world;
      for (const o of imp.failed) failedIds.add(o.id);
      for (const o of imp.mustChange) must.add(o.id);
    }
    const failed = live.filter((o) => failedIds.has(o.id));
    const kept = live.filter((o) => !failedIds.has(o.id)).map(toAllocation);
    const delays = new Set(s.events.filter((e) => e.mode === 'delay').map((e) => e.obligation.id));
    let absorbed = failed.length === 0;
    if (!absorbed && failed.every((o) => delays.has(o.id))) absorbed = absorbsLate(w, intent, s.at, kept, failed);
    const relevant = new Set<StageId>();
    for (const o of [...failed, ...live.filter((x) => must.has(x.id))]) {
      relevant.add(o.stage);
      for (const st of downstream(w, o.stage)) relevant.add(st);
    }
    const market: World = {
      ...w,
      offers: w.offers
        .filter((o) => committed.has(o.id) || !s.unavailable.has(o.id))
        .map((o) => (committed.has(o.id) || !s.rush ? o : { ...o, tiers: o.tiers.map((t) => ({ ...t, unit: { ...t.unit, minor: Math.round(t.unit.minor * (1 + s.rush)) } })) })),
    };
    const relevantOffers = world.offers.filter((o) => relevant.has(o.stage) && s.unavailable.has(o.id)).map((o) => o.id).sort();
    const key = JSON.stringify([s.events.map((e) => [e.obligation.id, e.mode, e.capacity, e.delayHours]), s.at, relevantOffers, s.rush]);
    const base: Base = { world: w, failed, kept, absorbed, relevant, market, key };
    bases.set(s.i, base);
    return base;
  };

  const solveCache = new Map<string, { loss: number; miss: boolean }>();
  const recoverLoss = async (s: Scenario, b: Base, opts2: readonly OptionLike[], spent: number) => {
    const key = `${b.key}|${opts2.map((o) => o.id).sort().join(',')}|${spent}`;
    const hit = solveCache.get(key);
    if (hit) return hit;
    const w = withStandby(b.market, opts2, iso(s.at));
    const checkIntent = spendable(intent, spent, s.at);
    let result = { loss: assumptions.lossOnMiss.minor, miss: true };
    const attempts = [b.kept, b.kept.filter((a) => !b.relevant.has(a.stage))];
    for (const [k, fixed] of attempts.entries()) {
      if (k === 1 && fixed.length === b.kept.length) break;
      solves++;
      const rep = await solve(w, checkIntent, { fixed, explain: false, timeLimitMs: opts.timeLimitMs ?? 3000 });
      if ((rep.status === 'optimal' || rep.status === 'feasible') && rep.plan) {
        result = { loss: rep.plan.total.minor - oldTotal, miss: false };
        break;
      }
    }
    solveCache.set(key, result);
    return result;
  };

  const lossCache = new Map<string, { loss: number; miss: boolean }>();
  const lossOf = async (s: Scenario, set: readonly OptionLike[]) => {
    const b = baseOf(s);
    if (!b || b.absorbed) return { loss: 0, miss: false };
    const usable = set.filter((o) => b.relevant.has(o.terms.stage) && !s.backupDown.has(o.terms.supplier));
    const spent = set.reduce((acc, o) => acc + o.terms.fee.minor, 0);
    const key = `${s.i}|${usable.map((o) => o.id).sort().join(',')}|${spent}`;
    const hit = lossCache.get(key);
    if (hit) return hit;
    let result: { loss: number; miss: boolean } | undefined;
    if (usable.length) {
      const ex = planExercise({ world: b.market, intent, at: s.at, kept: b.kept, failed: b.failed, options: usable, spentMinor: spent });
      if (ex.ok) result = { loss: ex.picks.reduce((acc, p) => acc + p.allocation.cost.minor - p.obligation.amount.minor, 0), miss: false };
    }
    result ??= await recoverLoss(s, b, usable, spent);
    lossCache.set(key, result);
    return result;
  };

  const run = async (set: readonly OptionLike[]) => {
    const losses: number[] = [];
    const miss: boolean[] = [];
    for (const s of scenarios) {
      const l = await lossOf(s, set);
      losses.push(l.loss);
      miss.push(l.miss);
    }
    return { losses, miss };
  };

  const disrupted = scenarios.filter((s) => s.events.length).length;
  const base = await run([]);
  const headroom = Math.min(intent.budget.minor - oldTotal, intent.authority.maxSpend.currency === currency ? intent.authority.maxSpend.minor - oldTotal : Infinity);
  const budgetMinor = intent.authority.mayReserve ? Math.max(0, Math.min(headroom, opts.budget?.minor ?? Infinity)) : 0;
  const m = (x: number) => money(currency, Math.round(x));

  const standalone = new Map<Id, [number, number, number]>();
  for (const o of candidates) {
    const r = await run([o]);
    standalone.set(o.id, meanCi(base.losses.map((x, k) => x - r.losses[k]!)));
  }

  const chosen: StandbyOption[] = [];
  const marginal = new Map<Id, number>();
  let current = base;
  let left = budgetMinor;
  for (;;) {
    let best: { o: StandbyOption; net: number; gain: number; r: typeof base } | undefined;
    for (const o of candidates) {
      if (chosen.includes(o) || o.terms.fee.minor > left) continue;
      const r = await run([...chosen, o]);
      const gain = current.losses.reduce((s, x, k) => s + x - r.losses[k]!, 0) / n;
      const net = gain - o.terms.fee.minor;
      if (net > 0 && (!best || net > best.net)) best = { o, net, gain, r };
    }
    if (!best) break;
    chosen.push(best.o);
    marginal.set(best.o.id, best.gain);
    current = best.r;
    left -= best.o.terms.fee.minor;
  }

  const values: OptionValue[] = candidates.map((o) => {
    const [mean, lo, hi] = standalone.get(o.id)!;
    const fee = o.terms.fee.minor;
    const buy = chosen.includes(o);
    const gain = marginal.get(o.id);
    let reason: string;
    if (buy) reason = `Expected loss avoided ${fmtKr(gain ?? mean)} exceeds the ${fmtKr(fee)} fee.`;
    else if (!intent.authority.mayReserve) reason = 'The buyer has not authorised holding capacity.';
    else if (mean - fee <= 0) reason = `Expected loss avoided ${fmtKr(mean)} does not exceed the ${fmtKr(fee)} fee.`;
    else if (fee > budgetMinor) reason = `The ${fmtKr(fee)} fee does not fit the ${fmtKr(budgetMinor)} available.`;
    else reason = 'Adds less than its fee once the chosen options are held.';
    return {
      option: o.id,
      fee: o.terms.fee,
      avoided: m(mean),
      avoidedCi95: [m(lo), m(hi)],
      net: m(mean - fee),
      ...(gain === undefined ? {} : { marginal: m(gain) }),
      buy,
      reason,
    };
  });

  return {
    label: 'planner-estimate',
    seed,
    scenarios: n,
    assumptions,
    baseline: lossStats(base.losses, base.miss, disrupted, currency),
    withOptions: lossStats(current.losses, current.miss, disrupted, currency),
    options: values,
    buy: chosen.map((o) => o.id),
    fees: m(chosen.reduce((s, o) => s + o.terms.fee.minor, 0)),
    budget: m(budgetMinor),
    solves,
    ms: Math.round(performance.now() - t0),
  };
}
