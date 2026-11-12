import type { Concession, Id, Iso, Money, Plan, World } from '@framvera/contracts';
import { suppliersAsked } from './levers.ts';

/**
 * An immutable what-if: a set of concessions and what the solver found under them. It never changes the
 * committed market and is never an agreement; sending one starts a negotiation at most.
 */
export interface SurgeryBranch {
  readonly id: Id;
  readonly label: string;
  readonly world: { readonly id: Id; readonly version: number };
  readonly intent: Id;
  readonly concessions: readonly Concession[];
  /** Lever positions, so the branch can be reopened in the editor as a copy. */
  readonly deltas: Readonly<Record<string, number>>;
  readonly status: 'possible' | 'impossible' | 'unknown';
  /** True when the cost is proven lowest; false when the solver stopped at its time limit with a good plan. */
  readonly optimal: boolean;
  readonly total?: Money;
  readonly readyAt?: Iso;
  readonly plan?: Plan;
  /** Supplier actor ids that would have to agree. The user's own concessions ask nobody. */
  readonly suppliersAsked: readonly Id[];
  readonly ownChanges: number;
  readonly createdAt: Iso;
  readonly agreed: false;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export const LABELS = ['A', 'B', 'C', 'D'] as const;
export const MAX_BRANCHES = LABELS.length;

export function makeBranch(input: {
  label: string;
  world: World;
  intent: Id;
  concessions: Concession[];
  deltas: Record<string, number>;
  status: SurgeryBranch['status'];
  optimal: boolean;
  plan?: Plan;
}): SurgeryBranch {
  const { label, world, intent, concessions, deltas, status, optimal, plan } = input;
  return deepFreeze<SurgeryBranch>(
    structuredClone({
      id: `branch-${label}-${concessions.map((c) => c.id).join('-') || 'none'}`,
      label,
      world: { id: world.id, version: world.version },
      intent,
      concessions,
      deltas,
      status,
      optimal,
      total: plan?.total,
      readyAt: plan?.readyAt,
      plan,
      suppliersAsked: suppliersAsked(concessions, world),
      ownChanges: concessions.filter((c) => c.target.kind === 'intent').length,
      createdAt: new Date().toISOString(),
      agreed: false as const,
    }),
  );
}
