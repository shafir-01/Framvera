import type { Allocation, Coalition, Concession, Intent, Intervention, Money, World } from '@framvera/contracts';
import { compile, ESTIMATES, MAX_PRICE_CUT, MAX_SHIFT_HOURS, sortedTiers, type Compiled, type Slack } from './compile.ts';
import type { Term } from './lp.ts';
import { lexSolve, solve } from './solve.ts';
import { applyConcessions } from './apply.ts';
import { verifyPlan } from './verify.ts';
import { synthesizeCoalitions } from './coalitions.ts';
import { describeCoalition, parseCoalition } from './joint.ts';
import { fmtMoney, fmtTime } from './text.ts';

export interface InterventionOptions {
  /** How many distinct interventions to return from supplier changes. Default 3. */
  k?: number;
  /** Upper bound on changed fields per intervention. */
  maxChanges?: number;
  /** Candidate joint capabilities. Defaults to synthesizeCoalitions(world, intent). */
  coalitions?: Coalition[];
  /** Also offer options that bend the buyer's own deadline or budget, marked as needing consent. Default true. */
  userOptions?: boolean;
  /** Kept commitments that no intervention may touch. */
  fixed?: Allocation[];
  capacity?: 'effective' | 'claimed';
  timeLimitMs?: number;
}

const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const SCOPE = `within the planner's bounds (time shifts up to ${MAX_SHIFT_HOURS} hours, price cuts up to ${Math.round(MAX_PRICE_CUT * 100)}%), using the planner's cost estimates. Supplier acceptance is unknown until asked.`;

/**
 * Inverse feasibility: the fewest changes to negotiable fields that make the request feasible, then the
 * lowest estimated cost of those changes. Each result is checked by applying it and solving again.
 */
export async function findInterventions(world: World, intent: Intent, opts: InterventionOptions = {}): Promise<Intervention[]> {
  const t0 = performance.now();
  const limit = opts.timeLimitMs ?? 30000;
  const left = () => Math.max(500, limit - (performance.now() - t0));
  const base = await solve(world, intent, { fixed: opts.fixed, capacity: opts.capacity, explain: false, timeLimitMs: left() });
  if (base.status === 'optimal' || base.status === 'feasible') return [];

  const candidates = opts.coalitions ?? synthesizeCoalitions(world, intent);
  const out: Intervention[] = [];
  const cuts: string[][] = [];

  const search = async (withIntent: boolean, count: number) => {
    const c = compile(world, intent, { fixed: opts.fixed, capacity: opts.capacity, elastic: { offers: true, intent: withIntent, coalitions: candidates } });
    const keyVar = new Map<string, string>();
    for (const s of c.slacks) keyVar.set(s.key, s.change);
    for (const cd of c.candidates) keyVar.set(cd.coalition.id, cd.offer.u);
    const changeTerms: Term[] = [
      ...c.slacks.map((s) => ({ v: s.change, c: s.weight })),
      ...c.candidates.map((cd) => ({ v: cd.offer.u, c: cd.members.length })),
    ];
    const estimateTerms: Term[] = [
      ...c.slacks.filter((s) => s.perUnitEstimate).map((s) => ({ v: s.slack, c: s.perUnitEstimate })),
      ...c.candidates.filter((cd) => cd.estimate).map((cd) => ({ v: cd.offer.u, c: cd.estimate })),
    ];
    const sizeTerms: Term[] = c.slacks.map((s) => ({ v: s.slack, c: 1 / Math.max(1, s.max) }));
    if (!changeTerms.length) return;
    if (opts.maxChanges !== undefined) c.model.addRow(null, changeTerms, '<=', opts.maxChanges);
    if (withIntent) {
      const intentVars = c.slacks.filter((s) => s.target.kind === 'intent').map((s) => ({ v: s.change, c: 1 }));
      if (!intentVars.length) return;
      c.model.addRow(null, intentVars, '>=', 1);
    }
    const addCut = (keys: string[]) => {
      const vars = keys.map((k) => keyVar.get(k));
      if (vars.every((v): v is string => !!v)) c.model.addRow(null, vars.map((v) => ({ v, c: 1 })), '<=', keys.length - 1);
    };
    for (const k of cuts) addCut(k);

    for (let i = 0; i < count; i++) {
      if (performance.now() - t0 > limit) break;
      const r = await lexSolve(
        c,
        [
          { objective: changeTerms, absGap: 0.5 },
          { objective: estimateTerms, absGap: 1e-3 },
          { objective: sizeTerms, absGap: 1e-6 },
        ],
        left(),
      );
      if (r.status !== 'optimal' && r.status !== 'feasible') break;
      const changed = c.slacks.filter((s) => (r.values[s.change] ?? 0) > 0.5);
      const joint = c.candidates.filter((cd) => (r.values[cd.offer.u] ?? 0) > 0.5);
      const keys = [...changed.map((s) => s.key), ...joint.map((cd) => cd.coalition.id)].sort();
      if (!keys.length) break;
      cuts.push(keys);
      addCut(keys);
      const iv = await build(c, r.values, changed, joint.map((j) => j.coalition.id), {
        first: out.length === 0 && !withIntent,
        proven: r.status === 'optimal',
        withIntent,
        changes: Math.round(r.objectives[0] ?? keys.length),
      });
      if (iv) out.push(iv);
    }
  };

  const build = async (
    c: Compiled,
    values: Record<string, number>,
    changed: Slack[],
    joint: string[],
    info: { first: boolean; proven: boolean; withIntent: boolean; changes: number },
  ): Promise<Intervention | null> => {
    const concessions = changed.map((s) => concessionFor(c, s, values));
    for (const id of joint) concessions.push(...jointConcessions(c, id));
    let applied: { world: World; intent: Intent };
    try {
      applied = applyConcessions(world, intent, concessions);
    } catch {
      return null;
    }
    const r = await solve(applied.world, applied.intent, { fixed: opts.fixed, capacity: opts.capacity, explain: false, timeLimitMs: left() });
    if (!r.plan) return null;
    const check = verifyPlan(r.plan, applied.world, applied.intent, { fixed: opts.fixed, capacity: opts.capacity });
    if (!check.ok) return null;
    const used = r.plan.allocations.find((a) => joint.includes(a.offer));
    const n = info.changes;
    const fields = `${n} changed ${n === 1 ? 'field' : 'fields'}`;
    const minimality = !info.proven
      ? `Best found within the time limit with ${fields}; not proven to be the fewest. ${SCOPE}`
      : info.withIntent
        ? `Fewest changes (${fields}) among options that bend your own deadline or budget, which needs your consent, ${SCOPE}`
        : info.first
          ? `Fewest changes (${fields}) among the fields suppliers marked negotiable, then the lowest estimated cost, ${SCOPE}`
          : `Next best after excluding earlier change sets: fewest changes (${fields}) among the remaining options, then the lowest estimated cost, ${SCOPE}`;
    const body = concessions.map((x) => `${x.id}`).join('|');
    return {
      id: `iv-${hash(`${world.id}:${world.version}:${body}`)}`,
      concessions,
      unlocks: true,
      totalAfter: r.plan.total,
      method: used ? 'coalition' : 'elastic-mip',
      minimality,
      ...(used ? { coalition: describeCoalition(applied.world, used.offer, used.qty)! } : {}),
    };
  };

  await search(false, opts.k ?? 3);
  const userBendable = (intent.negotiable.deadlineHours ?? 0) > 0 || (intent.negotiable.budgetMinor ?? 0) > 0;
  if ((opts.userOptions ?? true) && userBendable && performance.now() - t0 < limit) await search(true, 2);
  return out;
}

function concessionFor(c: Compiled, s: Slack, values: Record<string, number>): Concession {
  const v = Math.max(0, values[s.slack] ?? 0);
  const units = Math.max(1, Math.ceil(v - 1e-6));
  const minutes = Math.max(1, Math.ceil(v * 60 - 0.01));
  const currency = c.intent.budget.currency;
  const m = (minor: number): Money => ({ currency, minor: Math.max(0, Math.round(minor)) });
  const make = (from: number | string, to: number | string, estimate: number, rationale: string): Concession => {
    const key = s.target.kind === 'offer' ? `${s.target.offer}:${s.target.field}` : `intent:${s.target.field}`;
    return { id: `cn-${hash(`${key}:${from}:${to}`)}`, target: s.target, from, to, estimate: m(estimate), rationale };
  };
  if (s.target.kind === 'intent') {
    if (s.target.field === 'deadline') {
      const from = c.intent.deadline;
      const to = new Date(Date.parse(from) + minutes * 60000).toISOString();
      return make(from, to, 0, `You accept delivery by ${fmtTime(to)} instead of ${fmtTime(from)}. Needs your consent.`);
    }
    const from = c.intent.budget.minor;
    const to = from + units;
    return make(from, to, units, `You raise the budget from ${fmtMoney(m(from))} to ${fmtMoney(m(to))}. Needs your consent.`);
  }
  const co = s.offer!;
  const o = co.offer;
  const who = c.world.actors.find((a) => a.id === o.actor)?.name ?? o.actor;
  const unit = c.world.stages.find((st) => st.id === o.stage)?.unit ?? 'units';
  switch (s.target.field) {
    case 'capacity':
      return make(o.capacity, o.capacity + units, units * s.perUnitEstimate, `${who} raises capacity from ${o.capacity} to ${o.capacity + units} ${unit}.`);
    case 'minQty': {
      const to = Math.max(0, o.minQty - units);
      return make(o.minQty, to, (o.minQty - to) * s.perUnitEstimate, `${who} accepts orders from ${to} ${unit} instead of ${o.minQty}.`);
    }
    case 'windowEnd': {
      const to = new Date(Date.parse(o.window.end) + minutes * 60000).toISOString();
      return make(o.window.end, to, (minutes / 60) * s.perUnitEstimate, `${who} works until ${fmtTime(to)} instead of ${fmtTime(o.window.end)}.`);
    }
    case 'windowStart': {
      const to = new Date(Date.parse(o.window.start) - minutes * 60000).toISOString();
      return make(o.window.start, to, (minutes / 60) * s.perUnitEstimate, `${who} can start from ${fmtTime(to)} instead of ${fmtTime(o.window.start)}.`);
    }
    case 'unitPrice': {
      const q = Math.max(1, Math.round(values[co.q] ?? 1));
      const tiers = sortedTiers(o);
      let from = tiers[0]?.unit.minor ?? 0;
      for (const t of tiers) if (q >= t.minQty) from = t.unit.minor;
      const cut = Math.min(from, Math.max(1, Math.ceil((v - 1e-6) / q)));
      const to = from - cut;
      return make(from, to, cut * q, `${who} lowers the unit price from ${fmtMoney(m(from))} to ${fmtMoney(m(to))} for ${q} ${unit}.`);
    }
    case 'setupFee': {
      const from = o.setupFee.minor;
      const to = Math.max(0, from - units);
      return make(from, to, from - to, `${who} lowers the setup fee from ${fmtMoney(m(from))} to ${fmtMoney(m(to))}.`);
    }
    default:
      throw new Error(`no slack for ${s.target.field}`);
  }
}

function jointConcessions(c: Compiled, id: string): Concession[] {
  const shape = parseCoalition(id)!;
  const currency = c.intent.budget.currency;
  const names = new Map(c.world.actors.map((a) => [a.id, a.name]));
  const offers = new Map(c.world.offers.map((o) => [o.id, o]));
  const unit = c.world.stages.find((st) => st.id === offers.get(shape.members[0]!)?.stage)?.unit ?? 'units';
  return shape.members.map((member) => {
    const o = offers.get(member)!;
    const who = names.get(o.actor) ?? o.actor;
    const others = shape.members.filter((x) => x !== member).map((x) => names.get(offers.get(x)!.actor) ?? x).join(' and ');
    const ms = shape.members.map((x) => offers.get(x)!);
    const vehicle = ms.reduce((best, x) => (x.capacity > best.capacity ? x : best));
    const crew = ms.find((x) => x !== vehicle) ?? vehicle;
    const rationale =
      member === vehicle.id
        ? `${who} lends its capacity of ${vehicle.capacity} ${unit} to a job ${others} runs in its own window.`
        : `${who} runs the job in its window using ${others}'s capacity of ${vehicle.capacity} ${unit} instead of its own ${crew.capacity}.`;
    return {
      id: `cn-${hash(`${member}:joint:${id}`)}`,
      target: { kind: 'offer' as const, offer: member, field: 'joint' as const },
      from: 'separate',
      to: id,
      estimate: { currency, minor: Math.round(ESTIMATES.jointPerMember * o.setupFee.minor) },
      rationale,
    };
  });
}
