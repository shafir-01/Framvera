import type { Agreement, Claim, EvidenceTier, Iso, World } from '@framvera/contracts';
import { LIVE_OBLIGATION } from '@framvera/obligations';
import type { FailureMode, ObligationRisk, RiskFactor } from './types.ts';
import { clamp01, ms } from './util.ts';

/**
 * Planner estimates behind every risk number. They are assumptions, shown with the result, never facts
 * about a supplier.
 */
export const RISK_ASSUMPTIONS = {
  /** Chance an obligation is delivered on its agreed terms when the supplier declares nothing. */
  priorReliability: 0.9,
  /** How much a declared reliability figure is trusted, by evidence tier. */
  tierWeight: { verified: 1, corroborated: 0.8, 'single-claim': 0.5, 'simulation-only': 0.25 } as Record<EvidenceTier, number>,
  /** Chance a claim the offer depends on turns out false, by evidence tier. */
  claimFalse: { verified: 0.01, corroborated: 0.03, 'single-claim': 0.12, 'simulation-only': 0.2 } as Record<EvidenceTier, number>,
  contradicted: 0.6,
  expired: 0.3,
} as const;

const RELIABILITY = /^(reliability|on-?time)/i;

export function reliabilityClaim(world: World, actor: string): Claim | undefined {
  return world.claims.find((c) => c.actor === actor && RELIABILITY.test(c.subject) && typeof c.value === 'number');
}

function declaredValue(c: Claim): number {
  const v = c.value ?? 0;
  return clamp01(v > 1 ? v / 100 : v);
}

function claimFactor(c: Claim, at: number): RiskFactor {
  const contradicted = (c.contradictedBy?.length ?? 0) > 0;
  const expired = !!c.expiresAt && ms(c.expiresAt) < at;
  let p: number = RISK_ASSUMPTIONS.claimFalse[c.tier];
  if (expired) p = Math.max(p, RISK_ASSUMPTIONS.expired);
  if (contradicted) p = Math.max(p, RISK_ASSUMPTIONS.contradicted);
  const mode: FailureMode = c.subject.startsWith('capacity') ? 'capacity-drop' : 'withdraw';
  const state = contradicted ? 'contradicted' : expired ? 'expired' : c.tier;
  return {
    kind: 'claim',
    ref: c.id,
    tier: c.tier,
    mode,
    p,
    text: `Claim ${c.id} (${c.subject}) is ${state}: ${Math.round(p * 100)}% chance it is false.`,
  };
}

/** Base hazard of one supplier: split evenly into a withdrawal hazard and a delay hazard. */
export function supplierHazard(world: World, actor: string): { effective: number; declared?: number; tier: EvidenceTier | 'undeclared'; claim?: string; h: number } {
  const c = reliabilityClaim(world, actor);
  const prior = RISK_ASSUMPTIONS.priorReliability;
  if (!c) return { effective: prior, tier: 'undeclared', h: 1 - Math.sqrt(prior) };
  const declared = declaredValue(c);
  const w = (c.contradictedBy?.length ?? 0) > 0 ? 0 : RISK_ASSUMPTIONS.tierWeight[c.tier];
  const effective = w * declared + (1 - w) * prior;
  return { effective, declared, tier: c.tier, claim: c.id, h: 1 - Math.sqrt(effective) };
}

/**
 * Failure risk of every live obligation from the supplier's declared reliability and the evidence tier of
 * each claim its offer depends on. Factors are independent; withdrawal outranks a capacity drop, which
 * outranks a delay, when several occur together.
 */
export function assessRisk(world: World, agreement: Agreement, opts: { at?: Iso } = {}): ObligationRisk[] {
  const at = ms(opts.at ?? agreement.createdAt);
  const claims = new Map(world.claims.map((c) => [c.id, c]));
  const offers = new Map(world.offers.map((o) => [o.id, o]));
  const out: ObligationRisk[] = [];
  for (const ob of agreement.obligations) {
    if (!LIVE_OBLIGATION.includes(ob.state)) continue;
    const hz = supplierHazard(world, ob.actor);
    const factors: RiskFactor[] = [
      {
        kind: 'reliability',
        ...(hz.claim ? { ref: hz.claim } : {}),
        tier: hz.tier,
        mode: 'withdraw',
        p: hz.h,
        text:
          hz.declared === undefined
            ? `No declared reliability; assumed ${Math.round(hz.effective * 100)}% on-terms delivery.`
            : `Declared ${Math.round(hz.declared * 100)}% reliability (${hz.tier}), weighted to ${Math.round(hz.effective * 100)}%.`,
      },
      { kind: 'reliability', ...(hz.claim ? { ref: hz.claim } : {}), tier: hz.tier, mode: 'delay', p: hz.h, text: 'Same reliability, as a chance of running late.' },
    ];
    for (const id of offers.get(ob.offer)?.claims ?? []) {
      const c = claims.get(id);
      if (c && !RELIABILITY.test(c.subject)) factors.push(claimFactor(c, at));
    }
    const none = (mode: FailureMode) => factors.filter((f) => f.mode === mode).reduce((acc, f) => acc * (1 - f.p), 1);
    const pW = 1 - none('withdraw');
    const pC = 1 - none('capacity-drop');
    const pD = 1 - none('delay');
    const modes = { withdraw: pW, 'capacity-drop': (1 - pW) * pC, delay: (1 - pW) * (1 - pC) * pD };
    out.push({
      obligation: ob.id,
      actor: ob.actor,
      offer: ob.offer,
      stage: ob.stage,
      amount: ob.amount,
      reliability: { ...(hz.declared === undefined ? {} : { declared: hz.declared }), tier: hz.tier, effective: hz.effective, ...(hz.claim ? { claim: hz.claim } : {}) },
      factors,
      modes,
      pFail: modes.withdraw + modes['capacity-drop'] + modes.delay,
      label: 'planner-estimate',
    });
  }
  return out;
}
