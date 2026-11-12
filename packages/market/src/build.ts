import type { Actor, ActorKind, Claim, Currency, EvidenceTier, Id, Iso, NegotiableField, Offer, Stage } from '@framvera/contracts';
import { addHours, money } from '@framvera/contracts';

export interface OfferSpec {
  id: Id;
  actor: Id;
  stage: Id;
  capacity: number;
  minQty: number;
  rate: number;
  setup: number; // major units
  tiers: [number, number][]; // [minQty, unit price in major units]
  window: [number, number]; // hours after the anchor
  handoff: number;
  negotiable?: NegotiableField[];
  validUntil?: number; // hours after the anchor
  evidence?: EvidenceTier;
}

export interface Builder {
  anchor: Iso;
  observedAt: Iso;
  currency: Currency;
  at(h: number): Iso;
  actor(id: Id, name: string, kind: ActorKind, city: string, description: string): Actor;
  offer(spec: OfferSpec): Offer;
  stage(id: Id, name: string, unit: string, after: Id[], perOutcome?: number): Stage;
  actors: Actor[];
  offers: Offer[];
  claims: Claim[];
  stages: Stage[];
}

const minor = (major: number) => Math.round(major * 100);

export function builder(anchor: Iso, observedAt: Iso, currency: Currency, defaultValidUntil: number): Builder {
  const b: Builder = {
    anchor,
    observedAt,
    currency,
    actors: [],
    offers: [],
    claims: [],
    stages: [],
    at: (h) => addHours(anchor, h),
    actor(id, name, kind, city, description) {
      const a: Actor = { id, name, kind, city, description, active: true };
      b.actors.push(a);
      return a;
    },
    stage(id, name, unit, after, perOutcome = 1) {
      const s: Stage = { id, name, unit, after, perOutcome };
      b.stages.push(s);
      return s;
    },
    offer(s) {
      const claimId = `cl-cap-${s.id}`;
      b.claims.push({
        id: claimId,
        actor: s.actor,
        subject: `capacity:${s.id}`,
        assertion: `Can deliver up to ${s.capacity} units in the offered window.`,
        value: s.capacity,
        tier: s.evidence ?? 'corroborated',
        provenance: { source: 'synthetic-market', observedAt },
      });
      const o: Offer = {
        id: s.id,
        version: 1,
        actor: s.actor,
        stage: s.stage,
        capacity: s.capacity,
        minQty: s.minQty,
        ratePerHour: s.rate,
        setupFee: money(currency, minor(s.setup)),
        tiers: s.tiers.map(([q, p]) => ({ minQty: q, unit: money(currency, minor(p)) })),
        window: { start: b.at(s.window[0]), end: b.at(s.window[1]) },
        handoffHours: s.handoff,
        validUntil: b.at(s.validUntil ?? defaultValidUntil),
        negotiable: s.negotiable ?? [],
        provenance: { source: 'synthetic-market', observedAt, ref: `offer:${s.id}:v1` },
        claims: [claimId],
      };
      b.offers.push(o);
      return o;
    },
  };
  return b;
}
