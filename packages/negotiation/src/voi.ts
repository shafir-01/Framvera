import type { Concession, Id, Intent, Intervention, Iso, Money, World } from '@framvera/contracts';
import type {
  AcceptanceEstimate,
  FeasibleSet,
  OutcomeModel,
  QuestionMessage,
  RankedQuestion,
  SolverApi,
} from './types.ts';
import {
  HOUR,
  actorName,
  buyerId,
  clamp,
  concessionKey,
  findOffer,
  fmtMoney,
  fmtTime,
  median,
  money,
  numeric,
  platformId,
  sameKind,
  unitPriceAt,
} from './util.ts';

const SLOPE: Record<string, number> = {
  unitPrice: 3,
  setupFee: 1,
  minQty: 1,
  capacity: 1.5,
  windowEnd: 1,
  windowStart: 1,
};

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Planner's prior that a supplier says yes to a concession, from public signals only:
 * the offer's negotiable flags, the size of the change, and the price position against
 * other published offers for the same stage. Ranges are explicit; none of this reads a private policy.
 */
export function estimateAcceptance(c: Concession, world: World, intent: Intent): AcceptanceEstimate {
  const signals: string[] = [];
  if (c.target.kind === 'intent') {
    const field = c.target.field;
    const from = numeric(field, c.from) ?? 0;
    const to = numeric(field, c.to) ?? 0;
    const asked = field === 'deadline' ? (to - from) / HOUR : to - from;
    const allowed = field === 'deadline' ? intent.negotiable.deadlineHours : intent.negotiable.budgetMinor;
    if (allowed !== undefined && asked <= allowed) {
      signals.push(`Within the ${field} flexibility you stated; still needs your explicit yes.`);
      return { lo: 0.8, mid: 0.9, hi: 1, signals };
    }
    signals.push(`Beyond the ${field} flexibility you stated.`);
    return { lo: 0.02, mid: 0.1, hi: 0.2, signals };
  }

  const offer = findOffer(world, c.target.offer);
  if (!offer) return { lo: 0, mid: 0, hi: 0, signals: ['Offer not found.'] };
  const field = c.target.field;
  const flagged = offer.negotiable.includes(field);
  signals.push(flagged ? `${offer.id} lists ${field} as negotiable.` : `${offer.id} does not list ${field} as negotiable.`);
  let base = flagged ? 0.8 : 0.25;
  let width = flagged ? 0.15 : 0.2;

  if (field === 'joint') {
    const mid = flagged ? 0.55 : 0.15;
    return { lo: round2(clamp(mid - width, 0.01, 0.99)), mid, hi: round2(clamp(mid + width, 0.01, 0.99)), signals };
  }

  const from = numeric(field, c.from) ?? 0;
  const to = numeric(field, c.to) ?? 0;
  let magnitude = 0;
  if (field === 'windowEnd' || field === 'windowStart') {
    const len = Math.max(HOUR, Date.parse(offer.window.end) - Date.parse(offer.window.start));
    magnitude = Math.abs(to - from) / len;
    signals.push(`Moves the window by ${Math.round(Math.abs(to - from) / HOUR)} h on a ${Math.round(len / HOUR)} h window.`);
  } else if (from !== 0) {
    magnitude = Math.abs(to - from) / Math.abs(from);
    signals.push(`A ${Math.round(magnitude * 100)}% change to ${field}.`);
  }

  let adjust = 0;
  if (field === 'unitPrice') {
    const stage = world.stages.find((s) => s.id === offer.stage);
    const qty = Math.ceil(intent.quantity * (stage?.perOutcome ?? 1));
    const peers = world.offers
      .filter((o) => o.stage === offer.stage && o.id !== offer.id)
      .map((o) => unitPriceAt(o, qty));
    const med = median(peers);
    if (med !== undefined && med > 0) {
      const position = (from - med) / med;
      if (position > 0) {
        adjust += Math.min(0.15, position * 0.5);
        signals.push(`Current price is ${Math.round(position * 100)}% above the median for this stage.`);
      } else if (position < 0) {
        adjust -= Math.min(0.1, -position * 0.5);
        signals.push(`Current price is already ${Math.round(-position * 100)}% below the median for this stage.`);
      }
      const floor = Math.min(...peers);
      if (to < floor) {
        adjust -= 0.15;
        signals.push('The asked price undercuts every other published offer for this stage.');
      }
    } else {
      width += 0.05;
      signals.push('No other published price for this stage to compare against.');
    }
  }
  if (field === 'capacity') {
    const capClaim = world.claims.find((cl) => offer.claims.includes(cl.id) && cl.subject.startsWith('capacity'));
    if (!capClaim || capClaim.tier === 'single-claim' || capClaim.tier === 'simulation-only') {
      width += 0.05;
      signals.push('Capacity rests on an unverified claim, so the range is wider.');
    }
  }
  base -= (SLOPE[field] ?? 1) * magnitude;
  const mid = round2(clamp(base + adjust, 0.02, 0.95));
  return { lo: round2(clamp(mid - width, 0.01, 0.99)), mid, hi: round2(clamp(mid + width, 0.01, 0.99)), signals };
}

function midpoint(c: Concession): Concession | undefined {
  if (c.target.kind !== 'offer' || c.target.field === 'joint') return undefined;
  const field = c.target.field;
  const a = numeric(field, c.from);
  const b = numeric(field, c.to);
  if (a === undefined || b === undefined) return undefined;
  let m = (a + b) / 2;
  m = field === 'windowEnd' || field === 'windowStart' ? Math.round(m / 60_000) * 60_000 : Math.round(m);
  if (m === a || m === b) return undefined;
  return { ...c, id: `${c.id}~half`, to: sameKind(field, c.to, m), rationale: `${c.rationale} (half the requested change)` };
}

function setOf(concessions: Concession[], total: Money, source: FeasibleSet['source'], intervention: Id): FeasibleSet {
  return { keys: concessions.map(concessionKey).sort(), concessions, total, source, intervention };
}

/**
 * Re-evaluates possible supplier answers with the solver: the reject outcome of each concession
 * (is the rest still enough?) and a partial counter (is half the change enough?). Every feasible
 * set it returns comes from an actual solve plus independent plan verification.
 */
export async function simulateOutcomes(
  world: World,
  intent: Intent,
  interventions: Intervention[],
  solver: SolverApi,
  opts: { maxSolves?: number; timeLimitMs?: number } = {},
): Promise<OutcomeModel> {
  const t0 = Date.now();
  const max = opts.maxSolves ?? 24;
  let solves = 0;
  const feasibleSets: FeasibleSet[] = [];
  const infeasibleKeys: string[][] = [];
  const seen = new Set<string>();

  const attempt = async (cs: Concession[]): Promise<Money | null | undefined> => {
    if (solves >= max) return undefined;
    solves++;
    const next = solver.applyConcessions(world, intent, cs);
    const r = await solver.solve(next.world, next.intent, { explain: false, ...(opts.timeLimitMs ? { timeLimitMs: opts.timeLimitMs } : {}) });
    if (r.plan && (r.status === 'optimal' || r.status === 'feasible')) {
      return solver.verifyPlan(r.plan, next.world, next.intent).ok ? r.plan.total : null;
    }
    return null;
  };
  const record = (s: FeasibleSet) => {
    const k = s.keys.join('|');
    if (seen.has(k)) return;
    seen.add(k);
    feasibleSets.push(s);
  };

  const usable = interventions.filter((i) => i.unlocks && i.concessions.length > 0);
  for (const iv of usable) {
    let total = iv.totalAfter;
    if (!total) total = (await attempt(iv.concessions)) ?? intent.budget;
    record(setOf(iv.concessions, total, 'intervention', iv.id));
  }
  for (const iv of usable) {
    if (iv.concessions.length < 2) continue;
    for (const c of iv.concessions) {
      const rest = iv.concessions.filter((x) => x !== c);
      const k = rest.map(concessionKey).sort().join('|');
      if (seen.has(k)) continue;
      const r = await attempt(rest);
      if (r === undefined) break;
      if (r) record(setOf(rest, r, 'reject-probe', iv.id));
      else infeasibleKeys.push(rest.map(concessionKey).sort());
    }
  }
  for (const iv of usable) {
    for (const c of iv.concessions) {
      const half = midpoint(c);
      if (!half) continue;
      const cs = iv.concessions.map((x) => (x === c ? half : x));
      const r = await attempt(cs);
      if (r === undefined) break;
      if (r) record(setOf(cs, r, 'counter-probe', iv.id));
      else infeasibleKeys.push(cs.map(concessionKey).sort());
    }
  }
  return { feasibleSets, infeasibleKeys, solves, ms: Date.now() - t0 };
}

interface Candidate {
  key: string;
  concession: Concession;
  p: AcceptanceEstimate;
  buyer: boolean;
  actor?: Id;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SelectOptions {
  outcomes?: OutcomeModel;
  /** Answers already received: true = the supplier agreed (possibly conditionally), false = refused. */
  answers?: Map<string, boolean>;
  /** Concessions already accepted and binding; they cost no further question. */
  secured?: Set<string>;
  now?: Iso;
  idPrefix?: string;
}

export function changePhrase(c: Concession, world: World): string {
  if (c.target.kind === 'intent') {
    return c.target.field === 'deadline'
      ? `you accept delivery by ${fmtTime(String(c.to))} instead of ${fmtTime(String(c.from))}`
      : `you raise the budget from ${fmtMoney(money(world.currency, Number(c.from)))} to ${fmtMoney(money(world.currency, Number(c.to)))}`;
  }
  const offer = findOffer(world, c.target.offer);
  const who = offer ? actorName(world, offer.actor) : c.target.offer;
  const unit = world.stages.find((s) => s.id === offer?.stage)?.unit ?? 'units';
  const id = c.target.offer;
  const m = (v: number | string) => fmtMoney(money(world.currency, Number(v)));
  switch (c.target.field) {
    case 'unitPrice':
      return `${who} ${Number(c.to) > Number(c.from) ? 'raises' : 'lowers'} the unit price on ${id} from ${m(c.from)} to ${m(c.to)}`;
    case 'setupFee':
      return Number(c.to) > Number(c.from)
        ? `${who} charges ${m(Number(c.to) - Number(c.from))} for overtime, raising the setup fee on ${id} from ${m(c.from)} to ${m(c.to)}`
        : `${who} lowers the setup fee on ${id} from ${m(c.from)} to ${m(c.to)}`;
    case 'capacity':
      return `${who} raises capacity on ${id} from ${c.from} to ${c.to} ${unit}`;
    case 'minQty':
      return `${who} accepts ${c.to} ${unit} as the minimum on ${id} instead of ${c.from}`;
    case 'windowEnd':
      return `${who} keeps working on ${id} until ${fmtTime(String(c.to))} instead of ${fmtTime(String(c.from))}`;
    case 'windowStart':
      return `${who} starts ${id} at ${fmtTime(String(c.to))} instead of ${fmtTime(String(c.from))}`;
    case 'joint':
      return `${who} delivers ${id} jointly with a partner`;
  }
}

/**
 * Value-of-information question selection. Builds the outcome space of the candidate concessions,
 * scores each solver-verified feasible set by expected feasibility and buyer surplus under the
 * acceptance priors, and greedily adds the group of questions with the best gain per question until
 * the supplier query budget is spent. Within a group the least likely yes is asked first, so a refusal
 * stops the group early.
 */
export function selectQuestions(
  world: World,
  intent: Intent,
  interventions: Intervention[],
  budget: number,
  opts: SelectOptions = {},
): RankedQuestion[] {
  const answers = opts.answers ?? new Map<string, boolean>();
  const secured = opts.secured ?? new Set<string>();
  const sets: FeasibleSet[] =
    opts.outcomes?.feasibleSets ??
    interventions
      .filter((i) => i.unlocks && i.concessions.length)
      .map((i) => setOf(i.concessions, i.totalAfter ?? intent.budget, 'intervention', i.id));

  const cands = new Map<string, Candidate>();
  for (const s of sets) {
    for (const c of s.concessions) {
      const key = concessionKey(c);
      if (cands.has(key)) continue;
      const offer = c.target.kind === 'offer' ? findOffer(world, c.target.offer) : undefined;
      const cand: Candidate = { key, concession: c, p: estimateAcceptance(c, world, intent), buyer: c.target.kind === 'intent' };
      if (offer) cand.actor = offer.actor;
      cands.set(key, cand);
    }
  }
  const live = sets.filter((s) => s.keys.every((k) => answers.get(k) !== false));
  const budgetMinor = Math.max(1, intent.budget.minor);

  const prob = (k: string, mode: 'lo' | 'mid' | 'hi'): number => {
    if (secured.has(k)) return 1;
    const a = answers.get(k);
    if (a !== undefined) return a ? 1 : 0;
    return cands.get(k)?.p[mode] ?? 0;
  };

  const value = (asked: string[], mode: 'lo' | 'mid' | 'hi'): { pf: number; es: number } => {
    const covered = new Set<string>([...secured, ...asked]);
    const relevant = live.filter((s) => s.keys.every((k) => covered.has(k)));
    if (!relevant.length) return { pf: 0, es: 0 };
    const uncertain = [...new Set(relevant.flatMap((s) => s.keys))].filter((k) => {
      const p = prob(k, mode);
      return p > 0 && p < 1;
    });
    const fixedOut = new Set([...covered].filter((k) => prob(k, mode) === 0));
    const score = (yes: Set<string>) => {
      let best = -1;
      for (const s of relevant) {
        if (s.keys.every((k) => !fixedOut.has(k) && (prob(k, mode) === 1 || yes.has(k)))) {
          best = Math.max(best, Math.max(0, intent.budget.minor - s.total.minor));
        }
      }
      return best;
    };
    let pf = 0;
    let es = 0;
    if (uncertain.length <= 14) {
      for (let mask = 0; mask < 1 << uncertain.length; mask++) {
        let pr = 1;
        const yes = new Set<string>();
        uncertain.forEach((k, i) => {
          const p = prob(k, mode);
          if (mask & (1 << i)) {
            pr *= p;
            yes.add(k);
          } else pr *= 1 - p;
        });
        const b = score(yes);
        if (b >= 0) {
          pf += pr;
          es += pr * b;
        }
      }
    } else {
      const rnd = mulberry32(7);
      const n = 4096;
      for (let t = 0; t < n; t++) {
        const yes = new Set(uncertain.filter((k) => rnd() < prob(k, mode)));
        const b = score(yes);
        if (b >= 0) {
          pf += 1 / n;
          es += b / n;
        }
      }
    }
    return { pf, es };
  };

  const at = opts.now ?? world.createdAt;
  const expires = new Date(Date.parse(at) + 24 * HOUR).toISOString();
  const from = buyerId(world);
  const platform = platformId(world);
  const prefix = opts.idPrefix ?? 'q';
  const out: RankedQuestion[] = [];
  const asked: string[] = [];
  let used = 0;
  let base = { mid: value([], 'mid'), lo: value([], 'lo'), hi: value([], 'hi') };
  let groupNo = 0;

  for (;;) {
    let best:
      | { set: FeasibleSet; add: string[]; per: number; cost: number; next: typeof base }
      | undefined;
    for (const s of live) {
      const add = s.keys.filter((k) => !secured.has(k) && !asked.includes(k));
      if (!add.length) continue;
      const cost = add.filter((k) => !cands.get(k)?.buyer).length;
      if (used + cost > budget) continue;
      const trial = [...asked, ...add];
      const next = { mid: value(trial, 'mid'), lo: value(trial, 'lo'), hi: value(trial, 'hi') };
      const gain = next.mid.pf - base.mid.pf + (next.mid.es - base.mid.es) / budgetMinor;
      const per = gain / add.length;
      if (
        per > 1e-9 &&
        (!best || per > best.per + 1e-12 || (Math.abs(per - best.per) <= 1e-12 && (cost < best.cost || s.total.minor < best.set.total.minor)))
      ) {
        best = { set: s, add, per, cost, next };
      }
    }
    if (!best) break;
    groupNo++;
    const { set, add, next } = best;
    const ordered = [...add].sort((a, b) => {
      const ca = cands.get(a)!;
      const cb = cands.get(b)!;
      if (ca.buyer !== cb.buyer) return ca.buyer ? -1 : 1;
      return ca.p.mid - cb.p.mid;
    });
    const n = ordered.length;
    const group = `${prefix}g${groupNo}`;
    const ids = ordered.map((_, i) => `${prefix}${out.length + i + 1}`);
    const supplierIds = ordered.map((k, i) => (cands.get(k)!.buyer ? undefined : ids[i])).filter((x): x is string => !!x);
    const dP = next.mid.pf - base.mid.pf;
    const dS = next.mid.es - base.mid.es;
    const gainAt = (m: 'lo' | 'hi') => (next[m].pf - base[m].pf + (next[m].es - base[m].es) / budgetMinor) / n;
    const others = ordered.map((k) => cands.get(k)!).filter((c) => c.actor).map((c) => actorName(world, c.actor!));
    const headroom = money(intent.budget.currency, intent.budget.minor - set.total.minor);

    ordered.forEach((k, i) => {
      const cand = cands.get(k)!;
      const c = cand.concession;
      const id = ids[i]!;
      const partners = [...new Set(others.filter((name) => name !== (cand.actor ? actorName(world, cand.actor) : '')))];
      const tail =
        n > 1
          ? ` Together with ${n - 1} other change${n > 2 ? 's' : ''}${partners.length ? ` (${partners.join(', ')})` : ''}, this makes the order possible at ${fmtMoney(set.total)}, ${fmtMoney(headroom)} under budget. It binds only if those are also agreed.`
          : ` That alone makes the order possible at ${fmtMoney(set.total)}, ${fmtMoney(headroom)} under budget.`;
      const cost = c.target.kind === 'offer' ? ` Estimated cost to them: ${fmtMoney(c.estimate)}.` : '';
      const benefit = `If ${changePhrase(c, world)}:${tail}${cost} Chance of yes: ${Math.round(cand.p.lo * 100)}–${Math.round(cand.p.hi * 100)}%.`;
      let message: QuestionMessage;
      if (cand.buyer) {
        message = { type: 'AskPreference', id, from: platform, to: from, question: c, benefit, at };
      } else if (intent.authority.mayNegotiate) {
        const cond = supplierIds.filter((x) => x !== id);
        message = cond.length
          ? { type: 'Propose', id, from, to: cand.actor!, concession: c, conditional: cond, expires, at }
          : { type: 'Propose', id, from, to: cand.actor!, concession: c, expires, at };
      } else {
        message = { type: 'AskPreference', id, from, to: cand.actor!, question: c, benefit, at };
      }
      out.push({
        message,
        voi: round4(best!.per),
        voiRange: { lo: round4(Math.min(gainAt('lo'), gainAt('hi'))), hi: round4(Math.max(gainAt('lo'), gainAt('hi'))) },
        pAccept: cand.p,
        feasibilityGain: round4(dP / n),
        surplusGain: money(intent.budget.currency, dS / n),
        group,
        groupSize: n,
        intervention: set.intervention,
        concession: c,
        buyerQuestion: cand.buyer,
        benefit,
      });
    });
    asked.push(...add);
    used += best.cost;
    base = next;
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
