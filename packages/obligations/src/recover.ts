import type {
  Agreement,
  Allocation,
  Concession,
  ConstraintKind,
  ConstraintRef,
  Disruption,
  Id,
  InfeasibleCore,
  Intent,
  Iso,
  Money,
  Obligation,
  Offer,
  PaymentIntent,
  Plan,
  Recovery,
  SolveReport,
  Verification,
  World,
} from '@framvera/contracts';
import { BINDING, BUYER, LIVE_OBLIGATION, accept, amend, commitAgreement, moveObligation, supersede, type AcceptanceInput, type AmendmentSpec } from './agreement.ts';
import { defaultNotBefore, impactOf, type Impact } from './disrupt.ts';
import { allocationCost, coalitionMembers, earliestSlot, exclusivePairs, mergeJoint, offerMap, readyAt, required, sameTerms, toAllocation, topoStages, workMs } from './model.ts';
import { capturedMinor, refundable } from './payment.ts';
import { HOUR, MINUTE, ObligationError, hours, iso, money, ms } from './util.ts';

export interface SolverLike {
  solve(world: World, intent: Intent, opts?: { fixed?: Allocation[]; baseline?: Allocation[]; objective?: 'cost' | 'repair'; timeLimitMs?: number }): Promise<SolveReport>;
  verifyPlan?(plan: Plan, world: World, intent: Intent, opts?: { fixed?: Allocation[] }): Verification;
}

export interface RecoverOptions {
  /** Defaults to @framvera/solver when it is available. Pass null to use only the built-in local repair. */
  solver?: SolverLike | null;
  payments?: PaymentIntent[];
  reservedElsewhere?: Map<Id, number> | Record<Id, number>;
  notBefore?: Iso;
  timeLimitMs?: number;
  buyer?: Id;
}

export type ReasonCode =
  | 'accepted-term'
  | 'failed-term'
  | 'withdrawn'
  | 'double-booking'
  | 'capacity'
  | 'demand'
  | 'min-qty'
  | 'window'
  | 'precedence'
  | 'deadline'
  | 'budget'
  | 'price'
  | 'validity'
  | 'verifier';

export interface Reason {
  code: ReasonCode;
  text: string;
  constraint: ConstraintRef;
}

export type CandidateSource = 'original' | 'solver-repair' | 'solver-scratch' | 'local-repair';

export interface Candidate {
  description: string;
  source: CandidateSource;
  allocations: Allocation[];
  escalated?: boolean;
}

export interface Evaluated extends Candidate {
  reasons: Reason[];
  kept: Id[];
  amended: { replaces: Id; allocation: Allocation }[];
  cancelled: Id[];
  added: Allocation[];
  changed: number;
  total: Money;
  extraCost: Money;
  slipHours: number;
  readyAt: Iso | null;
}

export interface ProposedRefund {
  payment: Id;
  operationKey: string;
  amount: Money;
  reason: string;
}

export interface RecoveryResult extends Recovery {
  plan?: Plan;
  replacements: { replaces: Id; allocation: Allocation }[];
  candidates: { description: string; source: CandidateSource; permissible: boolean; changed: number; extraCostMinor: number; slipHours: number; reasons: string[] }[];
  objective: string;
  impact: Pick<Impact, 'graph' | 'endangeredPayments' | 'readyBound'> & { failed: Id[]; mustChange: Id[]; atRisk: Id[] };
  amendment?: Agreement;
  payments: { refunds: ProposedRefund[]; voids: { payment: Id; reason: string }[]; reconcile: { payment: Id; reason: string }[]; orders: PaymentIntent[] };
  /** What happens if nothing is changed: the original plan played forward in the disrupted world. */
  counterfactual: Counterfactual;
  world: World;
}

export interface Counterfactual {
  readyAt: Iso | null;
  shortfall: { stage: string; units: number }[];
  extraCostMinor: number;
  lateHours: number;
  missesDeadline: boolean;
  text: string;
}

const KIND: Record<ReasonCode, ConstraintKind> = {
  'accepted-term': 'exclusive-resource',
  'failed-term': 'validity',
  withdrawn: 'validity',
  'double-booking': 'exclusive-resource',
  capacity: 'capacity',
  demand: 'demand',
  'min-qty': 'min-qty',
  window: 'window',
  precedence: 'precedence',
  deadline: 'deadline',
  budget: 'budget',
  price: 'validity',
  validity: 'validity',
  verifier: 'validity',
};

const OBJECTIVE = 'Lexicographic: fewest changed obligations, then least extra cost, then least slip.';

let solverModule: Promise<SolverLike | null> | null = null;
async function defaultSolver(): Promise<SolverLike | null> {
  solverModule ??= import('@framvera/solver')
    .then((m: Record<string, unknown>) => (typeof m.solve === 'function' ? (m as unknown as SolverLike) : null))
    .catch(() => null);
  const s = await solverModule;
  if (!s) solverModule = null;
  return s;
}

interface Ctx {
  agreement: Agreement;
  world: World;
  intent: Intent;
  live: Obligation[];
  failed: Set<Id>;
  mustChange: Set<Id>;
  atRisk: Set<Id>;
  removed: Set<Id>;
  inactive: Set<Id>;
  reserved: Map<Id, number>;
  notBefore?: number;
  quantity: number;
  originalTotal: number;
  originalReady: number;
  names: Map<Id, string>;
  disruption: Disruption;
  verify?: SolverLike['verifyPlan'];
}

const toMap = (r?: Map<Id, number> | Record<Id, number>) => (r instanceof Map ? r : new Map(Object.entries(r ?? {})));

function describe(ctx: Ctx, o: { actor: Id; stage: string; qty: number }): string {
  return `${ctx.names.get(o.actor) ?? o.actor} (${o.stage}, ${o.qty} units)`;
}

function brokenText(ctx: Ctx, o: Obligation): string {
  const who = ctx.names.get(o.actor) ?? o.actor;
  const offer = ctx.world.offers.find((x) => x.id === o.offer);
  switch (ctx.disruption.kind) {
    case 'capacity-drop':
      return `Keeps ${o.qty} units at ${who}, which can now deliver only ${offer?.capacity ?? 0}.`;
    case 'delay':
      return `Keeps the agreed delivery time at ${who}, which the delay makes impossible.`;
    case 'price-change':
      return `Keeps ${who} at the accepted price, which it no longer honours.`;
    case 'claim-overturned':
      return `Relies on ${who}, whose supporting claim was overturned.`;
    default:
      return `Relies on ${who}, which can no longer deliver.`;
  }
}

function locked(ctx: Ctx, escalated: boolean): Obligation[] {
  return ctx.live.filter((o) => !ctx.failed.has(o.id) && !ctx.mustChange.has(o.id) && !(escalated && ctx.atRisk.has(o.id)));
}

/** Independent arithmetic check of a candidate against accepted terms and the disrupted world. */
export function evaluate(c: Candidate, ctx: Ctx): Evaluated {
  const reasons: Reason[] = [];
  const add = (code: ReasonCode, subject: Id | undefined, text: string) =>
    reasons.push({ code, text, constraint: { id: `${code}${subject ? `:${subject}` : ''}`, kind: KIND[code], subject, text } });
  const offers = offerMap(ctx.world);
  const currency = ctx.intent.budget.currency;

  const pool = c.allocations.map((a, i) => ({ a, i }));
  const used = new Set<number>();
  const kept: Id[] = [];
  for (const o of ctx.live) {
    const hit = pool.find(({ a, i }) => !used.has(i) && sameTerms(a, o));
    if (hit) {
      used.add(hit.i);
      kept.push(o.id);
    }
  }
  const amended: Evaluated['amended'] = [];
  const unkept = ctx.live.filter((o) => !kept.includes(o.id));
  for (const o of unkept) {
    const hit = pool.find(({ a, i }) => !used.has(i) && a.offer === o.offer && a.stage === o.stage);
    if (hit) {
      used.add(hit.i);
      amended.push({ replaces: o.id, allocation: hit.a });
    }
  }
  const added = pool.filter(({ i }) => !used.has(i)).map(({ a }) => a);
  const cancelled = unkept.filter((o) => !amended.some((m) => m.replaces === o.id)).map((o) => o.id);
  const fresh = new Set<Allocation>([...added, ...amended.map((m) => m.allocation)]);

  for (const id of kept) if (ctx.failed.has(id)) add('failed-term', id, brokenText(ctx, ctx.live.find((o) => o.id === id)!));
  const lockedIds = new Set(locked(ctx, !!c.escalated).map((o) => o.id));
  for (const m of amended) {
    if (!lockedIds.has(m.replaces)) continue;
    const o = ctx.live.find((x) => x.id === m.replaces)!;
    add('accepted-term', m.replaces, `Changes the accepted obligation of ${describe(ctx, o)}, which the disruption did not affect.`);
  }
  for (const id of cancelled) {
    if (!lockedIds.has(id)) continue;
    add('accepted-term', id, `Cancels the accepted obligation of ${describe(ctx, ctx.live.find((x) => x.id === id)!)}, which the disruption did not affect.`);
  }

  const usage = new Map<Id, number>();
  for (const a of c.allocations) {
    usage.set(a.offer, (usage.get(a.offer) ?? 0) + a.qty);
    if (a.cost.currency !== currency) add('budget', a.offer, `Allocation on ${a.offer} is priced in ${a.cost.currency}, not ${currency}.`);
    const offer = offers.get(a.offer);
    if (!offer || ctx.removed.has(a.offer) || ctx.inactive.has(a.actor)) {
      add('withdrawn', a.offer, `Uses ${ctx.names.get(a.actor) ?? a.actor}, whose offer is no longer available.`);
      continue;
    }
    if (!fresh.has(a)) continue;
    const work = workMs(offer, a.qty);
    if (a.qty < offer.minQty) add('min-qty', a.offer, `Orders ${a.qty} from ${ctx.names.get(a.actor) ?? a.actor}, below the minimum of ${offer.minQty}.`);
    if (ms(a.start) < ms(offer.window.start) || ms(a.start) + work > ms(offer.window.end) + MINUTE)
      add('window', a.offer, `Work at ${ctx.names.get(a.actor) ?? a.actor} falls outside its available window.`);
    if (ms(a.finish) + MINUTE < ms(a.start) + work + offer.handoffHours * HOUR)
      add('window', a.offer, `Output from ${ctx.names.get(a.actor) ?? a.actor} is promised earlier than its production and handoff allow.`);
    if (ctx.notBefore !== undefined && ms(a.start) + MINUTE < ctx.notBefore) add('window', a.offer, `New work at ${ctx.names.get(a.actor) ?? a.actor} would start before the disruption was known.`);
    if (ctx.notBefore !== undefined && ms(offer.validUntil) < ctx.notBefore) add('validity', a.offer, `The offer from ${ctx.names.get(a.actor) ?? a.actor} has expired.`);
    if (a.cost.minor < allocationCost(offer, a.qty).minor) add('price', a.offer, `Prices ${ctx.names.get(a.actor) ?? a.actor} below its current terms.`);
  }
  for (const [offerId, qty] of usage) {
    const offer = offers.get(offerId);
    if (!offer) continue;
    const elsewhere = ctx.reserved.get(offerId) ?? 0;
    if (qty + elsewhere > offer.capacity) {
      if (elsewhere > 0 && qty <= offer.capacity) add('double-booking', offerId, `Books ${qty} units on ${offerId}, but ${elsewhere} of its ${offer.capacity} are already promised to another agreement.`);
      else add('capacity', offerId, `Books ${qty + elsewhere} units on ${offerId}, above its capacity of ${offer.capacity}.`);
    }
  }
  for (const [joint, member] of exclusivePairs(usage.keys())) {
    add('double-booking', `${joint}&${member}`, `Books ${member} on its own while it is also committed inside the joint offer ${joint}.`);
  }
  for (const stage of ctx.world.stages) {
    const need = required(ctx.world, stage, ctx.quantity);
    const have = c.allocations.filter((a) => a.stage === stage.id).reduce((s, a) => s + a.qty, 0);
    if (have < need) add('demand', stage.id, `Produces ${have} of the ${need} ${stage.unit} needed for ${stage.name}.`);
    for (const a of c.allocations.filter((x) => x.stage === stage.id)) {
      for (const b of c.allocations.filter((x) => stage.after.includes(x.stage))) {
        if (ms(a.start) + MINUTE < ms(b.finish)) {
          add('precedence', `${a.offer}<${b.offer}`, `${ctx.names.get(a.actor) ?? a.actor} would start ${stage.name} before ${ctx.names.get(b.actor) ?? b.actor} delivers its input.`);
          break;
        }
      }
    }
  }
  const total = c.allocations.reduce((s, a) => s + (a.cost.currency === currency ? a.cost.minor : 0), 0);
  const ready = c.allocations.length ? readyAt(ctx.world, c.allocations) : -Infinity;
  if (Number.isFinite(ready) && ready > ms(ctx.intent.deadline) + MINUTE) add('deadline', 'deadline', `Ready ${iso(ready)}, after the deadline ${ctx.intent.deadline}.`);
  if (total > ctx.intent.budget.minor) add('budget', 'budget', `Costs ${total}, above the budget of ${ctx.intent.budget.minor}.`);
  if (ctx.verify && c.allocations.length) {
    try {
      const fixed = locked(ctx, !!c.escalated).map(toAllocation);
      const v = ctx.verify(planOf(c.allocations, ctx, 'verify'), ctx.world, solverIntent(ctx), { fixed });
      for (const chk of v.checks) if (!chk.ok && !reasons.some((r) => r.text === chk.text)) add('verifier', chk.id, chk.text);
    } catch {
      /* the verifier is advisory here; the arithmetic above is authoritative for commitments */
    }
  }
  return {
    ...c,
    reasons: dedupe(reasons),
    kept,
    amended,
    cancelled,
    added,
    changed: amended.length + cancelled.length + added.length,
    total: money(currency, total),
    extraCost: money(currency, total - ctx.originalTotal),
    slipHours: Number.isFinite(ready) && Number.isFinite(ctx.originalReady) ? Math.max(0, hours(ctx.originalReady, ready)) : 0,
    readyAt: Number.isFinite(ready) ? iso(ready) : null,
  };
}

function dedupe(rs: Reason[]): Reason[] {
  const seen = new Set<string>();
  return rs.filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
}

function planOf(allocations: Allocation[], ctx: Ctx, tag: string): Plan {
  const total = allocations.reduce((s, a) => s + a.cost.minor, 0);
  const r = readyAt(ctx.world, allocations);
  return {
    id: `${ctx.agreement.plan}~${tag}`,
    worldVersion: ctx.world.version,
    intent: ctx.intent.id,
    allocations,
    total: money(ctx.intent.budget.currency, total),
    readyAt: Number.isFinite(r) ? iso(r) : ctx.intent.deadline,
    objective: OBJECTIVE,
  };
}

const key = (e: Evaluated): [number, number, number, string] => [e.changed, e.extraCost.minor, e.slipHours, e.description];
function better(a: Evaluated, b: Evaluated): number {
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
  return ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0;
}

interface Fill {
  offer: Offer;
  qty: number;
}

/** Built-in repair: keep locked obligations, shift flexible ones only when inputs arrive late, refill shortfalls. */
function localCandidates(ctx: Ctx, escalated: boolean): Candidate[] {
  const lockedSet = new Set(locked(ctx, escalated).map((o) => o.id));
  const flexible = ctx.live.filter((o) => !lockedSet.has(o.id) && !ctx.failed.has(o.id));
  const keep = ctx.live.filter((o) => !ctx.failed.has(o.id));
  const usedOn = new Map<Id, number>();
  for (const o of keep) usedOn.set(o.offer, (usedOn.get(o.offer) ?? 0) + o.qty);
  const blocked = new Set<Id>();
  for (const id of usedOn.keys()) {
    for (const m of coalitionMembers(id) ?? []) blocked.add(m);
    for (const o of ctx.world.offers) if ((coalitionMembers(o.id) ?? []).includes(id)) blocked.add(o.id);
  }
  const stages = topoStages(ctx.world.stages);
  const options = new Map<string, Fill[][]>();
  for (const stage of stages) {
    const need = required(ctx.world, stage, ctx.quantity) - keep.filter((o) => o.stage === stage.id).reduce((s, o) => s + o.qty, 0);
    if (need <= 0) continue;
    const sources = ctx.world.offers
      .filter((o) => o.stage === stage.id && !ctx.inactive.has(o.actor) && !ctx.removed.has(o.id) && !blocked.has(o.id))
      .filter((o) => ctx.notBefore === undefined || ms(o.validUntil) >= ctx.notBefore)
      .map((offer) => ({ offer, spare: offer.capacity - (usedOn.get(offer.id) ?? 0) - (ctx.reserved.get(offer.id) ?? 0) }))
      .filter((s) => s.spare > 0);
    const fills: Fill[][] = [];
    for (const s of sources) {
      const q = Math.max(need, s.offer.minQty);
      if (q <= s.spare) fills.push([{ offer: s.offer, qty: q }]);
    }
    for (const a of sources) {
      for (const b of sources) {
        if (a === b) continue;
        const splits = new Set<number>();
        splits.add(Math.min(a.spare, need - Math.max(1, b.offer.minQty)));
        splits.add(Math.round((need * a.offer.ratePerHour) / (a.offer.ratePerHour + b.offer.ratePerHour)));
        for (const qa of splits) {
          const qb = need - qa;
          if (qa < Math.max(1, a.offer.minQty) || qa > a.spare || qb < Math.max(1, b.offer.minQty) || qb > b.spare) continue;
          fills.push([
            { offer: a.offer, qty: qa },
            { offer: b.offer, qty: qb },
          ]);
        }
      }
    }
    const cost = (f: Fill[]) => f.reduce((s, x) => s + allocationCost(x.offer, x.qty).minor, 0);
    fills.sort((x, y) => x.length - y.length || cost(x) - cost(y));
    options.set(stage.id, fills.slice(0, 10));
  }
  const affectedStages = [...options.keys()];
  if (affectedStages.some((s) => options.get(s)!.length === 0)) return [];
  let combos: Fill[][][] = [[]];
  for (const s of affectedStages) {
    const next: Fill[][][] = [];
    for (const c of combos) for (const f of options.get(s)!) if (next.length < 400) next.push([...c, f]);
    combos = next;
  }
  const out: Candidate[] = [];
  for (const combo of combos) {
    const byStage = new Map(affectedStages.map((s, i) => [s, combo[i]!]));
    const allocs: Allocation[] = [];
    let ok = true;
    for (const stage of stages) {
      const preds = allocs.filter((a) => stage.after.includes(a.stage));
      const predReady = Math.max(-8.64e15, ...preds.map((a) => ms(a.finish)));
      for (const o of keep.filter((x) => x.stage === stage.id)) {
        const offer = ctx.world.offers.find((x) => x.id === o.offer);
        if (flexible.includes(o) && offer && ms(o.start) + MINUTE < predReady) {
          const slot = earliestSlot(offer, o.qty, Math.max(predReady, ctx.notBefore ?? -8.64e15));
          if (slot) {
            allocs.push({ ...toAllocation(o), start: iso(slot.start), finish: iso(slot.finish) });
            continue;
          }
        }
        allocs.push(toAllocation(o));
      }
      for (const f of byStage.get(stage.id) ?? []) {
        const slot = earliestSlot(f.offer, f.qty, Math.max(predReady, ctx.notBefore ?? -8.64e15));
        if (!slot) {
          ok = false;
          break;
        }
        allocs.push({ offer: f.offer.id, actor: f.offer.actor, stage: stage.id, qty: f.qty, start: iso(slot.start), finish: iso(slot.finish), cost: allocationCost(f.offer, f.qty) });
      }
      if (!ok) break;
    }
    if (!ok) continue;
    const names = combo.flat().map((f) => `${ctx.names.get(f.offer.actor) ?? f.offer.actor} ${f.qty}`);
    out.push({ description: `Replace with ${names.join(' + ')}`, source: 'local-repair', allocations: allocs, escalated });
  }
  return out;
}

/** New work cannot start before the disruption is known. */
function solverIntent(ctx: Ctx): Intent {
  if (ctx.notBefore === undefined || ctx.notBefore <= ms(ctx.intent.provenance.observedAt)) return ctx.intent;
  return { ...ctx.intent, provenance: { ...ctx.intent.provenance, observedAt: iso(ctx.notBefore) } };
}

function solverWorld(ctx: Ctx): World {
  return {
    ...ctx.world,
    offers: ctx.world.offers
      .filter((o) => !ctx.inactive.has(o.actor))
      .map((o) => ({ ...o, capacity: Math.max(0, o.capacity - (ctx.reserved.get(o.id) ?? 0)) })),
  };
}

async function solverCandidates(ctx: Ctx, solver: SolverLike, escalated: boolean, timeLimitMs?: number): Promise<{ cands: Candidate[]; repairReport?: SolveReport }> {
  const cands: Candidate[] = [];
  const w = solverWorld(ctx);
  const fixed = locked(ctx, escalated).map(toAllocation);
  const baseline = ctx.live.filter((o) => !ctx.removed.has(o.offer)).map(toAllocation);
  const intent = solverIntent(ctx);
  let repairReport: SolveReport | undefined;
  try {
    repairReport = await solver.solve(w, intent, { fixed, baseline, objective: 'repair', timeLimitMs });
    if (repairReport.plan)
      cands.push({
        description: escalated ? 'Re-plan around the failure, also moving dependent obligations' : 'Re-plan around the failure, keeping every unaffected obligation',
        source: 'solver-repair',
        allocations: repairReport.plan.allocations,
        escalated,
      });
  } catch {
    repairReport = undefined;
  }
  if (!escalated) {
    try {
      const scratch = await solver.solve(w, intent, { objective: 'cost', timeLimitMs });
      if (scratch.plan) cands.push({ description: 'Cheapest new plan from scratch', source: 'solver-scratch', allocations: scratch.plan.allocations });
    } catch {
      /* no scratch candidate */
    }
  }
  return { cands, repairReport };
}

const signature = (c: Candidate) =>
  c.allocations
    .map((a) => `${a.offer}|${a.qty}|${ms(a.start)}|${ms(a.finish)}|${a.cost.minor}`)
    .sort()
    .join(';');

/**
 * Minimal-change recovery. Unaffected accepted obligations are locked; candidates from the solver (repair with
 * fixed allocations, and the cheapest plan from scratch) and from the built-in local repair are each checked
 * independently against accepted terms, double-booking and the disrupted world, then ranked lexicographically.
 */
export async function recover(agreement: Agreement, world: World, intent: Intent, d: Disruption, opts: RecoverOptions = {}): Promise<RecoveryResult> {
  const { obligations, groups } = mergeJoint(agreement.obligations, world);
  if (!groups.size) return recoverJobs(agreement, world, intent, d, opts);
  // Members of a joint job are planned as one job, then every member's obligation follows the job's fate.
  const r = await recoverJobs({ ...agreement, obligations }, world, intent, d, opts);
  const expand = (ids: Id[]) => ids.flatMap((id) => groups.get(id) ?? [id]);
  const others = (id: Id) => (groups.get(id) ?? [id]).slice(1);
  const kept = expand(r.kept);
  const cancelled = [...expand(r.cancelled), ...r.amended.flatMap(others)];
  const impact = { ...r.impact, failed: expand(r.impact.failed), mustChange: expand(r.impact.mustChange), atRisk: expand(r.impact.atRisk) };
  if (!r.feasible) return { ...r, impact, payments: paymentActions(agreement, opts.payments ?? [], impact.failed, [], [], r.id, intent) };
  const spec: AmendmentSpec = {
    keep: kept,
    replace: r.replacements.map((m) => ({ replaces: m.replaces, obligation: obligationFields(m.allocation) })),
    add: r.added.map(obligationFields),
  };
  const amendment = r.amendment ? amend(agreement, spec, opts.buyer ?? BUYER, r.world) : undefined;
  return { ...r, kept, cancelled, impact, amendment, payments: paymentActions(agreement, opts.payments ?? [], cancelled, r.replacements, r.added, r.id, intent, amendment) };
}

async function recoverJobs(agreement: Agreement, world: World, intent: Intent, d: Disruption, opts: RecoverOptions): Promise<RecoveryResult> {
  const reserved = toMap(opts.reservedElsewhere);
  const live = agreement.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));
  const notBefore = opts.notBefore ? ms(opts.notBefore) : defaultNotBefore(agreement, d);
  const impact = impactOf(agreement, world, d, { payments: opts.payments, reservedElsewhere: reserved, notBefore });
  const solver = opts.solver === undefined ? await defaultSolver() : opts.solver;
  const w2 = impact.world;
  const ctx: Ctx = {
    agreement,
    world: w2,
    intent,
    live,
    failed: new Set(impact.failed.map((o) => o.id)),
    mustChange: new Set(impact.mustChange.map((o) => o.id)),
    atRisk: new Set(impact.atRisk.map((o) => o.id)),
    removed: new Set(impact.removedOffers),
    inactive: new Set(w2.actors.filter((a) => !a.active).map((a) => a.id)),
    reserved,
    notBefore,
    quantity: intent.quantity,
    originalTotal: live.reduce((s, o) => s + o.amount.minor, 0),
    originalReady: readyAt(w2, live.map(toAllocation)),
    names: new Map(world.actors.map((a) => [a.id, a.name])),
    disruption: d,
    verify: solver?.verifyPlan?.bind(solver),
  };
  const recId = `rec:${d.id}:${agreement.id}:v${agreement.version}`;

  const evaluated: Evaluated[] = [];
  const seen = new Set<string>();
  const consider = (c: Candidate) => {
    const sig = `${signature(c)}#${c.escalated ? 1 : 0}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    evaluated.push(evaluate(c, ctx));
  };

  consider({ description: 'Keep the original plan unchanged', source: 'original', allocations: live.map(toAllocation) });
  let repairReport: SolveReport | undefined;
  const nothingFailed = ctx.failed.size === 0 && ctx.mustChange.size === 0;
  for (const escalated of nothingFailed ? [false] : [false, true]) {
    if (escalated && ctx.atRisk.size === 0) break;
    if (escalated && evaluated.some((e) => e.reasons.length === 0)) break;
    if (solver) {
      const r = await solverCandidates(ctx, solver, escalated, opts.timeLimitMs ?? 5000);
      repairReport ??= r.repairReport;
      r.cands.forEach(consider);
    }
    localCandidates(ctx, escalated).forEach(consider);
  }

  const permissible = evaluated.filter((e) => e.reasons.length === 0).sort(better);
  const best = permissible[0];
  const rejected = evaluated
    .filter((e) => e.reasons.length > 0)
    .sort((a, b) => sourceRank(a) - sourceRank(b) || a.reasons.length - b.reasons.length || better(a, b))
    .filter((e, i, arr) => e.source !== 'local-repair' || arr.filter((x, j) => j < i && x.source === 'local-repair').length < 2)
    .map((e) => ({ description: e.description, reason: e.reasons.map((r) => r.text).join(' ') }));

  const summaryOf = (e: Evaluated) => ({
    description: e.description,
    source: e.source,
    permissible: e.reasons.length === 0,
    changed: e.changed,
    extraCostMinor: e.extraCost.minor,
    slipHours: e.slipHours,
    reasons: e.reasons.map((r) => r.text),
  });
  const currency = intent.budget.currency;
  const impactView = {
    graph: impact.graph,
    endangeredPayments: impact.endangeredPayments,
    readyBound: impact.readyBound,
    failed: [...ctx.failed],
    mustChange: [...ctx.mustChange],
    atRisk: [...ctx.atRisk],
  };

  if (!best) {
    const near = evaluated.filter((e) => e.source !== 'original' && e.source !== 'solver-scratch').sort((a, b) => a.reasons.length - b.reasons.length || better(a, b))[0];
    const core = coreFrom(repairReport, near, ctx);
    return {
      id: recId,
      disruption: d.id,
      feasible: false,
      kept: live.filter((o) => !ctx.failed.has(o.id) && !ctx.mustChange.has(o.id)).map((o) => o.id),
      amended: [],
      cancelled: [],
      added: [],
      extraCost: money(currency, 0),
      slipHours: 0,
      rejected,
      core,
      concessionsNeeded: concessionsFrom(evaluated, ctx, recId),
      replacements: [],
      candidates: evaluated.map(summaryOf),
      objective: OBJECTIVE,
      impact: impactView,
      payments: paymentActions(agreement, opts.payments ?? [], [...ctx.failed], [], [], recId, intent),
      counterfactual: counterfactualOf(ctx),
      world: w2,
    };
  }

  const plan = planOf(best.allocations, ctx, recId);
  const spec: AmendmentSpec = {
    keep: best.kept,
    replace: best.amended.map((m) => ({ replaces: m.replaces, obligation: obligationFields(m.allocation) })),
    add: best.added.map(obligationFields),
  };
  const amendment = BINDING.includes(agreement.state) && best.changed > 0 ? amend(agreement, spec, opts.buyer ?? BUYER, w2) : undefined;
  return {
    id: recId,
    disruption: d.id,
    feasible: true,
    kept: best.kept,
    amended: best.amended.map((m) => m.replaces),
    cancelled: best.cancelled,
    added: best.added,
    extraCost: best.extraCost,
    slipHours: best.slipHours,
    rejected,
    replacements: best.amended,
    plan,
    candidates: evaluated.map(summaryOf),
    objective: `${OBJECTIVE} Best of ${permissible.length} permissible among ${evaluated.length} evaluated candidates.`,
    impact: impactView,
    amendment,
    payments: paymentActions(agreement, opts.payments ?? [], best.cancelled, best.amended, best.added, recId, intent, amendment),
    counterfactual: counterfactualOf(ctx),
    world: w2,
  };
}

const sourceRank = (e: Evaluated) => ({ 'solver-scratch': 0, original: 1, 'solver-repair': 2, 'local-repair': 3 })[e.source];

function obligationFields(a: Allocation): AmendmentSpec['add'][number] {
  return { actor: a.actor, offer: a.offer, stage: a.stage, qty: a.qty, start: a.start, due: a.finish, amount: a.cost };
}

function coreFrom(report: SolveReport | undefined, near: Evaluated | undefined, ctx: Ctx): InfeasibleCore {
  if (report?.status === 'infeasible' && report.core && report.core.constraints.length > 0) return report.core;
  const lockedRefs: ConstraintRef[] = locked(ctx, false).map((o) => ({
    id: `accepted:${o.id}`,
    kind: 'exclusive-resource',
    subject: o.id,
    text: `The accepted obligation of ${describe(ctx, o)} stays as agreed.`,
  }));
  const refs = near ? near.reasons.map((r) => r.constraint) : shortages(ctx);
  const seen = new Set<string>();
  const constraints = [...refs, ...lockedRefs].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  return {
    constraints,
    method: 'deletion-filter',
    minimal: false,
    proven: false,
    summary: near
      ? `No evaluated recovery keeps every accepted obligation: ${near.reasons[0]?.text ?? 'constraints conflict'}`
      : (refs[0]?.text ?? 'No replacement capacity exists for the failed obligations.'),
  };
}

/** Stages whose remaining offers cannot supply what the locked obligations leave uncovered. */
function shortages(ctx: Ctx): ConstraintRef[] {
  const keep = locked(ctx, false);
  const out: ConstraintRef[] = [];
  for (const stage of ctx.world.stages) {
    const need = required(ctx.world, stage, ctx.quantity) - keep.filter((o) => o.stage === stage.id).reduce((s, o) => s + o.qty, 0);
    if (need <= 0) continue;
    const used = new Map<Id, number>();
    for (const o of keep) used.set(o.offer, (used.get(o.offer) ?? 0) + o.qty);
    const spare = ctx.world.offers
      .filter((o) => o.stage === stage.id && !ctx.inactive.has(o.actor) && !ctx.removed.has(o.id))
      .reduce((s, o) => s + Math.max(0, o.capacity - (used.get(o.id) ?? 0) - (ctx.reserved.get(o.id) ?? 0)), 0);
    if (spare < need) {
      const text = `${stage.name} needs ${need} more ${stage.unit}, but the remaining offers can supply only ${spare}.`;
      out.push({ id: `demand:${stage.id}`, kind: 'demand', subject: stage.id, text });
    }
  }
  return out;
}

/** Intent changes that would make an evaluated recovery permissible, fewest first, then smallest. */
function concessionsFrom(evaluated: Evaluated[], ctx: Ctx, recId: string): Concession[] {
  const soft = evaluated.filter((e) => e.source !== 'original' && e.source !== 'solver-scratch' && e.reasons.length > 0 && e.reasons.every((r) => r.code === 'deadline' || r.code === 'budget'));
  if (!soft.length) return [];
  const needs = (e: Evaluated) => {
    const late = e.reasons.some((r) => r.code === 'deadline') && e.readyAt ? Math.ceil((ms(e.readyAt) - ms(ctx.intent.deadline)) / HOUR) : 0;
    const over = e.reasons.some((r) => r.code === 'budget') ? e.total.minor - ctx.intent.budget.minor : 0;
    return { late, over, count: (late > 0 ? 1 : 0) + (over > 0 ? 1 : 0) };
  };
  soft.sort((a, b) => {
    const na = needs(a);
    const nb = needs(b);
    return na.count - nb.count || na.over - nb.over || na.late - nb.late || better(a, b);
  });
  const pick = soft[0]!;
  const n = needs(pick);
  const out: Concession[] = [];
  if (n.late > 0)
    out.push({
      id: `${recId}:deadline`,
      target: { kind: 'intent', field: 'deadline' },
      from: ctx.intent.deadline,
      to: iso(ms(ctx.intent.deadline) + n.late * HOUR),
      estimate: money(ctx.intent.budget.currency, 0),
      rationale: `Moving the deadline by ${n.late} h lets "${pick.description}" deliver while every accepted obligation stays as agreed.`,
    });
  if (n.over > 0)
    out.push({
      id: `${recId}:budget`,
      target: { kind: 'intent', field: 'budget' },
      from: ctx.intent.budget.minor,
      to: pick.total.minor,
      estimate: money(ctx.intent.budget.currency, n.over),
      rationale: `Raising the budget by ${n.over} minor units covers "${pick.description}" while every accepted obligation stays as agreed.`,
    });
  return out;
}

const CAPTURED_LIKE = ['CAPTURE_COMPLETED', 'REFUND_COMPLETED', 'REFUND_DENIED'];
const VOIDABLE = ['PAYMENT_PROPOSED', 'ORDER_CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'];
const UNSETTLED = ['CAPTURE_PENDING', 'CAPTURE_UNKNOWN', 'REFUND_PENDING', 'REFUND_UNKNOWN'];

/** Payment consequences of a recovery, as proposals only. Nothing here talks to a payment provider. */
function paymentActions(
  agreement: Agreement,
  payments: PaymentIntent[],
  cancelled: Id[],
  amended: { replaces: Id; allocation: Allocation }[],
  added: Allocation[],
  recId: string,
  intent: Intent,
  amendment?: Agreement,
): RecoveryResult['payments'] {
  const refunds: ProposedRefund[] = [];
  const voids: { payment: Id; reason: string }[] = [];
  const reconcile: { payment: Id; reason: string }[] = [];
  const byId = new Map(agreement.obligations.map((o) => [o.id, o]));
  const reduced = (id: Id): number => {
    const o = byId.get(id);
    if (!o) return 0;
    if (cancelled.includes(id)) return o.amount.minor;
    const m = amended.find((x) => x.replaces === id);
    return m ? Math.max(0, o.amount.minor - m.allocation.cost.minor) : 0;
  };
  const voidedPayees = new Set<Id>();
  for (const p of payments) {
    if (p.agreement !== agreement.id) continue;
    const drop = p.obligations.reduce((s, id) => s + reduced(id), 0);
    const touched = p.obligations.some((id) => cancelled.includes(id) || amended.some((m) => m.replaces === id));
    if (!touched) continue;
    if (UNSETTLED.includes(p.state)) {
      reconcile.push({ payment: p.id, reason: 'Outcome is not yet confirmed by PayPal; retrieve it before any refund or new order.' });
    } else if (CAPTURED_LIKE.includes(p.state) && capturedMinor(p) > 0) {
      if (drop <= 0) continue;
      const share = p.amount.minor > 0 ? Math.round((p.charged.minor * drop) / p.amount.minor) : 0;
      const amount = Math.min(share, refundable(p));
      if (amount > 0)
        refunds.push({
          payment: p.id,
          operationKey: `refund:${recId}:${p.id}`,
          amount: { currency: p.charged.currency, minor: amount },
          reason: `Covers obligations that the recovery cancels or reduces (${p.obligations.filter((id) => reduced(id) > 0).join(', ')}).`,
        });
    } else if (VOIDABLE.includes(p.state)) {
      voids.push({ payment: p.id, reason: 'Not captured; void it and pay the revised obligations through a new order with fresh approval.' });
      voidedPayees.add(p.payee);
    }
  }
  const orders: PaymentIntent[] = [];
  if (amendment) {
    const newObligations = amendment.obligations.filter((o) => o.replaces || !agreement.obligations.some((x) => x.id === o.id));
    const keptOfVoided = amendment.obligations.filter((o) => voidedPayees.has(o.actor) && agreement.obligations.some((x) => x.id === o.id));
    const byPayee = new Map<Id, Obligation[]>();
    for (const o of [...newObligations, ...keptOfVoided]) byPayee.set(o.actor, [...(byPayee.get(o.actor) ?? []), o]);
    for (const [payee, obs] of byPayee) {
      const prior = amended.filter((m) => obs.some((o) => o.replaces === m.replaces));
      const priorPaid = prior.reduce((s, m) => {
        const pay = payments.find((p) => p.obligations.includes(m.replaces) && CAPTURED_LIKE.includes(p.state));
        return s + (pay ? Math.min(byId.get(m.replaces)?.amount.minor ?? 0, m.allocation.cost.minor) : 0);
      }, 0);
      const minor = obs.reduce((s, o) => s + o.amount.minor, 0) - priorPaid;
      if (minor <= 0) continue;
      const amount = money(intent.budget.currency, minor);
      const operationKey = `order:${recId}:${payee}`;
      orders.push({
        id: operationKey,
        operationKey,
        agreement: agreement.id,
        obligations: obs.map((o) => o.id),
        payee,
        amount,
        charged: amount,
        state: 'PAYMENT_PROPOSED',
        paypal: { env: 'sandbox', refunds: [], debugIds: [] },
      });
    }
  }
  return { refunds, voids, reconcile, orders };
}

/** Plays the original plan forward in the disrupted world without any change: shortfalls, delays and price rises. */
function counterfactualOf(ctx: Ctx): Counterfactual {
  const offers = offerMap(ctx.world);
  const due = new Map<Id, number>();
  const shortfall: Counterfactual['shortfall'] = [];
  let extra = 0;
  for (const stage of topoStages(ctx.world.stages)) {
    const preds = ctx.live.filter((o) => stage.after.includes(o.stage));
    const predReady = Math.max(-8.64e15, ...preds.map((o) => due.get(o.id) ?? -Infinity));
    let delivered = 0;
    for (const o of ctx.live.filter((x) => x.stage === stage.id)) {
      const offer = offers.get(o.offer);
      if (!offer || ctx.removed.has(o.offer) || ctx.inactive.has(o.actor)) continue;
      const qty = Math.min(o.qty, offer.capacity - (ctx.reserved.get(o.offer) ?? 0));
      if (qty <= 0) continue;
      delivered += qty;
      const start = Math.max(ms(o.start), predReady);
      const end = Math.max(ms(o.due) + (start - ms(o.start)), start + workMs(offer, qty) + offer.handoffHours * HOUR);
      due.set(o.id, end);
      extra += Math.max(0, allocationCost(offer, qty).minor - o.amount.minor);
    }
    const need = required(ctx.world, stage, ctx.quantity);
    if (delivered < need) shortfall.push({ stage: stage.id, units: need - delivered });
  }
  const finals = ctx.live.filter((o) => due.has(o.id)).map((o) => ({ ...toAllocation(o), finish: iso(due.get(o.id)!) }));
  const ready = shortfall.length ? -Infinity : readyAt(ctx.world, finals);
  const lateHours = Number.isFinite(ready) && Number.isFinite(ctx.originalReady) ? Math.max(0, hours(ctx.originalReady, ready)) : 0;
  const missesDeadline = shortfall.length > 0 || ready > ms(ctx.intent.deadline) + MINUTE;
  const stageName = (id: string) => ctx.world.stages.find((s) => s.id === id)?.name ?? id;
  const text = shortfall.length
    ? `Without changes, ${shortfall.map((x) => `${stageName(x.stage)} is ${x.units} short`).join(' and ')}, so the order cannot be completed.`
    : missesDeadline
      ? `Without changes, delivery is ready ${lateHours} h later than agreed and misses the deadline.`
      : lateHours > 0
        ? `Without changes, delivery is ready ${lateHours} h later than agreed, still before the deadline.`
        : extra > 0
          ? `Without changes, the order costs ${extra} more in minor units.`
          : 'Without changes, the original plan still holds.';
  return { readyAt: Number.isFinite(ready) ? iso(ready) : null, shortfall, extraCostMinor: extra, lateHours, missesDeadline, text };
}

/**
 * Commits a recovery as the next agreement version once every party accepted its terms hash. The earlier
 * version becomes AMENDED with its terms unchanged; replaced obligations become REPLACED, dropped ones CANCELLED.
 */
export function commitRecovery(
  original: Agreement,
  recovery: RecoveryResult,
  acceptances: readonly AcceptanceInput[],
  opts: { buyer?: Id; current?: Record<Id, Obligation> } = {},
): { original: Agreement; amended: Agreement; obligations: Obligation[] } {
  if (!recovery.feasible || !recovery.amendment) throw new ObligationError('no-amendment', 'This recovery has nothing to commit.');
  let next = recovery.amendment;
  for (const a of acceptances) next = accept(next, a, opts.buyer ?? BUYER);
  const amended = commitAgreement(next);
  const superseded = supersede(original, amended);
  const obligations: Obligation[] = [];
  for (const o of original.obligations) {
    const cur = opts.current?.[o.id] ?? o;
    const to = recovery.amended.includes(o.id) ? 'REPLACED' : recovery.cancelled.includes(o.id) ? 'CANCELLED' : cur.state === 'AT_RISK' ? 'ACTIVE' : null;
    if (!to || !LIVE_OBLIGATION.includes(cur.state)) continue;
    obligations.push(moveObligation(cur, to));
  }
  return { original: superseded, amended, obligations };
}
