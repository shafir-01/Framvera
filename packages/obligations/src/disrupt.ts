import type { Agreement, Disruption, Id, Obligation, Offer, PaymentIntent, World } from '@framvera/contracts';
import { LIVE_OBLIGATION, moveObligation } from './agreement.ts';
import { allocationCost, coalitionMembers, downstreamStages, required, topoStages, uniqueJobs, workMs } from './model.ts';
import { HOUR, MINUTE, iso, ms } from './util.ts';

export interface DisruptionParams {
  capacity?: number;
  delayHours?: number;
  unitPriceMinor?: number;
  pricePercent?: number;
  claim?: Id;
}

/** Structured parameters if present, otherwise read from the disruption's detail text. */
export function paramsOf(d: Disruption, world?: World): DisruptionParams {
  const given = (d as Disruption & { params?: DisruptionParams }).params ?? {};
  const text = d.detail ?? '';
  const out: DisruptionParams = { ...given };
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m?.[1] ? Number(m[1].replace(',', '.')) : undefined;
  };
  if (d.kind === 'capacity-drop' && out.capacity === undefined) out.capacity = num(/(\d+)/);
  if (d.kind === 'delay' && out.delayHours === undefined) {
    const h = num(/(\d+(?:[.,]\d+)?)\s*(?:h\b|hours?|tim)/i);
    const days = num(/(\d+(?:[.,]\d+)?)\s*(?:d\b|days?|dag)/i);
    out.delayHours = h ?? (days !== undefined ? days * 24 : undefined);
  }
  if (d.kind === 'price-change' && out.unitPriceMinor === undefined && out.pricePercent === undefined) {
    out.pricePercent = num(/([+-]?\d+(?:[.,]\d+)?)\s*%/);
    if (out.pricePercent === undefined) {
      const major = num(/(\d+(?:[.,]\d+)?)\s*(?:kr|sek|usd|eur)/i);
      if (major !== undefined) out.unitPriceMinor = Math.round(major * 100);
    }
  }
  if (d.kind === 'claim-overturned' && out.claim === undefined && world) {
    out.claim = world.claims.find((c) => text.includes(c.id))?.id ?? world.claims.find((c) => d.offer && c.subject.includes(d.offer))?.id;
    if (out.capacity === undefined) out.capacity = num(/capacity[^\d]*(\d+)/i);
  }
  return out;
}

const marker = (d: Disruption) => `disruption:${d.id}`;

function targets(world: World, d: Disruption, p: DisruptionParams): Offer[] {
  let direct: Offer[] = [];
  if (d.kind === 'claim-overturned' && p.claim) direct = world.offers.filter((o) => o.claims.includes(p.claim!) || o.id === d.offer);
  else if (d.offer) direct = world.offers.filter((o) => o.id === d.offer);
  else if (d.actor) direct = world.offers.filter((o) => o.actor === d.actor);
  if (d.kind !== 'withdraw' && d.kind !== 'claim-overturned') return direct;
  const ids = new Set(direct.map((o) => o.id));
  const joint = world.offers.filter((o) => !ids.has(o.id) && (coalitionMembers(o.id) ?? []).some((m) => ids.has(m)));
  return [...direct, ...joint];
}

export interface Applied {
  world: World;
  hit: Id[];
  removed: Id[];
}

/** Applies a disruption to the world. Pure and idempotent: offers carry the disruption id in their provenance. */
export function applyDisruption(world: World, d: Disruption): Applied {
  const p = paramsOf(d, world);
  const hit = targets(world, d, p);
  const hitIds = new Set(hit.map((o) => o.id));
  const removeAll = d.kind === 'withdraw' || (d.kind === 'claim-overturned' && p.capacity === undefined);
  if (removeAll) {
    const removed = [...hitIds];
    const actors = d.kind === 'withdraw' && d.actor && !d.offer ? world.actors.map((a) => (a.id === d.actor ? { ...a, active: false } : a)) : world.actors;
    const claims =
      d.kind === 'claim-overturned' && p.claim
        ? world.claims.map((c) => (c.id === p.claim && !c.contradictedBy?.includes(d.id) ? { ...c, contradictedBy: [...(c.contradictedBy ?? []), d.id] } : c))
        : world.claims;
    const changed = removed.length > 0 || actors !== world.actors;
    return {
      world: changed ? { ...world, version: world.version + 1, actors, claims, offers: world.offers.filter((o) => !hitIds.has(o.id)) } : world,
      hit: removed,
      removed,
    };
  }
  if (d.kind === 'payment-failed') return { world, hit: [], removed: [] };
  let changed = false;
  const offers = world.offers.map((o) => {
    if (!hitIds.has(o.id) || o.provenance.ref === marker(d)) return o;
    changed = true;
    const provenance = { ...o.provenance, observedAt: d.at, ref: marker(d) };
    if (d.kind === 'capacity-drop' || d.kind === 'claim-overturned') return { ...o, provenance, capacity: Math.min(o.capacity, Math.max(0, p.capacity ?? 0)) };
    if (d.kind === 'delay') return { ...o, provenance, handoffHours: o.handoffHours + (p.delayHours ?? 0) };
    if (d.kind === 'price-change') {
      const tiers = o.tiers.map((t) => ({
        ...t,
        unit: { ...t.unit, minor: p.unitPriceMinor ?? Math.round(t.unit.minor * (1 + (p.pricePercent ?? 0) / 100)) },
      }));
      return { ...o, provenance, tiers };
    }
    return o;
  });
  return { world: changed ? { ...world, version: world.version + 1, offers } : world, hit: [...hitIds], removed: [] };
}

export type Severity = 'failed' | 'must-change' | 'at-risk';

export interface ImpactNode {
  id: Id;
  kind: 'disruption' | 'offer' | 'obligation' | 'payment';
  severity?: Severity | 'refund-or-void' | 'hold';
  label: string;
}
export interface ImpactEdge {
  from: Id;
  to: Id;
  kind: 'direct' | 'precedence' | 'payment';
}

export interface Impact {
  world: World;
  failed: Obligation[];
  mustChange: Obligation[];
  atRisk: Obligation[];
  /** Failed plus must-change: obligations whose current terms no permissible recovery can keep. */
  affected: Obligation[];
  endangeredPayments: { payment: Id; severity: 'refund-or-void' | 'hold'; obligations: Id[] }[];
  graph: { nodes: ImpactNode[]; edges: ImpactEdge[] };
  /** Earliest moment the replacement output of each disrupted stage could possibly be ready (a lower bound). */
  readyBound: Record<string, string | null>;
  removedOffers: Id[];
}

export interface ImpactOptions {
  payments?: PaymentIntent[];
  reservedElsewhere?: Map<Id, number>;
  notBefore?: number;
}

const live = (a: Agreement) => a.obligations.filter((o) => LIVE_OBLIGATION.includes(o.state));

/** New work cannot start before the disruption is known, when the disruption falls inside the agreement's timeline. */
export function defaultNotBefore(a: Agreement, d: Disruption): number | undefined {
  const at = Date.parse(d.at);
  const lastDue = Math.max(-Infinity, ...live(a).map((o) => ms(o.due)));
  return Number.isFinite(at) && at < lastDue ? at : undefined;
}

function failedObligations(a: Agreement, world: World, d: Disruption, applied: Applied, reserved: Map<Id, number>): Set<Id> {
  const out = new Set<Id>();
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const hit = new Set(applied.hit);
  const obligations = live(a);
  const inactive = new Set(world.actors.filter((x) => !x.active).map((x) => x.id));
  for (const ob of obligations) {
    const offer = offers.get(ob.offer);
    const memberLeft = (coalitionMembers(ob.offer) ?? []).some((m) => {
      const mo = offers.get(m);
      return !!mo && inactive.has(mo.actor);
    });
    if (!offer || inactive.has(ob.actor) || memberLeft) {
      if (d.kind !== 'payment-failed') out.add(ob.id);
      continue;
    }
    if (!hit.has(ob.offer)) continue;
    if (d.kind === 'capacity-drop' || d.kind === 'claim-overturned') {
      const held = uniqueJobs(obligations.filter((x) => x.offer === ob.offer)).reduce((s, x) => s + x.qty, 0) + (reserved.get(ob.offer) ?? 0);
      if (held > offer.capacity) out.add(ob.id);
    } else if (d.kind === 'delay') {
      const minimal = ms(ob.start) + workMs(offer, ob.qty) + offer.handoffHours * HOUR;
      if (ms(ob.due) + MINUTE < minimal) out.add(ob.id);
    } else if (d.kind === 'price-change') {
      if (allocationCost(offer, ob.qty).minor > ob.amount.minor) out.add(ob.id);
    }
  }
  return out;
}

/** Earliest time `qty` units could be ready from these sources, ignoring cost and minimum quantities. */
function readyLowerBound(sources: { offer: Offer; spare: number }[], qty: number, earliest: number): number {
  if (qty <= 0) return -Infinity;
  const units = (t: number) =>
    sources.reduce((sum, { offer, spare }) => {
      const start = Math.max(ms(offer.window.start), earliest);
      const end = Math.min(t - offer.handoffHours * HOUR, ms(offer.window.end));
      return sum + Math.max(0, Math.min(spare, (offer.ratePerHour * (end - start)) / HOUR));
    }, 0);
  let hi = Math.max(earliest, ...sources.map(({ offer }) => ms(offer.window.end) + offer.handoffHours * HOUR)) + MINUTE;
  if (units(hi) < qty - 1e-9) return Infinity;
  let lo = earliest;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (units(mid) >= qty - 1e-9) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * Forward impact of a disruption on one agreement: failed obligations, dependents that provably must change
 * (even the fastest conceivable replacement is too late for them), dependents at risk, and endangered payments.
 */
export function impactOf(agreement: Agreement, world: World, d: Disruption, opts: ImpactOptions = {}): Impact {
  const applied = applyDisruption(world, d);
  const w2 = applied.world;
  const notBefore = opts.notBefore ?? defaultNotBefore(agreement, d);
  const reserved = opts.reservedElsewhere ?? new Map<Id, number>();
  const failed = failedObligations(agreement, w2, d, applied, reserved);
  const obligations = live(agreement);
  const offers = new Map(w2.offers.map((o) => [o.id, o]));
  const inactive = new Set(w2.actors.filter((a) => !a.active).map((a) => a.id));
  const mustChange = new Set<Id>();
  const readyLB = new Map<string, number>();
  const bound: Record<string, string | null> = {};
  const totalOutcome = outcomeQuantity(agreement, w2);
  const disruptedStages = new Set(obligations.filter((o) => failed.has(o.id)).map((o) => o.stage));
  for (const stage of topoStages(w2.stages)) {
    const predLB = Math.max(-Infinity, ...stage.after.map((p) => readyLB.get(p) ?? -Infinity));
    const inStage = obligations.filter((o) => o.stage === stage.id);
    const locked: Obligation[] = [];
    for (const o of inStage) {
      if (failed.has(o.id)) continue;
      if (ms(o.start) < predLB - MINUTE) mustChange.add(o.id);
      else locked.push(o);
    }
    let ready = Math.max(-Infinity, ...locked.map((o) => ms(o.due)));
    const changing = inStage.filter((o) => failed.has(o.id) || mustChange.has(o.id));
    if (changing.length) {
      const need = required(w2, stage, totalOutcome) - uniqueJobs(locked).reduce((s, o) => s + o.qty, 0);
      const usedByLocked = new Map<Id, number>();
      for (const o of uniqueJobs(obligations)) if (!failed.has(o.id) && !mustChange.has(o.id)) usedByLocked.set(o.offer, (usedByLocked.get(o.offer) ?? 0) + o.qty);
      const sources = w2.offers
        .filter((o) => o.stage === stage.id && !inactive.has(o.actor))
        .map((offer) => ({ offer, spare: offer.capacity - (usedByLocked.get(offer.id) ?? 0) - (reserved.get(offer.id) ?? 0) }))
        .filter((s) => s.spare > 0);
      const earliest = Math.max(predLB, notBefore ?? -8.64e15, -8.64e15);
      const t = readyLowerBound(sources, need, earliest);
      ready = Math.max(ready, t);
      if (t !== -Infinity) bound[stage.id] = Number.isFinite(t) ? iso(t) : null;
    }
    readyLB.set(stage.id, ready);
  }

  const failedStages = [...disruptedStages];
  const downstream = new Set<string>();
  for (const s of failedStages) for (const x of downstreamStages(w2.stages, s)) downstream.add(x);
  const atRisk = obligations.filter((o) => !failed.has(o.id) && !mustChange.has(o.id) && downstream.has(o.stage));

  const nodes: ImpactNode[] = [{ id: d.id, kind: 'disruption', label: d.detail }];
  const edges: ImpactEdge[] = [];
  for (const id of applied.hit) {
    nodes.push({ id, kind: 'offer', label: id });
    edges.push({ from: d.id, to: id, kind: 'direct' });
  }
  const severity = (o: Obligation): Severity | undefined =>
    failed.has(o.id) ? 'failed' : mustChange.has(o.id) ? 'must-change' : atRisk.includes(o) ? 'at-risk' : undefined;
  for (const o of obligations) {
    const s = severity(o);
    if (!s) continue;
    nodes.push({ id: o.id, kind: 'obligation', severity: s, label: `${o.stage}: ${o.qty} by ${o.actor}` });
    if (s === 'failed') edges.push({ from: applied.hit.includes(o.offer) ? o.offer : d.id, to: o.id, kind: 'direct' });
  }
  const flagged = obligations.filter((o) => severity(o));
  for (const o of flagged) {
    const stage = w2.stages.find((s) => s.id === o.stage);
    for (const up of flagged) if (stage?.after.includes(up.stage)) edges.push({ from: up.id, to: o.id, kind: 'precedence' });
  }
  const endangeredPayments: Impact['endangeredPayments'] = [];
  for (const p of opts.payments ?? []) {
    if (p.agreement !== agreement.id) continue;
    const hitIds = p.obligations.filter((id) => flagged.some((o) => o.id === id));
    if (!hitIds.length) continue;
    const sev = hitIds.some((id) => failed.has(id)) ? 'refund-or-void' : 'hold';
    endangeredPayments.push({ payment: p.id, severity: sev, obligations: hitIds });
    nodes.push({ id: p.id, kind: 'payment', severity: sev, label: `${p.state} ${p.amount.minor} ${p.amount.currency}` });
    for (const id of hitIds) edges.push({ from: id, to: p.id, kind: 'payment' });
  }

  const mark = (o: Obligation): Obligation =>
    failed.has(o.id) && (d.kind === 'withdraw' || !offers.has(o.offer) || inactive.has(o.actor)) ? moveObligation(o, 'BREACHED') : moveObligation(o, 'AT_RISK');
  const failedList = obligations.filter((o) => failed.has(o.id)).map(mark);
  const mustList = obligations.filter((o) => mustChange.has(o.id)).map((o) => moveObligation(o, 'AT_RISK'));
  return {
    world: w2,
    failed: failedList,
    mustChange: mustList,
    atRisk: atRisk.map((o) => moveObligation(o, 'AT_RISK')),
    affected: [...failedList, ...mustList],
    endangeredPayments,
    graph: { nodes, edges },
    readyBound: bound,
    removedOffers: [...new Set([...applied.removed, ...obligations.filter((o) => !offers.has(o.offer)).map((o) => o.offer)])],
  };
}

/** Outcome quantity the agreement provides for: the smallest stage coverage, in final units. */
export function outcomeQuantity(a: Agreement, world: World): number {
  let q = Infinity;
  for (const s of world.stages) {
    if (s.perOutcome <= 0) continue;
    const units = uniqueJobs(a.obligations.filter((o) => o.stage === s.id)).reduce((sum, o) => sum + o.qty, 0);
    q = Math.min(q, Math.floor(units / s.perOutcome));
  }
  return Number.isFinite(q) ? q : 0;
}

export function disrupt(agreement: Agreement, world: World, d: Disruption, opts: ImpactOptions = {}): Impact {
  return impactOf(agreement, world, d, opts);
}
