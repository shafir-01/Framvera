import type { Id, Intent, NegotiableField, Offer, Verification, World } from '@framvera/contracts';
import { effectiveCapacity, isUsable } from '@framvera/contracts';
import { solve, verifyPlan } from '@framvera/solver';
import { quantityLevels, runReverseAuction, type BidItem, type PackageBid } from './auction.ts';
import { meanCI, publishedPrice, rng, stageDemand, tierUnit, wilson, type MeanCI } from './util.ts';

type Limits = Partial<Record<NegotiableField, number | string | boolean>>;

/** Structural view of a private supplier policy; only price limits are read. */
export interface PolicyView {
  reservation?: Limits;
  offers?: Record<Id, Limits>;
  [k: string]: unknown;
}

/** Structural view of the market's hidden truth, held by the caller on the referee side. */
export interface TruthView {
  policies: Record<Id, unknown>;
  [k: string]: unknown;
}

export interface BidRequest {
  intent: Intent;
  world: World;
  bundles: boolean;
  levels: number[];
}

/** What a mechanism may see: bids, never the policies behind them. */
export interface BidDesk {
  solicit(req: BidRequest): PackageBid[];
}

/** Referee-only: private reservation costs and real capacities, used to score results after the fact. */
export interface CostAudit {
  cost(items: BidItem[]): number;
  /** Offers asked for more units than they can really deliver. */
  overClaimed(qty: Map<Id, number>): Id[];
}

export interface BidBehaviour {
  /** Markup over private reservation cost, per supplier, as a share (0.1 = 10%). */
  markup: Record<Id, number>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Supplier side of the experiment. Policies stay in this closure; the desk returns bids and the audit
 * returns costs. Module separation inside one process, not a security boundary.
 */
export function createBidBoundary(truth: TruthView, world: World, behaviour: BidBehaviour): { desk: BidDesk; audit: CostAudit } {
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const limit = (o: Offer, f: NegotiableField): number | undefined => {
    const p = truth.policies[o.actor] as PolicyView | undefined;
    return num(p?.offers?.[o.id]?.[f]) ?? num(p?.reservation?.[f]);
  };
  const first = (o: Offer) => tierUnit(o, 0) || tierUnit(o, o.minQty);
  const setupFloor = (o: Offer) => Math.max(0, Math.min(o.setupFee.minor, limit(o, 'setupFee') ?? o.setupFee.minor));
  const unitFloor = (o: Offer, q: number) => {
    const f1 = Math.max(0, Math.min(first(o), limit(o, 'unitPrice') ?? first(o)));
    return first(o) > 0 ? Math.round((f1 * tierUnit(o, q)) / first(o)) : tierUnit(o, q);
  };
  const single = (o: Offer, q: number) => unitFloor(o, q) * q + setupFloor(o);
  const cost = (items: BidItem[]): number => {
    const os = items.map((it) => offers.get(it.offer)!);
    const total = items.reduce((a, it, k) => a + single(os[k]!, it.qty), 0);
    if (items.length < 2) return total;
    const setups = os.map(setupFloor);
    return total - setups.reduce((a, b) => a + b, 0) + Math.max(...setups);
  };
  const ask = (items: BidItem[], actor: Id): number => {
    const mk = Math.max(0, behaviour.markup[actor] ?? 0);
    const published = items.reduce((a, it) => a + publishedPrice(offers.get(it.offer)!, it.qty), 0);
    return Math.min(published, Math.ceil(cost(items) * (1 + mk)));
  };

  const desk: BidDesk = {
    solicit(req) {
      const cur = req.intent.budget.currency;
      const now = req.intent.provenance.observedAt;
      const bids: PackageBid[] = [];
      const active = new Set(req.world.actors.filter((a) => a.active && (a.kind === 'supplier' || a.kind === 'logistics')).map((a) => a.id));
      const byActor = new Map<Id, { offer: Offer; levels: number[] }[]>();
      for (const s of req.world.stages) {
        const need = stageDemand(s, req.intent);
        if (need <= 0) continue;
        for (const o of req.world.offers) {
          if (o.stage !== s.id || !active.has(o.actor) || !isUsable(req.world, o) || !truth.policies[o.actor]) continue;
          const levels = quantityLevels(need, o.minQty, effectiveCapacity(req.world, o), req.levels);
          if (levels.length) byActor.set(o.actor, [...(byActor.get(o.actor) ?? []), { offer: o, levels }]);
        }
      }
      for (const [actor, menu] of byActor) {
        const combos = menu.reduce((a, x) => a * (x.levels.length + 1), 1) - 1;
        const bundled = req.bundles && menu.length > 1 && combos <= 400;
        if (!bundled) {
          for (const { offer, levels } of menu) {
            for (const q of levels) {
              const items = [{ offer: offer.id, qty: q }];
              bids.push({ id: `${actor}:${offer.id}:${q}`, bidder: actor, items, price: { currency: cur, minor: ask(items, actor) }, exclusiveGroup: `${actor}:${offer.id}`, provenance: { source: 'synthetic-market', observedAt: now } });
            }
          }
          continue;
        }
        const rec = (k: number, acc: BidItem[]) => {
          if (k === menu.length) {
            if (!acc.length) return;
            const items = acc.slice();
            const id = `${actor}:${items.map((it) => `${it.offer}=${it.qty}`).join('+')}`;
            bids.push({ id, bidder: actor, items, price: { currency: cur, minor: ask(items, actor) }, exclusiveGroup: actor, provenance: { source: 'synthetic-market', observedAt: now } });
            return;
          }
          rec(k + 1, acc);
          for (const q of menu[k]!.levels) {
            acc.push({ offer: menu[k]!.offer.id, qty: q });
            rec(k + 1, acc);
            acc.pop();
          }
        };
        rec(0, []);
      }
      return bids;
    },
  };
  const real = (truth.realCapacity ?? {}) as Record<Id, number>;
  const overClaimed = (qty: Map<Id, number>) => [...qty].filter(([o, q]) => typeof real[o] === 'number' && q > real[o]!).map(([o]) => o);
  return { desk, audit: { cost, overClaimed } };
}

export type MechanismId = 'posted-price' | 'reverse-auction' | 'combinatorial-auction';

export const MECHANISMS: Record<MechanismId, string> = {
  'posted-price': 'Buy at published prices (cheapest verified plan)',
  'reverse-auction': 'Reverse auction, one bid menu per offer, pay-as-bid',
  'combinatorial-auction': 'Combinatorial reverse auction with package bids, pay-as-bid',
};

const counts = (r: TrialResult) => r.verified && r.deliverable;

export interface CompareOptions {
  trials?: number;
  seed?: number;
  /** Largest markup a bidder draws over its reservation cost. Default 0.25. */
  maxMarkup?: number;
  /** Chance each supplier is unavailable in a trial. Default 0.1. */
  dropRate?: number;
  mechanisms?: MechanismId[];
  levels?: number[];
  timeLimitMs?: number;
}

export interface TrialResult {
  mechanism: MechanismId;
  status: string;
  verified: boolean;
  /** No offer was asked for more than it can really deliver (checked against hidden real capacity). */
  deliverable: boolean;
  paid: number | null;
  buyerSurplus: number;
  supplierSurplus: number;
  totalSurplus: number;
  /** Winners paid below their private reservation cost (should be none). */
  belowCost: Id[];
  failed: string[];
}

export interface Trial {
  trial: number;
  unavailable: Id[];
  results: TrialResult[];
}

export interface MechanismStats {
  id: MechanismId;
  label: string;
  verified: number;
  /** Trials both verified and deliverable; only these score surplus. */
  counted: number;
  trials: number;
  countedRate: [number, number] | null;
  buyerSurplus: MeanCI | null;
  supplierSurplus: MeanCI | null;
  totalSurplus: MeanCI | null;
  meanPaid: number | null;
  wins: number;
  belowCost: number;
}

export interface MechanismExperiment {
  world: Id;
  worldVersion: number;
  intent: Id;
  currency: string;
  trials: number;
  seed: number;
  design: string[];
  mechanisms: MechanismStats[];
  best: { buyer: MechanismId | null; total: MechanismId | null };
  comparison: { leader: MechanismId; runnerUp: MechanismId; meanDiff: MeanCI; distinguishable: boolean } | null;
  statement: string;
  runs: Trial[];
}

/**
 * Runs candidate mechanisms on the same world against private supplier policies. Each trial draws, on the
 * referee side, which suppliers are unavailable and each bidder's markup; mechanisms see only published
 * offers and bids. A result counts only when its own independent verifier passes. Surplus is measured
 * against the buyer's budget and each supplier's private reservation cost.
 */
export async function compareMechanisms(world: World, intent: Intent, truth: TruthView, opts: CompareOptions = {}): Promise<MechanismExperiment> {
  const trials = opts.trials ?? 20;
  const seed = opts.seed ?? 1;
  const maxMarkup = opts.maxMarkup ?? 0.25;
  const dropRate = opts.dropRate ?? 0.1;
  const ids = opts.mechanisms ?? (Object.keys(MECHANISMS) as MechanismId[]);
  const levels = opts.levels ?? [0.25, 0.5, 0.75, 1];
  const timeLimitMs = opts.timeLimitMs ?? 5000;
  const budget = intent.budget.minor;
  const suppliers = world.actors.filter((a) => a.kind === 'supplier' || a.kind === 'logistics').map((a) => a.id);
  const runs: Trial[] = [];

  for (let k = 0; k < trials; k++) {
    const r = rng(seed * 7919 + k);
    const unavailable = suppliers.filter(() => r() < dropRate);
    const markup = Object.fromEntries(suppliers.map((s) => [s, r() * maxMarkup]));
    const w: World = { ...world, actors: world.actors.map((a) => (unavailable.includes(a.id) ? { ...a, active: false } : a)) };
    const { desk, audit } = createBidBoundary(truth, w, { markup });
    const results: TrialResult[] = [];
    for (const id of ids) results.push(await runOne(id, w, intent, desk, audit, budget, levels, timeLimitMs));
    runs.push({ trial: k, unavailable, results });
  }

  const stats: MechanismStats[] = ids.map((id) => {
    const rs = runs.map((t) => t.results.find((x) => x.mechanism === id)!);
    const ok = rs.filter(counts);
    const wins = runs.filter((t) => {
      const best = Math.max(...t.results.filter(counts).map((x) => x.buyerSurplus));
      const mine = t.results.find((x) => x.mechanism === id)!;
      return counts(mine) && mine.buyerSurplus === best && t.results.filter((x) => counts(x) && x.buyerSurplus === best).length === 1;
    }).length;
    return {
      id,
      label: MECHANISMS[id],
      verified: rs.filter((x) => x.verified).length,
      counted: ok.length,
      trials,
      countedRate: wilson(ok.length, trials),
      buyerSurplus: meanCI(rs.map((x) => x.buyerSurplus)),
      supplierSurplus: meanCI(rs.map((x) => x.supplierSurplus)),
      totalSurplus: meanCI(rs.map((x) => x.totalSurplus)),
      meanPaid: ok.length ? ok.reduce((a, x) => a + x.paid!, 0) / ok.length : null,
      wins,
      belowCost: rs.reduce((a, x) => a + x.belowCost.length, 0),
    };
  });

  const ranked = stats.filter((s) => s.counted > 0).sort((a, b) => (b.buyerSurplus?.mean ?? 0) - (a.buyerSurplus?.mean ?? 0));
  const byTotal = stats.filter((s) => s.counted > 0).sort((a, b) => (b.totalSurplus?.mean ?? 0) - (a.totalSurplus?.mean ?? 0));
  let comparison: MechanismExperiment['comparison'] = null;
  if (ranked.length >= 2) {
    const [a, b] = [ranked[0]!, ranked[1]!];
    const diffs = runs.map((t) => t.results.find((x) => x.mechanism === a.id)!.buyerSurplus - t.results.find((x) => x.mechanism === b.id)!.buyerSurplus);
    const d = meanCI(diffs)!;
    comparison = { leader: a.id, runnerUp: b.id, meanDiff: d, distinguishable: d.lo > 0 || d.hi < 0 };
  }
  const lead = ranked[0];
  const statement = !lead
    ? `No mechanism produced a verified plan in any of ${trials} trials.`
    : `${MECHANISMS[lead.id]}: verified and deliverable in ${lead.counted}/${trials} trials, highest buyer surplus in ${lead.wins}/${trials}. ` +
      (comparison
        ? comparison.distinguishable
          ? `Its mean buyer surplus exceeds ${MECHANISMS[comparison.runnerUp].toLowerCase()} by ${Math.round(comparison.meanDiff.mean)} minor units (95% CI ${Math.round(comparison.meanDiff.lo)} to ${Math.round(comparison.meanDiff.hi)}).`
          : `The difference to ${MECHANISMS[comparison.runnerUp].toLowerCase()} is not distinguishable at 95% (CI ${Math.round(comparison.meanDiff.lo)} to ${Math.round(comparison.meanDiff.hi)} minor units).`
        : '') +
      ' This holds for this world under the simulated bidding rules only.';

  return {
    world: world.id,
    worldVersion: world.version,
    intent: intent.id,
    currency: intent.budget.currency,
    trials,
    seed,
    design: [
      `${trials} trials. In each, every supplier is unavailable with probability ${dropRate} and draws a markup between 0 and ${Math.round(maxMarkup * 100)}% over its private reservation cost.`,
      'Bids are capped at the supplier’s published price for the same units.',
      'Package bids assume one shared setup per supplier: setup costs after the largest are saved. This is a modelling assumption.',
      'A trial counts only when the mechanism’s own verifier passes and no offer is asked for more than it can really deliver (hidden real capacity); any other trial scores zero surplus (no purchase).',
      'Buyer surplus is budget minus payment. Supplier surplus is payment minus private reservation cost. Total is their sum.',
      'Bidders here follow a fixed random markup, not an equilibrium strategy, so the comparison is not a statement about strategic behaviour in general.',
    ],
    mechanisms: stats,
    best: { buyer: lead?.id ?? null, total: byTotal[0]?.id ?? null },
    comparison,
    statement,
    runs,
  };
}

async function runOne(
  id: MechanismId,
  world: World,
  intent: Intent,
  desk: BidDesk,
  audit: CostAudit,
  budget: number,
  levels: number[],
  timeLimitMs: number,
): Promise<TrialResult> {
  const none = (status: string, failed: string[] = []): TrialResult => ({ mechanism: id, status, verified: false, deliverable: false, paid: null, buyerSurplus: 0, supplierSurplus: 0, totalSurplus: 0, belowCost: [], failed });
  const score = (paid: number, packages: { bidder: Id; items: BidItem[]; paid: number }[], v: Verification, status: string): TrialResult => {
    if (!v.ok) return none(status, v.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.text}`));
    const qty = new Map<Id, number>();
    for (const p of packages) for (const it of p.items) qty.set(it.offer, (qty.get(it.offer) ?? 0) + it.qty);
    const over = audit.overClaimed(qty);
    if (over.length) return { ...none(status, over.map((o) => `${o}: asked for more than it can really deliver.`)), verified: true };
    const costs = packages.map((p) => audit.cost(p.items));
    const cost = costs.reduce((a, b) => a + b, 0);
    const belowCost = packages.filter((p, i) => p.paid < costs[i]!).map((p) => p.bidder);
    return { mechanism: id, status, verified: true, deliverable: true, paid, buyerSurplus: budget - paid, supplierSurplus: paid - cost, totalSurplus: budget - cost, belowCost, failed: [] };
  };

  if (id === 'posted-price') {
    const r = await solve(world, intent, { timeLimitMs, explain: false });
    if (!r.plan) return none(r.status);
    const v = verifyPlan(r.plan, world, intent);
    const packages = r.plan.allocations.map((a) => ({ bidder: a.actor, items: [{ offer: a.offer, qty: a.qty }], paid: a.cost.minor }));
    return score(r.plan.total.minor, packages, v, r.status);
  }
  const bids = desk.solicit({ world, intent, bundles: id === 'combinatorial-auction', levels });
  const res = await runReverseAuction(world, intent, bids, { timeLimitMs });
  if (res.status !== 'awarded' || !res.total) return none(res.status, res.diagnosis);
  const packages = res.winners.map((w) => ({ bidder: w.bidder, items: w.items, paid: w.price.minor }));
  return score(res.total.minor, packages, res.verification, res.status);
}
