import type { Concession, Disruption, Id, Intent, Money, NegotiableField, World } from '@framvera/contracts';
import { TRUTH_KEYS } from '@framvera/contracts';

/**
 * A supplier's private decision policy. Lives only in the market and referee;
 * it never enters a World, a prompt or the browser.
 */
export interface SupplierPolicy {
  actor: Id;
  /**
   * Limit per negotiable field. unitPrice, setupFee: lowest acceptable amount in minor units.
   * windowEnd: latest acceptable ISO time. windowStart: earliest acceptable ISO time.
   * capacity: most units. minQty: smallest minimum. joint: smallest acceptable coalition share in minor units.
   */
  reservation: Partial<Record<NegotiableField, number | string>>;
  /** Least extra payment wanted for granting a concession (overtime crew, rush handling). */
  premium: Partial<Record<NegotiableField, Money>>;
  maxExtensionHours: number;
  /** Extra units the supplier could produce beyond its published capacity in overtime. */
  maxOvertimeUnits: number;
  /** Value of the supplier's best alternative use of the capacity. */
  outside: Money;
  /** 0 = refuses anything uncertain, 1 = accepts any risk. */
  riskTolerance: number;
}

export interface CoalitionCertificate {
  id: Id;
  /** Actor ids. */
  members: Id[];
  /** Member offer ids composed with composeJoint, in this order. */
  offers: Id[];
}

/** A set of changes, each within the granting supplier's private limits, that makes the world feasible. */
export interface Certificate {
  concessions: Concession[];
  coalitions: CoalitionCertificate[];
  /** Cheapest plan cost after the changes, found by the market checker. */
  expectedTotal: Money;
}

export interface RecoveryManifest {
  disruption: Id;
  /** The cheapest plan that keeps every accepted obligation and replaces only what failed. */
  valid: { certificate: Certificate; extraCost: Money; text: string };
  /** A cheaper global re-plan that is only reachable by breaking the listed accepted offers' obligations. */
  forbidden: { certificate: Certificate; total: Money; breaks: Id[]; text: string };
}

export interface HiddenTruth {
  policies: Record<Id, SupplierPolicy>;
  /** Units each offer can really deliver. Differs from the published claim for dishonest suppliers. */
  realCapacity: Record<Id, number>;
  /** Scheduled events the referee applies during a run. */
  shocks: Disruption[];
  /** Present for salvageable and flagship worlds. */
  certificate?: Certificate;
  recovery?: RecoveryManifest;
  /** Offers whose public claims are false or whose descriptions carry instructions. */
  adversarial: Id[];
}

export type Family = 'feasible' | 'salvageable' | 'impossible';

export interface MarketBundle {
  world: World;
  intent: Intent;
  truth: HiddenTruth;
}

function strip(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(strip);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!TRUTH_KEYS.includes(k)) out[k] = strip(x);
  return out;
}

/** A deep copy of the world with any private-truth field removed. */
export function sanitize(world: World): World {
  return strip(world) as World;
}

/** Throws when any private policy field or any private value from the truth appears in the world. */
export function assertNoTruth(world: World, truth?: HiddenTruth): void {
  const text = JSON.stringify(world);
  for (const k of TRUTH_KEYS) if (text.includes(`"${k}":`)) throw new Error(`World leaks private field "${k}"`);
  if (truth) {
    for (const [id, policy] of Object.entries(truth.policies)) {
      for (const [field, value] of Object.entries(policy.reservation)) {
        if (typeof value === 'string' && text.includes(value) && !publicIso(world, value)) {
          throw new Error(`World leaks ${id} reservation for ${field}`);
        }
      }
    }
  }
}

function publicIso(world: World, iso: string): boolean {
  return world.offers.some((o) => o.window.start === iso || o.window.end === iso || o.validUntil === iso) || world.createdAt === iso;
}
