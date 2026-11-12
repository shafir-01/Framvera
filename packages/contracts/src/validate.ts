import type { Id, Intent, Iso, Money, NegotiableField, Offer, Plan, Stage, StageId, World } from './types.ts';
import { add, allocate, money, mul, zero } from './money.ts';

const HOUR = 3_600_000;
/** Scheduling comparisons tolerate one minute of rounding in ISO timestamps. */
export const TIME_TOLERANCE_HOURS = 1 / 60;

const NEGOTIABLE: readonly NegotiableField[] = ['unitPrice', 'windowEnd', 'windowStart', 'capacity', 'minQty', 'setupFee', 'joint'];
const CURRENCIES = new Set(['SEK', 'USD', 'EUR']);
const ACTOR_KINDS = new Set(['buyer', 'supplier', 'logistics', 'platform']);
const SOURCES = new Set(['synthetic-market', 'seller-terminal', 'buyer', 'model-proposal', 'solver', 'paypal-sandbox', 'external-catalog']);
const TIERS = new Set(['verified', 'corroborated', 'single-claim', 'simulation-only']);
/** Keys that only exist in private supplier truth. Their presence in a World is a leak. */
export const TRUTH_KEYS: readonly string[] = ['policies', 'realCapacity', 'shocks', 'reservation', 'riskTolerance', 'outside', 'premium', 'certificate', 'maxExtensionHours', 'maxOvertimeUnits', 'floor', 'truth'];

// ---------- time ----------
export function isIso(s: unknown): s is Iso {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(s) && !Number.isNaN(Date.parse(s));
}
export function toMs(iso: Iso): number {
  return Date.parse(iso);
}
export function hoursBetween(a: Iso, b: Iso): number {
  return (Date.parse(b) - Date.parse(a)) / HOUR;
}
export function addHours(iso: Iso, h: number): Iso {
  return new Date(Date.parse(iso) + Math.round(h * HOUR)).toISOString();
}

// ---------- offer economics (shared semantics for solver, checker and verifier) ----------
/** Price per unit for an order of qty: the highest tier whose minQty is at or below qty. */
export function unitPrice(offer: Offer, qty: number): Money {
  let chosen = offer.tiers[0];
  for (const t of offer.tiers) if (t.minQty <= qty) chosen = t;
  if (!chosen) throw new Error(`Offer ${offer.id} has no price tiers`);
  return chosen.unit;
}

/** Setup fee plus tiered unit price times quantity. Zero quantity costs nothing. */
export function offerCost(offer: Offer, qty: number): Money {
  if (qty <= 0) return zero(offer.setupFee.currency);
  return add(offer.setupFee, mul(unitPrice(offer, qty), qty));
}

/** Hours of work for qty units at the offer's rate. */
export function workHours(offer: Offer, qty: number): number {
  return qty / offer.ratePerHour;
}

/**
 * Units an offer can really be allocated: its claimed capacity minus capacity
 * already committed elsewhere, as recorded by verified or corroborated
 * `booked:<offerId>` claims in the world.
 */
export function effectiveCapacity(world: World, offer: Offer): number {
  let booked = 0;
  for (const c of world.claims) {
    if (c.subject === `booked:${offer.id}` && (c.tier === 'verified' || c.tier === 'corroborated')) booked += c.value ?? 0;
  }
  return Math.max(0, offer.capacity - booked);
}

/** An offer may be planned when its actor is active and it has not expired at the world's market clock. */
export function isUsable(world: World, offer: Offer): boolean {
  const actor = world.actors.find((a) => a.id === offer.actor);
  return !!actor && actor.active && toMs(offer.validUntil) >= toMs(world.createdAt);
}

export function stageNeed(stage: Stage, intent: Intent): number {
  return Math.ceil(intent.quantity * stage.perOutcome - 1e-9);
}

/** Stages no other stage waits on: their output is the delivered outcome. */
export function sinkStages(world: World): Stage[] {
  const feeding = new Set(world.stages.flatMap((s) => s.after));
  return world.stages.filter((s) => !feeding.has(s.id));
}

export function topoOrder(stages: readonly Stage[]): Stage[] | null {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const out: Stage[] = [];
  const state = new Map<StageId, 1 | 2>();
  const visit = (s: Stage): boolean => {
    const st = state.get(s.id);
    if (st === 2) return true;
    if (st === 1) return false;
    state.set(s.id, 1);
    for (const p of s.after) {
      const ps = byId.get(p);
      if (ps && !visit(ps)) return false;
    }
    state.set(s.id, 2);
    out.push(s);
    return true;
  };
  for (const s of stages) if (!visit(s)) return null;
  return out;
}

// ---------- joint offers (coalitions) ----------
export const JOINT_PREFIX = 'joint:';

/** Member offer ids of a joint offer id: joint:shared:<capacity>><operator>, joint:batch:<a>+<b>, or joint:<a>+<b>. */
export function jointMembers(offerId: Id): Id[] | null {
  if (!offerId.startsWith(JOINT_PREFIX)) return null;
  const body = offerId.slice(JOINT_PREFIX.length).replace(/^(shared|batch):/, '');
  return body.split(/[>+]/).filter(Boolean);
}

const firstUnit = (o: Offer): number => [...o.tiers].sort((a, b) => a.minQty - b.minQty)[0]?.unit.minor ?? 0;

/**
 * The capability two suppliers create by sharing one vehicle or line: the larger
 * member's capacity, run inside the operator's window (the member available
 * latest) at the operator's rate and handoff. Every member's setup fee is paid and
 * the unit price is the highest member's first-tier price. Members must share a
 * stage and each must list 'joint' as negotiable. Id: joint:shared:<capacity>><operator>.
 */
export function composeJoint(members: readonly Offer[], coalition: Id, observedAt: Iso): Offer {
  if (members.length < 2) throw new Error('A joint offer needs at least two members');
  const stage = members[0]!.stage;
  const actors = new Set<Id>();
  for (const m of members) {
    if (m.stage !== stage) throw new Error(`Joint members must share a stage: ${m.id}`);
    if (!m.negotiable.includes('joint')) throw new Error(`Offer ${m.id} is not open to joint work`);
    if (actors.has(m.actor)) throw new Error(`Actor ${m.actor} appears twice in a joint offer`);
    actors.add(m.actor);
  }
  const vehicle = members.reduce((best, m) => (m.capacity > best.capacity ? m : best));
  const crew = members.reduce((best, m) => (toMs(m.window.end) > toMs(best.window.end) ? m : best));
  const currency = crew.setupFee.currency;
  const id =
    members.length === 2 && vehicle !== crew ? `${JOINT_PREFIX}shared:${vehicle.id}>${crew.id}` : JOINT_PREFIX + members.map((m) => m.id).join('+');
  return {
    id,
    version: 1,
    actor: crew.actor,
    stage,
    capacity: vehicle.capacity,
    minQty: Math.max(...members.map((m) => m.minQty)),
    ratePerHour: crew.ratePerHour,
    setupFee: members.reduce((s, m) => add(s, m.setupFee), zero(currency)),
    tiers: [{ minQty: 0, unit: money(currency, Math.max(...members.map(firstUnit))) }],
    window: { ...crew.window },
    handoffHours: crew.handoffHours,
    validUntil: members.reduce((v, m) => (toMs(m.validUntil) < toMs(v) ? m.validUntil : v), crew.validUntil),
    negotiable: [],
    provenance: { source: 'solver', observedAt, ref: coalition },
    claims: [...new Set(members.flatMap((m) => m.claims))],
    derivedFrom: { concessions: [], coalition },
  };
}

/**
 * Default split of a joint offer's payment for qty units: every member keeps its
 * own setup fee and the per-unit revenue is shared by the members' first-tier
 * unit prices. Sums exactly to offerCost of the composed offer.
 */
export function jointShares(members: readonly Offer[], qty: number): { actor: Id; offer: Id; share: Money }[] {
  const currency = members[0]!.setupFee.currency;
  const unit = Math.max(...members.map(firstUnit));
  const revenue = allocate(money(currency, unit * qty), members.map(firstUnit));
  return members.map((m, i) => ({ actor: m.actor, offer: m.id, share: add(m.setupFee, revenue[i]!) }));
}

// ---------- validators ----------
function checkMoney(m: unknown, currency: string, where: string, errs: string[]): void {
  const mm = m as Money | undefined;
  if (!mm || typeof mm !== 'object') return void errs.push(`${where}: missing money`);
  if (!CURRENCIES.has(mm.currency)) errs.push(`${where}: invalid currency ${String(mm.currency)}`);
  else if (mm.currency !== currency) errs.push(`${where}: currency ${mm.currency} differs from ${currency}`);
  if (!Number.isSafeInteger(mm.minor)) errs.push(`${where}: minor must be an integer`);
  else if (mm.minor < 0) errs.push(`${where}: amount must not be negative`);
}

function findTruthKeys(v: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 12 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) return v.forEach((x, i) => findTruthKeys(x, `${path}[${i}]`, out, depth + 1));
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (TRUTH_KEYS.includes(k)) out.push(`${path}.${k}`);
    findTruthKeys(x, `${path}.${k}`, out, depth + 1);
  }
}

export function validateWorld(w: World): string[] {
  const errs: string[] = [];
  if (!w || typeof w !== 'object') return ['world: not an object'];
  if (!CURRENCIES.has(w.currency)) errs.push(`world: invalid currency ${String(w.currency)}`);
  if (!Number.isInteger(w.version) || w.version < 1) errs.push('world: version must be a positive integer');
  if (!Number.isInteger(w.seed)) errs.push('world: seed must be an integer');
  if (!isIso(w.createdAt)) errs.push('world: createdAt must be UTC ISO');
  const leaks: string[] = [];
  findTruthKeys(w, 'world', leaks);
  for (const l of leaks) errs.push(`${l}: private supplier truth must not appear in a world`);

  const dup = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errs.push(`${kind} ${id}: duplicate id`);
      seen.add(id);
    }
    return seen;
  };
  const stageIds = dup('stage', w.stages.map((s) => s.id));
  const actorIds = dup('actor', w.actors.map((a) => a.id));
  const claimIds = dup('claim', w.claims.map((c) => c.id));
  dup('offer', w.offers.map((o) => o.id));
  if (w.stages.length === 0) errs.push('world: no stages');

  for (const s of w.stages) {
    for (const p of s.after) if (!stageIds.has(p)) errs.push(`stage ${s.id}: depends on unknown stage ${p}`);
    if (!(s.perOutcome > 0)) errs.push(`stage ${s.id}: perOutcome must be positive`);
  }
  if (!topoOrder(w.stages)) errs.push('stages: dependency cycle');

  for (const a of w.actors) {
    if (!ACTOR_KINDS.has(a.kind)) errs.push(`actor ${a.id}: invalid kind ${String(a.kind)}`);
    if (typeof a.description !== 'string') errs.push(`actor ${a.id}: description must be text`);
  }

  for (const o of w.offers) {
    const at = `offer ${o.id}`;
    if (!actorIds.has(o.actor)) errs.push(`${at}: unknown actor ${o.actor}`);
    if (!stageIds.has(o.stage)) errs.push(`${at}: unknown stage ${o.stage}`);
    if (!Number.isInteger(o.capacity) || o.capacity < 0) errs.push(`${at}: capacity must be a non-negative integer`);
    if (!Number.isInteger(o.minQty) || o.minQty < 0) errs.push(`${at}: minQty must be a non-negative integer`);
    if (o.minQty > o.capacity) errs.push(`${at}: minQty exceeds capacity`);
    if (!(o.ratePerHour > 0)) errs.push(`${at}: ratePerHour must be positive`);
    if (!(o.handoffHours >= 0)) errs.push(`${at}: handoffHours must not be negative`);
    checkMoney(o.setupFee, w.currency, `${at} setupFee`, errs);
    if (!o.tiers?.length) errs.push(`${at}: needs at least one price tier`);
    o.tiers?.forEach((t, i) => {
      checkMoney(t.unit, w.currency, `${at} tier ${i}`, errs);
      if (i > 0 && t.minQty <= o.tiers[i - 1]!.minQty) errs.push(`${at}: tiers must be sorted by ascending minQty`);
    });
    if (o.tiers?.[0] && o.tiers[0].minQty > Math.max(o.minQty, 0)) errs.push(`${at}: first tier must start at 0 or minQty`);
    if (!isIso(o.window?.start) || !isIso(o.window?.end)) errs.push(`${at}: window must be UTC ISO`);
    else if (toMs(o.window.start) >= toMs(o.window.end)) errs.push(`${at}: window start must precede end`);
    if (!isIso(o.validUntil)) errs.push(`${at}: validUntil must be UTC ISO`);
    for (const f of o.negotiable) if (!NEGOTIABLE.includes(f)) errs.push(`${at}: unknown negotiable field ${String(f)}`);
    for (const c of o.claims) if (!claimIds.has(c)) errs.push(`${at}: unknown claim ${c}`);
    if (!SOURCES.has(o.provenance?.source)) errs.push(`${at}: invalid provenance source`);
  }

  for (const c of w.claims) {
    if (!actorIds.has(c.actor)) errs.push(`claim ${c.id}: unknown actor ${c.actor}`);
    if (!TIERS.has(c.tier)) errs.push(`claim ${c.id}: invalid evidence tier`);
    for (const x of c.contradictedBy ?? []) if (!claimIds.has(x)) errs.push(`claim ${c.id}: contradicted by unknown claim ${x}`);
  }
  return errs;
}

export function validateIntent(i: Intent): string[] {
  const errs: string[] = [];
  if (!i || typeof i !== 'object') return ['intent: not an object'];
  if (!Number.isInteger(i.quantity) || i.quantity <= 0) errs.push('intent: quantity must be a positive integer');
  checkMoney(i.budget, i.budget?.currency, 'intent budget', errs);
  if (!isIso(i.deadline)) errs.push('intent: deadline must be UTC ISO');
  if (typeof i.deliverTo !== 'string' || !i.deliverTo) errs.push('intent: deliverTo is required');
  if (i.negotiable?.deadlineHours !== undefined && !(i.negotiable.deadlineHours >= 0)) errs.push('intent: negotiable deadlineHours must not be negative');
  if (i.negotiable?.budgetMinor !== undefined && !(Number.isSafeInteger(i.negotiable.budgetMinor) && i.negotiable.budgetMinor >= 0)) {
    errs.push('intent: negotiable budgetMinor must be a non-negative integer');
  }
  if (!i.authority) errs.push('intent: authority is required');
  else {
    checkMoney(i.authority.maxSpend, i.budget?.currency, 'intent authority maxSpend', errs);
    for (const k of ['mayNegotiate', 'mayReserve', 'mayPreparePayments'] as const) {
      if (typeof i.authority[k] !== 'boolean') errs.push(`intent: authority.${k} must be boolean`);
    }
  }
  if (!SOURCES.has(i.provenance?.source)) errs.push('intent: invalid provenance source');
  return errs;
}

/**
 * Independent arithmetic re-check of a plan against the world and intent:
 * offers exist and are usable, quantities within minimum and effective capacity,
 * costs match the tiers, work fits each window, stage precedence holds, every
 * stage meets demand, coalition members are not also booked alone, and the total
 * respects the deadline, the budget and the spending authority.
 */
export function validatePlan(p: Plan, w: World, intent: Intent): string[] {
  const errs: string[] = [];
  const tol = TIME_TOLERANCE_HOURS;
  const offers = new Map(w.offers.map((o) => [o.id, o]));
  const stages = new Map(w.stages.map((s) => [s.id, s]));
  const produced = new Map<StageId, number>();
  const ready = new Map<StageId, number>();
  const used = new Map<Id, number>();
  let total = zero(w.currency);

  for (const a of p.allocations) {
    const at = `allocation ${a.offer}`;
    const o = offers.get(a.offer);
    if (!o) {
      errs.push(`${at}: offer does not exist in world version ${w.version}`);
      continue;
    }
    if (o.actor !== a.actor) errs.push(`${at}: actor ${a.actor} does not own the offer`);
    if (o.stage !== a.stage) errs.push(`${at}: stage ${a.stage} differs from offer stage ${o.stage}`);
    if (!isUsable(w, o)) errs.push(`${at}: offer is not usable (inactive actor or expired)`);
    if (!Number.isInteger(a.qty) || a.qty <= 0) errs.push(`${at}: quantity must be a positive integer`);
    if (a.qty < o.minQty) errs.push(`${at}: ${a.qty} is below the minimum of ${o.minQty}`);
    used.set(o.id, (used.get(o.id) ?? 0) + a.qty);
    const expected = offerCost(o, a.qty);
    if (a.cost.currency !== expected.currency || a.cost.minor !== expected.minor) {
      errs.push(`${at}: cost ${a.cost.minor} differs from tier price ${expected.minor}`);
    }
    total = add(total, a.cost.currency === w.currency ? a.cost : money(w.currency, 0));
    if (!isIso(a.start) || !isIso(a.finish)) {
      errs.push(`${at}: start and finish must be UTC ISO`);
      continue;
    }
    const startH = toMs(a.start) / HOUR;
    const doneH = startH + workHours(o, a.qty);
    const finishH = toMs(a.finish) / HOUR;
    if (startH < toMs(o.window.start) / HOUR - tol) errs.push(`${at}: starts before the offer window opens`);
    if (doneH > toMs(o.window.end) / HOUR + tol) errs.push(`${at}: work runs past the offer window`);
    if (Math.abs(finishH - (doneH + o.handoffHours)) > tol) errs.push(`${at}: finish must equal start + work hours + handoff`);
    const stage = stages.get(a.stage);
    for (const pred of stage?.after ?? []) {
      for (const b of p.allocations) {
        if (b.stage === pred && isIso(b.finish) && toMs(b.finish) / HOUR > startH + tol) {
          errs.push(`${at}: starts before ${pred} output from ${b.offer} is ready`);
        }
      }
    }
    produced.set(a.stage, (produced.get(a.stage) ?? 0) + a.qty);
    ready.set(a.stage, Math.max(ready.get(a.stage) ?? -Infinity, finishH));
  }

  for (const [id, qty] of used) {
    const o = offers.get(id)!;
    const cap = effectiveCapacity(w, o);
    if (qty > cap) errs.push(`offer ${id}: ${qty} allocated exceeds effective capacity ${cap}`);
    const members = jointMembers(id);
    if (members) for (const m of members) if (used.has(m)) errs.push(`offer ${m}: booked alone and inside joint offer ${id}`);
  }
  for (const s of w.stages) {
    const need = stageNeed(s, intent);
    const got = produced.get(s.id) ?? 0;
    if (got < need) errs.push(`stage ${s.id}: ${got} produced, ${need} needed`);
  }
  const readyAt = Math.max(...sinkStages(w).map((s) => ready.get(s.id) ?? Infinity));
  if (readyAt > toMs(intent.deadline) / HOUR + tol) errs.push('plan: final output is ready after the deadline');
  if (isIso(p.readyAt) && Math.abs(toMs(p.readyAt) / HOUR - readyAt) > tol) errs.push('plan: readyAt differs from the final allocations');
  if (p.total.currency !== total.currency || p.total.minor !== total.minor) errs.push(`plan: total ${p.total.minor} differs from allocation sum ${total.minor}`);
  if (total.minor > intent.budget.minor) errs.push(`plan: total ${total.minor} exceeds budget ${intent.budget.minor}`);
  if (total.minor > intent.authority.maxSpend.minor) errs.push('plan: total exceeds spending authority');
  if (p.worldVersion !== w.version) errs.push(`plan: built for world version ${p.worldVersion}, world is ${w.version}`);
  return errs;
}
