import type {
  Allocation,
  Coalition,
  Concession,
  ConstraintKind,
  ConstraintRef,
  Intent,
  NegotiableField,
  Offer,
  Stage,
  World,
} from '@framvera/contracts';
import { Model, type Term } from './lp.ts';
import { HOUR_MS, fmtMoney, fmtTime } from './text.ts';
import { effectiveCapacity, offerCost } from '@framvera/contracts';
import { deriveOffer, parseCoalition } from './joint.ts';

/** Largest time shift the planner will ever propose for a window, in hours. */
export const MAX_SHIFT_HOURS = 168;
/** Largest unit price cut the planner will ever propose, as a share of the offer's cost. */
export const MAX_PRICE_CUT = 0.3;

/**
 * Planner's cost estimates for each kind of change, used only to rank interventions.
 * They are assumptions, labelled as such wherever an estimate is shown.
 */
export const ESTIMATES = {
  /** Extra capacity: overtime premium per extra unit, as a share of the base unit price. */
  capacityPremium: 0.2,
  /** Smaller minimum order: lost batch efficiency per waived unit, as a share of the base unit price. */
  minQtyPerUnit: 0.1,
  /** Wider working window: per hour, as a share of one hour of output value. */
  windowPerHour: 0.1,
  /** Joint capability: coordination cost per member, as a share of its setup fee. */
  jointPerMember: 0.25,
} as const;

export interface ElasticOptions {
  offers?: boolean;
  intent?: boolean;
  /** Candidate joint capabilities, added as derived offers whose use counts as changes. */
  coalitions?: Coalition[];
}

export interface CompileOptions {
  fixed?: Allocation[];
  /** 'effective' (default): claimed capacity minus capacity recorded as already booked. 'claimed': take claims at face value. */
  capacity?: 'effective' | 'claimed';
  elastic?: ElasticOptions;
  baseline?: Allocation[];
  /** Constraint groups left out entirely. Every derived bound comes only from the groups that remain. */
  disabled?: ReadonlySet<string>;
}

export interface CompiledOffer {
  offer: Offer;
  idx: number;
  usable: boolean;
  /** Can be used at all under the active constraints (time, quantity and validity bounds). */
  possible: boolean;
  demand: number;
  q: string;
  u: string;
  s: string;
  e: string;
  tiers: { z: string; y: string; unit: number }[];
  fixed?: Allocation;
}

export interface Slack {
  key: string;
  target: Concession['target'];
  slack: string;
  change: string;
  unit: 'units' | 'hours' | 'minor';
  perUnitEstimate: number;
  offer?: CompiledOffer;
  weight: number;
  /** Largest allowed change, used to compare change sizes across units. */
  max: number;
}

export interface CompiledCandidate {
  coalition: Coalition;
  offer: CompiledOffer;
  members: string[];
  estimate: number;
}

export interface CompiledStage {
  stage: Stage;
  demand: number;
  ready: string;
  terminal: boolean;
}

export interface Compiled {
  world: World;
  intent: Intent;
  model: Model;
  refs: Map<string, ConstraintRef>;
  offers: CompiledOffer[];
  stages: CompiledStage[];
  candidates: CompiledCandidate[];
  slacks: Slack[];
  t0: number;
  costTerms: Term[];
  costConstant: number;
  changeTerms: Term[];
  end: string;
  now: number;
}

const ms = (t: string): number => {
  const v = Date.parse(t);
  if (Number.isNaN(v)) throw new Error(`invalid timestamp ${t}`);
  return v;
};

/** Units an offer can be allocated: shared contracts semantics unless claims are taken at face value. */
export function capacityOf(world: World, offer: Offer, mode: CompileOptions['capacity'] = 'effective'): number {
  return mode === 'claimed' ? offer.capacity : effectiveCapacity(world, offer);
}

/** The binding spend limit: the budget, or the spending authority when it is lower. */
export function spendCap(intent: Intent): number {
  const auth = intent.authority.maxSpend;
  return auth.currency === intent.budget.currency ? Math.min(intent.budget.minor, auth.minor) : intent.budget.minor;
}

export function stageDemand(stage: Stage, intent: Intent): number {
  return Math.ceil(intent.quantity * stage.perOutcome - 1e-9);
}

export function terminalStages(world: World): Set<string> {
  const preds = new Set(world.stages.flatMap((s) => s.after));
  return new Set(world.stages.filter((s) => !preds.has(s.id)).map((s) => s.id));
}

export function topo(world: World): Stage[] {
  const byId = new Map(world.stages.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: Stage[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (seen.has(id)) return;
    if (path.has(id)) throw new Error(`stage cycle at ${id}`);
    const s = byId.get(id);
    if (!s) throw new Error(`unknown stage ${id}`);
    path.add(id);
    for (const p of s.after) visit(p, path);
    path.delete(id);
    seen.add(id);
    out.push(s);
  };
  for (const s of world.stages) visit(s.id, new Set());
  return out;
}

export function sortedTiers(offer: Offer) {
  return offer.tiers.slice().sort((a, b) => a.minQty - b.minQty);
}

/** Published price for qty units: all-units tier pricing plus the setup fee. */
export function priceAt(offer: Offer, qty: number): number {
  return offerCost(offer, qty).minor;
}

interface Info {
  o: Offer;
  idx: number;
  usable: boolean;
  blocked: boolean;
  fixed?: Allocation;
  flex: Set<NegotiableField>;
  demand: number;
  ubCap: number;
  capEff: number;
  minQ: number;
  ws: number;
  we: number;
  possible: boolean;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  qmax: number;
}

const EPS = 1e-7;

export function compile(world: World, intent: Intent, opts: CompileOptions = {}): Compiled {
  const m = new Model();
  const refs = new Map<string, ConstraintRef>();
  const off = opts.disabled ?? new Set<string>();
  const on = (id: string) => !off.has(id);
  const actorById = new Map(world.actors.map((a) => [a.id, a]));
  const stageById = new Map(world.stages.map((s) => [s.id, s]));
  const order = topo(world);
  const terminals = terminalStages(world);
  const successors = new Map(world.stages.map((s) => [s.id, world.stages.filter((t) => t.after.includes(s.id))]));
  const currency = intent.budget.currency;
  const now = ms(world.createdAt);
  const deadline = ms(intent.deadline);
  const fixedByOffer = new Map((opts.fixed ?? []).map((f) => [f.offer, f]));
  const baseline = new Map((opts.baseline ?? []).map((b) => [b.offer, b]));
  const elastic = opts.elastic ?? {};
  const name = (actor: string) => actorById.get(actor)?.name ?? actor;
  const ref = (id: string, kind: ConstraintKind, text: string, subject?: string) => {
    if (!refs.has(id)) refs.set(id, subject ? { id, kind, subject, text } : { id, kind, text });
    return id;
  };

  const candidateOffers = (elastic.coalitions ?? []).flatMap((c) => {
    if (world.offers.some((o) => o.id === c.id)) return [];
    const d = deriveOffer(world, c.id);
    return d ? [{ coalition: c, offer: d }] : [];
  });
  const allOffers = [...world.offers, ...candidateOffers.map((x) => x.offer)];
  const offerById = new Map(allOffers.map((o) => [o.id, o]));

  const times: number[] = [now, deadline];
  for (const o of allOffers) times.push(ms(o.window.start), ms(o.window.end));
  for (const f of opts.fixed ?? []) times.push(ms(f.start), ms(f.finish));
  const extraDeadline = elastic.intent ? (intent.negotiable.deadlineHours ?? 0) : 0;
  const t0 = Math.min(...times) - MAX_SHIFT_HOURS * HOUR_MS;
  const hours = (t: number) => (t - t0) / HOUR_MS;
  const tMax = hours(Math.max(...times)) + MAX_SHIFT_HOURS + (intent.negotiable.deadlineHours ?? 0);
  const demandOf = new Map(world.stages.map((s) => [s.id, stageDemand(s, intent)]));
  const deadlineH = hours(deadline);

  let maxDur = 0;
  let maxHand = 0;
  const infos: Info[] = allOffers.map((o, idx) => {
    const actor = actorById.get(o.actor);
    const fixed = fixedByOffer.get(o.id);
    const shape = parseCoalition(o.id);
    const membersActive = !shape || shape.members.every((id) => {
      const member = offerById.get(id);
      return !member || !!actorById.get(member.actor)?.active;
    });
    const usable =
      !!actor && actor.active && stageById.has(o.stage) && o.ratePerHour > 0 && o.tiers.length > 0 && membersActive &&
      o.tiers.every((t) => t.unit.currency === currency) && o.setupFee.currency === currency;
    if (fixed && !usable) throw new Error(`kept allocation uses unusable offer ${o.id}`);
    const demand = demandOf.get(o.stage) ?? 0;
    const flex = new Set<NegotiableField>(elastic.offers && !fixed ? o.negotiable : []);
    const ubCap = Math.max(o.capacity + demand, sortedTiers(o).at(-1)?.minQty ?? 0, o.minQty, 1);
    if (o.ratePerHour > 0) maxDur = Math.max(maxDur, ubCap / o.ratePerHour);
    maxHand = Math.max(maxHand, o.handoffHours);
    const expired = ms(o.validUntil) < now && on(`validity:${o.id}`);
    const capacity = capacityOf(world, o, opts.capacity);
    const windowOn = on(`window:${o.id}`);
    const useful = Math.max(demand, o.minQty, sortedTiers(o).at(-1)?.minQty ?? 0, 1);
    let capEff = Math.min(useful, on(`capacity:${o.id}`) ? capacity + (flex.has('capacity') ? demand : 0) : ubCap);
    let minQ = on(`min-qty:${o.id}`) && !flex.has('minQty') ? Math.max(1, o.minQty) : 1;
    if (fixed) capEff = minQ = fixed.qty;
    return {
      o,
      idx,
      usable,
      blocked: !usable || (expired && !fixed),
      fixed,
      flex,
      demand,
      ubCap,
      capEff,
      minQ,
      ws: windowOn ? hours(ms(o.window.start)) - (flex.has('windowStart') ? MAX_SHIFT_HOURS : 0) : -Infinity,
      we: windowOn ? hours(ms(o.window.end)) + (flex.has('windowEnd') ? MAX_SHIFT_HOURS : 0) : Infinity,
      possible: false,
      es: 0,
      ef: 0,
      ls: 0,
      lf: 0,
      qmax: 0,
    };
  });
  const big = 2 * (tMax + maxDur + maxHand + 1);
  const byStage = new Map(world.stages.map((s) => [s.id, infos.filter((i) => i.o.stage === s.id)]));

  // Critical-path bounds under the active groups only; offers that cannot fit are fixed unused.
  for (const i of infos) i.possible = !i.blocked && i.minQ <= i.capEff;
  const ready = new Map<string, number>();
  const latest = new Map<string, number>();
  for (let pass = 0; pass < 8; pass++) {
    for (const st of order) {
      for (const i of byStage.get(st.id)!) {
        if (!i.possible) continue;
        let lb = i.fixed ? -Infinity : Math.max(0, i.ws);
        for (const p of st.after) if (on(`precedence:${p}>${st.id}`)) lb = Math.max(lb, ready.get(p) ?? 0);
        i.es = i.fixed ? hours(ms(i.fixed.start)) : lb;
        i.ef = i.es + i.minQ / i.o.ratePerHour;
      }
      const live = byStage.get(st.id)!.filter((i) => i.possible);
      const needed = on(`demand:${st.id}`) && (demandOf.get(st.id) ?? 0) > 0;
      ready.set(st.id, needed && live.length ? Math.min(...live.map((i) => i.ef + i.o.handoffHours)) : 0);
    }
    for (const st of [...order].reverse()) {
      let lr = terminals.has(st.id) && on('deadline') ? deadlineH + extraDeadline : Infinity;
      for (const t of successors.get(st.id)!) {
        if (!on(`precedence:${st.id}>${t.id}`) || !on(`demand:${t.id}`) || (demandOf.get(t.id) ?? 0) <= 0) continue;
        const live = byStage.get(t.id)!.filter((i) => i.possible);
        lr = Math.min(lr, live.length ? Math.max(...live.map((i) => i.ls)) : -Infinity);
      }
      latest.set(st.id, lr);
      for (const i of byStage.get(st.id)!) {
        if (!i.possible) continue;
        i.lf = Math.min(i.we, lr - i.o.handoffHours);
        i.ls = i.lf - i.minQ / i.o.ratePerHour;
      }
    }
    let changed = false;
    for (const i of infos) {
      if (!i.possible) continue;
      const span = i.lf - i.es;
      i.qmax = i.fixed ? i.fixed.qty : Number.isFinite(span) ? Math.min(i.capEff, Math.floor(i.o.ratePerHour * span + 1e-6)) : i.capEff;
      if (!i.fixed && (i.es > i.ls + EPS || i.qmax < i.minQ)) {
        i.possible = false;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const offers: CompiledOffer[] = [];
  const costTerms: Term[] = [];
  let costConstant = 0;
  const slacks: Slack[] = [];
  const changeTerms: Term[] = [];
  const costByOffer = new Map<string, Term[]>();
  const pushCost = (offer: string, t: Term) => {
    costTerms.push(t);
    costByOffer.set(offer, [...(costByOffer.get(offer) ?? []), t]);
  };
  const ub = (v: string) => m.vars.get(v)!.ub;
  const lb = (v: string) => m.vars.get(v)!.lb;
  const cap = (x: number) => (Number.isFinite(x) ? Math.min(x, big) : big);

  for (const i of infos) {
    const { o, idx, fixed, flex, demand } = i;
    const live = i.possible;
    const q = m.addVar(`q${idx}`, 0, live ? i.qmax : 0, 'I');
    const u = m.addVar(`u${idx}`, 0, live ? 1 : 0, 'B');
    const sLo = live ? i.es : 0;
    const s = m.addVar(`s${idx}`, sLo, live ? Math.max(sLo, cap(fixed ? i.es : i.ls)) : sLo, 'C');
    const e = m.addVar(`t${idx}`, sLo, live ? Math.max(sLo, cap(fixed ? big : i.lf)) : sLo, 'C');
    const co: CompiledOffer = { offer: o, idx, usable: i.usable, possible: live, demand, q, u, s, e, tiers: [], fixed };
    offers.push(co);
    if (!i.usable) continue;
    const who = name(o.actor);
    const unitName = stageById.get(o.stage)!.unit;
    const capacity = capacityOf(world, o, opts.capacity);
    const booked = o.capacity - capacity;
    const capText = booked > 0
      ? `${who} has room for ${capacity} ${unitName}: ${o.capacity} claimed, ${booked} already booked by others.`
      : `${who} has room for at most ${o.capacity} ${unitName}.`;
    const capId = ref(`capacity:${o.id}`, 'capacity', capText, o.id);
    const moqId = o.minQty > 0 ? ref(`min-qty:${o.id}`, 'min-qty', `${who} only takes orders of ${o.minQty} ${unitName} or more.`, o.id) : null;
    const winId = ref(`window:${o.id}`, 'window', `${who} can only work between ${fmtTime(o.window.start)} and ${fmtTime(o.window.end)}.`, o.id);
    if (ms(o.validUntil) < now) ref(`validity:${o.id}`, 'validity', `The offer from ${who} expired ${fmtTime(o.validUntil)}.`, o.id);
    if (fixed) costConstant += fixed.cost.minor;
    if (!live) continue;

    m.addRow(null, [{ v: e, c: 1 }, { v: s, c: -1 }, { v: q, c: -1 / o.ratePerHour }], '=', 0);
    m.addRow(null, [{ v: q, c: 1 }, { v: u, c: -i.qmax }], '<=', 0);
    m.addRow(null, [{ v: q, c: 1 }, { v: u, c: -1 }], '>=', 0);

    if (fixed) {
      m.setBounds(u, 1, 1);
      m.setBounds(q, fixed.qty, fixed.qty);
    } else {
      const tiers = sortedTiers(o);
      tiers.forEach((t, k) => {
        const lo = k === 0 ? 0 : t.minQty;
        const next = tiers[k + 1];
        const hi = Math.min(next ? next.minQty - 1 : i.qmax, i.qmax);
        if (hi < lo) return;
        const z = m.addVar(`z${idx}_${k}`, 0, 1, 'B');
        const y = m.addVar(`y${idx}_${k}`, 0, hi, 'I');
        m.addRow(null, [{ v: y, c: 1 }, { v: z, c: -lo }], '>=', 0);
        m.addRow(null, [{ v: y, c: 1 }, { v: z, c: -hi }], '<=', 0);
        co.tiers.push({ z, y, unit: t.unit.minor });
        pushCost(o.id, { v: y, c: t.unit.minor });
      });
      m.addRow(null, [...co.tiers.map((t) => ({ v: t.z, c: 1 })), { v: u, c: -1 }], '=', 0);
      m.addRow(null, [...co.tiers.map((t) => ({ v: t.y, c: 1 })), { v: q, c: -1 }], '=', 0);
      if (o.setupFee.minor) pushCost(o.id, { v: u, c: o.setupFee.minor });
    }

    const firstUnit = sortedTiers(o)[0]?.unit.minor ?? 0;
    const addSlack = (field: NegotiableField, max: number, type: 'C' | 'I', unit: Slack['unit'], perUnitEstimate: number): string => {
      const sv = m.addVar(`x${idx}_${field}`, 0, max, type);
      const dv = m.addVar(`d${idx}_${field}`, 0, 1, 'B');
      m.addRow(null, [{ v: sv, c: 1 }, { v: dv, c: -max }], '<=', 0);
      slacks.push({ key: `${o.id}:${field}`, target: { kind: 'offer', offer: o.id, field }, slack: sv, change: dv, unit, perUnitEstimate, offer: co, weight: 1, max });
      return sv;
    };

    if (on(capId)) {
      const terms: Term[] = [{ v: q, c: 1 }, { v: u, c: -capacity }];
      if (flex.has('capacity') && demand > 0) terms.push({ v: addSlack('capacity', demand, 'I', 'units', ESTIMATES.capacityPremium * firstUnit), c: -1 });
      m.addRow(capId, terms, '<=', 0);
    }
    if (moqId && on(moqId) && !fixed) {
      const terms: Term[] = [{ v: q, c: 1 }, { v: u, c: -o.minQty }];
      if (flex.has('minQty')) terms.push({ v: addSlack('minQty', o.minQty, 'I', 'units', ESTIMATES.minQtyPerUnit * firstUnit), c: 1 });
      m.addRow(moqId, terms, '>=', 0);
    }
    if (on(winId)) {
      const ws = hours(ms(o.window.start));
      const we = hours(ms(o.window.end));
      const hourValue = ESTIMATES.windowPerHour * o.ratePerHour * firstUnit;
      const m1 = Math.max(0, ws - lb(s));
      const startTerms: Term[] = [{ v: s, c: 1 }, { v: u, c: -m1 }];
      if (flex.has('windowStart')) startTerms.push({ v: addSlack('windowStart', MAX_SHIFT_HOURS, 'C', 'hours', hourValue), c: 1 });
      m.addRow(winId, startTerms, '>=', ws - m1);
      const m2 = Math.max(0, ub(e) - we);
      const endTerms: Term[] = [{ v: e, c: 1 }, { v: u, c: m2 }];
      if (flex.has('windowEnd')) endTerms.push({ v: addSlack('windowEnd', MAX_SHIFT_HOURS, 'C', 'hours', hourValue), c: -1 });
      m.addRow(winId, endTerms, '<=', we + m2);
    }
    if (!fixed && flex.has('unitPrice')) {
      const maxCost = i.qmax * Math.max(...co.tiers.map((t) => t.unit), 0);
      if (maxCost > 0) {
        const D = addSlack('unitPrice', Math.ceil(MAX_PRICE_CUT * maxCost), 'C', 'minor', 1);
        m.addRow(null, [{ v: D, c: 1 }, ...co.tiers.map((t) => ({ v: t.y, c: -MAX_PRICE_CUT * t.unit }))], '<=', 0);
        pushCost(o.id, { v: D, c: -1 });
      }
    }
    if (!fixed && flex.has('setupFee') && o.setupFee.minor > 0) {
      const S = addSlack('setupFee', o.setupFee.minor, 'I', 'minor', 1);
      m.addRow(null, [{ v: S, c: 1 }, { v: u, c: -o.setupFee.minor }], '<=', 0);
      pushCost(o.id, { v: S, c: -1 });
    }
    if (opts.baseline && !fixed) {
      const b = baseline.get(o.id);
      if (b) {
        const chg = m.addVar(`g${idx}`, 0, 1, 'B');
        m.addRow(null, [{ v: q, c: 1 }, { v: chg, c: -Math.max(i.qmax, 1) }], '<=', b.qty);
        m.addRow(null, [{ v: q, c: 1 }, { v: chg, c: b.qty }], '>=', b.qty);
        changeTerms.push({ v: chg, c: 1 });
      } else {
        changeTerms.push({ v: u, c: 1 });
      }
    }
  }

  const byOffer = new Map(offers.map((c) => [c.offer.id, c]));
  const candidates: CompiledCandidate[] = candidateOffers.flatMap(({ coalition, offer }) => {
    const co = byOffer.get(offer.id)!;
    if (!co.possible) return [];
    const shape = parseCoalition(offer.id)!;
    const estimate = Math.round(shape.members.reduce((acc, id) => acc + ESTIMATES.jointPerMember * (byOffer.get(id)?.offer.setupFee.minor ?? 0), 0));
    return [{ coalition, offer: co, members: shape.members, estimate }];
  });
  // A member offer's capacity serves one job at a time: its own order or one joint offer that uses it.
  const sharing = new Map<string, CompiledOffer[]>();
  for (const co of offers) {
    const shape = parseCoalition(co.offer.id);
    if (!shape || !co.usable) continue;
    for (const memId of shape.members) sharing.set(memId, [...(sharing.get(memId) ?? []), co]);
  }
  for (const [memId, joints] of sharing) {
    const member = byOffer.get(memId);
    const users = [...(member?.usable ? [member] : []), ...joints];
    if (users.length < 2) continue;
    const who = name(member?.offer.actor ?? memId);
    const id = ref(`exclusive:${memId}`, 'exclusive-resource', `${who}'s capacity can serve only one of these jobs: its own order or one joint offer.`, memId);
    if (!on(id)) continue;
    const live = users.filter((x) => x.possible);
    if (live.length >= 2) m.addRow(id, live.map((x) => ({ v: x.u, c: 1 })), '<=', 1);
  }

  const stages: CompiledStage[] = world.stages.map((st, k) => {
    const live = offers.filter((c) => c.offer.stage === st.id && c.possible);
    const lo = Math.min(ready.get(st.id) ?? 0, big);
    const hi = live.length ? Math.max(lo, ...live.map((c) => ub(c.e) + c.offer.handoffHours)) : lo;
    const r = m.addVar(`R${k}`, Math.max(0, lo), Math.max(0, hi), 'C');
    return { stage: st, demand: demandOf.get(st.id) ?? 0, ready: r, terminal: terminals.has(st.id) };
  });
  const stageInfo = new Map(stages.map((s) => [s.stage.id, s]));
  for (const cs of stages) {
    const usable = offers.filter((c) => c.offer.stage === cs.stage.id && c.usable);
    const live = usable.filter((c) => c.possible);
    for (const c of live) {
      const M = Math.max(0, ub(c.e) + c.offer.handoffHours - lb(cs.ready));
      m.addRow(null, [{ v: cs.ready, c: 1 }, { v: c.e, c: -1 }, { v: c.u, c: -M }], '>=', c.offer.handoffHours - M);
    }
    if (cs.demand > 0) {
      const id = ref(`demand:${cs.stage.id}`, 'demand', `${cs.stage.name} must produce ${cs.demand} ${cs.stage.unit}.`, cs.stage.id);
      if (on(id)) {
        if (live.length) m.addRow(id, live.map((c) => ({ v: c.q, c: 1 })), '>=', cs.demand);
        else m.addRow(id, [], '>=', cs.demand);
      }
    }
    for (const p of cs.stage.after) {
      const pred = stageInfo.get(p)!;
      const id = ref(`precedence:${p}>${cs.stage.id}`, 'precedence', `${cs.stage.name} can only start once ${pred.stage.name.toLowerCase()} output has arrived.`, cs.stage.id);
      if (!on(id)) continue;
      for (const c of live) {
        const M = Math.max(0, ub(pred.ready) - lb(c.s));
        m.addRow(id, [{ v: c.s, c: 1 }, { v: pred.ready, c: -1 }, { v: c.u, c: -M }], '>=', -M);
      }
    }
  }

  const endUb = Math.max(0, ...stages.filter((s) => s.terminal).map((s) => ub(s.ready)));
  const end = m.addVar('tend', 0, endUb, 'C');
  const finalUnit = stages.find((s) => s.terminal)?.stage.unit ?? 'units';
  const dlId = ref('deadline', 'deadline', `All ${intent.quantity} ${finalUnit} must be ready by ${fmtTime(intent.deadline)}.`);
  let dSlack: string | null = null;
  if (elastic.intent && (intent.negotiable.deadlineHours ?? 0) > 0) {
    const max = intent.negotiable.deadlineHours!;
    dSlack = m.addVar('xi_deadline', 0, max, 'C');
    const dv = m.addVar('di_deadline', 0, 1, 'B');
    m.addRow(null, [{ v: dSlack, c: 1 }, { v: dv, c: -max }], '<=', 0);
    slacks.push({ key: 'intent:deadline', target: { kind: 'intent', field: 'deadline' }, slack: dSlack, change: dv, unit: 'hours', perUnitEstimate: 0, weight: 1, max });
  }
  for (const cs of stages) {
    if (!cs.terminal) continue;
    m.addRow(null, [{ v: end, c: 1 }, { v: cs.ready, c: -1 }], '>=', 0);
    if (!on(dlId)) continue;
    const terms: Term[] = [{ v: cs.ready, c: 1 }];
    if (dSlack) terms.push({ v: dSlack, c: -1 });
    m.addRow(dlId, terms, '<=', deadlineH);
  }

  // Each stage must cover its demand on its own, so the cheapest way to do that bounds its spend.
  for (const cs of stages) {
    if (cs.demand <= 0 || !on(`demand:${cs.stage.id}`)) continue;
    const members = infos.filter((i) => i.o.stage === cs.stage.id && i.possible);
    if (!members.length || members.some((i) => i.fixed)) continue;
    const floor = cheapestCover(cs.demand, members.map((i) => ({
      minQ: i.minQ,
      qmax: i.qmax,
      setup: i.flex.has('setupFee') ? 0 : i.o.setupFee.minor,
      tiers: sortedTiers(i.o).map((t) => ({ minQty: t.minQty, unit: t.unit.minor * (i.flex.has('unitPrice') ? 1 - MAX_PRICE_CUT : 1) })),
    })));
    if (!Number.isFinite(floor) || floor <= 0) continue;
    const terms = members.flatMap((i) => costByOffer.get(i.o.id) ?? []);
    if (terms.length) m.addRow(null, terms, '>=', Math.floor(floor * (1 - 1e-9)));
  }

  const cap$ = spendCap(intent);
  const budgetText =
    cap$ < intent.budget.minor
      ? `Total spend must stay within your spending authority of ${fmtMoney({ currency, minor: cap$ })}.`
      : `Total spend must stay within ${fmtMoney(intent.budget)}.`;
  const budgetId = ref('budget', 'budget', budgetText);
  if (on(budgetId)) {
    const terms = costTerms.slice();
    if (elastic.intent && (intent.negotiable.budgetMinor ?? 0) > 0) {
      const max = intent.negotiable.budgetMinor!;
      const bs = m.addVar('xi_budget', 0, max, 'I');
      const dv = m.addVar('di_budget', 0, 1, 'B');
      m.addRow(null, [{ v: bs, c: 1 }, { v: dv, c: -max }], '<=', 0);
      slacks.push({ key: 'intent:budget', target: { kind: 'intent', field: 'budget' }, slack: bs, change: dv, unit: 'minor', perUnitEstimate: 1, weight: 1, max });
      terms.push({ v: bs, c: -1 });
    }
    m.addRow(budgetId, terms, '<=', spendCap(intent) - costConstant);
  }

  return { world, intent, model: m, refs, offers, stages, candidates, slacks, t0, costTerms, costConstant, changeTerms, end, now };
}

interface CoverOption {
  minQ: number;
  qmax: number;
  setup: number;
  tiers: { minQty: number; unit: number }[];
}

/**
 * Least cost to produce at least `need` units from the given offers, each used at most once with
 * all-units tier pricing and a setup fee. Dynamic programme over quantity with a sliding-window
 * minimum per tier, so each offer costs O(need) per tier.
 */
export function cheapestCover(need: number, options: CoverOption[]): number {
  let f = new Float64Array(need + 1).fill(Infinity);
  f[0] = 0;
  for (const o of options) {
    const next = Float64Array.from(f);
    o.tiers.forEach((t, k) => {
      const lo = Math.max(k === 0 ? 0 : t.minQty, o.minQ, 1);
      const nextTier = o.tiers[k + 1];
      const hi = Math.min(nextTier ? nextTier.minQty - 1 : o.qmax, o.qmax);
      if (hi < lo) return;
      const c = t.unit;
      const deque: number[] = [];
      let added = 0;
      for (let j = 1; j <= need; j++) {
        while (added <= j - lo) {
          const g = f[added]! - c * added;
          while (deque.length && f[deque[deque.length - 1]!]! - c * deque[deque.length - 1]! >= g) deque.pop();
          deque.push(added);
          added++;
        }
        while (deque.length && deque[0]! < j - hi) deque.shift();
        let best = Infinity;
        if (deque.length) best = f[deque[0]!]! - c * deque[0]! + c * j + o.setup;
        if (j <= hi) best = Math.min(best, c * Math.max(lo, j) + o.setup);
        if (best < next[j]!) next[j] = best;
      }
    });
    f = next;
  }
  return f[need]!;
}

export function toLP(c: Compiled): string {
  return c.model.toLP();
}
