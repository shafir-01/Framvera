import type { Coalition, Concession, Intent, Intervention, NegotiationMessage, Plan, SolveReport, SupplierDecision, World } from '@framvera/contracts';
import { runAgentHarness } from './harness/index.ts';
import { createBoundary, type Boundary } from './boundary.ts';
import { buildDirectPlan, directLooksFeasible } from './direct.ts';
import { rng, shuffle } from './stats.ts';
import type { Deps, HiddenTruthLike, Outcome, StrategyId } from './types.ts';

export interface RunConfig {
  budget: number;
  timeLimitMs: number;
  maxChanges: number;
  rounds: number;
  seed: number;
}

const H = 3_600_000;
const feasible = (r: SolveReport): r is SolveReport & { plan: Plan } =>
  (r.status === 'optimal' || r.status === 'feasible') && !!r.plan;

class Ctx {
  solveMs = 0;
  notes: string[] = [];
  readonly boundary: Boundary;
  readonly rand: () => number;
  private n = 0;
  constructor(readonly deps: Deps, readonly world: World, readonly intent: Intent, truth: HiddenTruthLike, readonly cfg: RunConfig, salt: number) {
    this.boundary = createBoundary(deps, truth, world);
    this.rand = rng(cfg.seed * 31 + salt);
  }
  async solve(w: World, i: Intent): Promise<SolveReport> {
    const r = await this.deps.solver.solve(w, i, { timeLimitMs: this.cfg.timeLimitMs });
    this.solveMs += r.solver.ms;
    return r;
  }
  propose(c: Concession): NegotiationMessage | null {
    if (c.target.kind !== 'offer') return null;
    const target = c.target;
    const offer = this.world.offers.find((o) => o.id === target.offer);
    if (!offer) return null;
    const at = this.world.createdAt;
    return {
      type: 'Propose', id: `ref-${this.n++}`, from: 'buyer', to: offer.actor, concession: c,
      expires: new Date(Date.parse(at) + 24 * H).toISOString(), at,
    };
  }
  registerCoalitions(ivs: Intervention[]): void {
    const seen = new Map<string, Coalition>();
    for (const iv of ivs) {
      if (iv.coalition && !seen.has(iv.coalition.id)) {
        seen.set(iv.coalition.id, this.deps.negotiation.splitCoalition(iv.coalition, undefined, { world: this.world }));
      }
    }
    this.boundary.setCoalitions([...seen.values()]);
  }
  /** Terms the buyer takes from a supplier answer: the ask itself, or the supplier's own counter. */
  private termsOf(c: Concession, d: SupplierDecision): Concession[] | null {
    if (d.accept) return [c];
    const k = d.counter;
    if (!k) return null;
    const sameTerm = k.target.kind === 'offer' && c.target.kind === 'offer' && k.target.offer === c.target.offer && k.target.field === c.target.field;
    return sameTerm ? [k] : [c, k];
  }
  ask(m: NegotiationMessage): Concession[] | null {
    const c = concessionOf(m);
    if (!c) return null;
    const d = this.boundary.ask(m);
    const t = this.termsOf(c, d);
    if (t && !d.accept) this.boundary.countAccepted();
    return t;
  }
  hindsightTerms(m: NegotiationMessage): Concession[] | null {
    const c = concessionOf(m);
    return c ? this.termsOf(c, this.boundary.hindsight(m)) : null;
  }
  outcome(claimed: boolean, world: World, intent: Intent, plan?: Plan): Outcome {
    return {
      claimed, plan, world, intent, questions: this.boundary.asked, accepted: this.boundary.accepted,
      decisions: this.boundary.decisions, solveMs: this.solveMs, notes: this.notes,
    };
  }
}

/** The buyer speaks for its own negotiable limits: grants any intent concession inside them. */
function buyerGrants(intent: Intent, c: Concession): boolean {
  if (c.target.kind !== 'intent') return false;
  if (c.target.field === 'deadline') {
    const maxH = intent.negotiable.deadlineHours ?? 0;
    return (Date.parse(String(c.to)) - Date.parse(String(c.from))) / H <= maxH + 1e-9;
  }
  const maxB = intent.negotiable.budgetMinor ?? 0;
  return Number(c.to) - Number(c.from) <= maxB;
}

function concessionOf(msg: NegotiationMessage): Concession | null {
  if (msg.type === 'Propose' || msg.type === 'CounterOffer') return msg.concession;
  if (msg.type === 'AskPreference') return msg.question;
  return null;
}

async function solveWith(ctx: Ctx, accepted: Concession[]): Promise<Outcome> {
  const { world, intent } = ctx.deps.solver.applyConcessions(ctx.world, ctx.intent, accepted);
  const r = await ctx.solve(world, intent);
  if (!feasible(r) || r.plan.total.minor > intent.budget.minor || !ctx.deps.solver.verifyPlan(r.plan, world, intent).ok) return ctx.outcome(false, world, intent);
  return ctx.outcome(true, world, intent, r.plan);
}

async function direct(ctx: Ctx): Promise<Outcome> {
  const plan = buildDirectPlan(ctx.world, ctx.intent);
  if (!plan) return ctx.outcome(false, ctx.world, ctx.intent);
  return ctx.outcome(directLooksFeasible(plan, ctx.intent), ctx.world, ctx.intent, plan);
}

async function optimizer(ctx: Ctx): Promise<Outcome> {
  const r = await ctx.solve(ctx.world, ctx.intent);
  return feasible(r) ? ctx.outcome(true, ctx.world, ctx.intent, r.plan) : ctx.outcome(false, ctx.world, ctx.intent);
}

function askAll(ctx: Ctx, cs: Concession[]): Concession[] {
  const ok: Concession[] = [];
  for (const c of cs) {
    const m = ctx.propose(c);
    const t = m ? ctx.ask(m) : null;
    if (t) ok.push(...t);
  }
  return ok;
}

async function heuristic(ctx: Ctx): Promise<Outcome> {
  const cs: Concession[] = [];
  const zero = { currency: ctx.world.currency, minor: 0 };
  for (const o of ctx.world.offers) {
    const u = o.tiers[0]?.unit.minor ?? 0;
    cs.push({
      id: `h-p-${o.id}`, target: { kind: 'offer', offer: o.id, field: 'unitPrice' }, from: u, to: Math.floor(u * 0.9),
      estimate: { currency: ctx.world.currency, minor: Math.ceil(u * 0.1) }, rationale: 'uniform 10 percent discount',
    });
    cs.push({
      id: `h-w-${o.id}`, target: { kind: 'offer', offer: o.id, field: 'windowEnd' }, from: o.window.end,
      to: new Date(Date.parse(o.window.end) + 12 * H).toISOString(), estimate: zero, rationale: 'uniform 12 hour extension',
    });
  }
  return solveWith(ctx, askAll(ctx, cs));
}

function randomConcession(ctx: Ctx, idx: number): Concession | null {
  const pool = ctx.world.offers.filter((o) => o.negotiable.some((f) => f !== 'joint'));
  if (!pool.length) return null;
  const o = pool[Math.floor(ctx.rand() * pool.length)] as World['offers'][number];
  const fields = o.negotiable.filter((f) => f !== 'joint');
  const field = fields[Math.floor(ctx.rand() * fields.length)] as (typeof fields)[number];
  const pct = [0.05, 0.1, 0.15, 0.25][Math.floor(ctx.rand() * 4)] as number;
  const hrs = [6, 12, 24, 48][Math.floor(ctx.rand() * 4)] as number;
  const base = { id: `r-${idx}-${o.id}-${field}`, estimate: { currency: ctx.world.currency, minor: 0 }, rationale: 'random relaxation' };
  const target = { kind: 'offer' as const, offer: o.id, field };
  switch (field) {
    case 'unitPrice': { const u = o.tiers[0]?.unit.minor ?? 0; return { ...base, target, from: u, to: Math.floor(u * (1 - pct)) }; }
    case 'windowEnd': return { ...base, target, from: o.window.end, to: new Date(Date.parse(o.window.end) + hrs * H).toISOString() };
    case 'windowStart': return { ...base, target, from: o.window.start, to: new Date(Date.parse(o.window.start) - hrs * H).toISOString() };
    case 'capacity': return { ...base, target, from: o.capacity, to: Math.ceil(o.capacity * (1 + pct)) };
    case 'minQty': return { ...base, target, from: o.minQty, to: Math.floor(o.minQty * (1 - pct)) };
    case 'setupFee': return { ...base, target, from: o.setupFee.minor, to: Math.floor(o.setupFee.minor * (1 - pct)) };
    default: return null;
  }
}

async function randomRelax(ctx: Ctx): Promise<Outcome> {
  const accepted: Concession[] = [];
  for (let i = 0; i < ctx.cfg.budget; i++) {
    const c = randomConcession(ctx, i);
    if (!c) break;
    accepted.push(...askAll(ctx, [c]));
  }
  return solveWith(ctx, accepted);
}

interface FramveraFlags { coalitions: boolean; voi: boolean; claimChecks: boolean }

const involves = (iv: Intervention, ids: Set<string>) => iv.concessions.some((c) => ids.has(c.id));

async function framvera(ctx: Ctx, f: FramveraFlags): Promise<Outcome> {
  const { deps } = ctx;
  const base = await ctx.solve(ctx.world, ctx.intent);
  if (feasible(base)) return ctx.outcome(true, ctx.world, ctx.intent, base.plan);

  let pool = (await deps.solver.findInterventions(ctx.world, ctx.intent, { maxChanges: ctx.cfg.maxChanges, k: 12 }))
    .filter((iv) => iv.unlocks && (f.coalitions || (iv.method !== 'coalition' && !iv.coalition)));
  ctx.registerCoalitions(pool);
  const granted = new Map<string, Concession[]>();
  const rejected = new Set<string>();
  const asked = new Set<string>();
  for (const iv of pool) for (const c of iv.concessions) if (buyerGrants(ctx.intent, c)) granted.set(c.id, [c]);

  const covered = () =>
    pool.filter((iv) => iv.concessions.every((c) => granted.has(c.id)))
      .sort((a, b) => (a.totalAfter?.minor ?? Infinity) - (b.totalAfter?.minor ?? Infinity));

  for (let round = 0; round < ctx.cfg.rounds && covered().length === 0; round++) {
    const remaining = ctx.cfg.budget - ctx.boundary.asked;
    if (remaining <= 0 || pool.length === 0) break;
    let msgs: NegotiationMessage[];
    if (f.voi) {
      msgs = deps.negotiation.selectQuestions(ctx.world, ctx.intent, pool, remaining).map((q) => q.message);
    } else {
      const seen = new Map<string, Concession>();
      for (const iv of pool) for (const c of iv.concessions) seen.set(c.id, c);
      msgs = shuffle([...seen.values()], ctx.rand).map((c) => ctx.propose(c)).filter((m): m is NegotiationMessage => !!m);
    }
    const fresh = msgs.filter((m) => { const c = concessionOf(m); return c && !asked.has(c.id); }).slice(0, remaining);
    if (!fresh.length) break;
    for (const m of fresh) {
      const c = concessionOf(m) as Concession;
      asked.add(c.id);
      const t = ctx.ask(m);
      if (t) granted.set(c.id, t);
      else rejected.add(c.id);
    }
    pool = pool.filter((iv) => !involves(iv, rejected));
  }

  const options = covered();
  if (!options.length) { ctx.notes.push('no intervention fully accepted'); return ctx.outcome(false, ctx.world, ctx.intent); }
  let out = ctx.outcome(false, ctx.world, ctx.intent);
  for (const iv of options.slice(0, 4)) {
    out = await solveWith(ctx, iv.concessions.flatMap((c) => granted.get(c.id) as Concession[]));
    if (out.claimed) break;
  }
  if (out.claimed && out.plan && f.claimChecks) {
    const bad = deps.negotiation.challengeClaims(out.world, out.plan).filter((x) => x.verdict === 'contradicted' || x.verdict === 'expired');
    if (bad.length) { ctx.notes.push(`claim checks rejected plan: ${bad.map((b) => b.claim).join(',')}`); return ctx.outcome(false, out.world, out.intent); }
  }
  return out;
}

async function oracle(ctx: Ctx): Promise<Outcome> {
  const base = await ctx.solve(ctx.world, ctx.intent);
  if (feasible(base)) return ctx.outcome(true, ctx.world, ctx.intent, base.plan);
  const pool = (await ctx.deps.solver.findInterventions(ctx.world, ctx.intent, { maxChanges: ctx.cfg.maxChanges + 1, k: 40 }))
    .filter((iv) => iv.unlocks)
    .sort((a, b) => (a.totalAfter?.minor ?? Infinity) - (b.totalAfter?.minor ?? Infinity));
  ctx.registerCoalitions(pool);
  for (const iv of pool) {
    const terms: Concession[] = [];
    const ok = iv.concessions.every((c) => {
      if (c.target.kind === 'intent') { terms.push(c); return buyerGrants(ctx.intent, c); }
      const m = ctx.propose(c);
      const t = m ? ctx.hindsightTerms(m) : null;
      if (t) terms.push(...t);
      return !!t;
    });
    if (!ok) continue;
    const out = await solveWith(ctx, terms);
    if (out.claimed) { ctx.notes.push('hindsight: intervention chosen with knowledge of private policies'); return out; }
  }
  return ctx.outcome(false, ctx.world, ctx.intent);
}

export async function runStrategy(
  id: StrategyId, deps: Deps, world: World, intent: Intent, truth: HiddenTruthLike, cfg: RunConfig,
): Promise<Outcome> {
  const salt = Math.abs([...id].reduce((a, c) => (a * 33 + c.charCodeAt(0)) | 0, 7));
  const ctx = new Ctx(deps, world, intent, truth, cfg, salt);
  switch (id) {
    case 'direct': return direct(ctx);
    case 'optimizer': return optimizer(ctx);
    case 'uniform-heuristic': return heuristic(ctx);
    case 'random-relaxations': return randomRelax(ctx);
    case 'framvera': return framvera(ctx, { coalitions: true, voi: true, claimChecks: true });
    case 'framvera-no-coalitions': return framvera(ctx, { coalitions: false, voi: true, claimChecks: true });
    case 'framvera-no-voi': return framvera(ctx, { coalitions: true, voi: false, claimChecks: true });
    case 'framvera-no-claim-checks': return framvera(ctx, { coalitions: true, voi: true, claimChecks: false });
    case 'oracle': return oracle(ctx);
    case 'agent-harness': return runAgentHarness(deps, world, intent, truth, cfg);
  }
}
