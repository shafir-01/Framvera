import type { Coalition, NegotiationMessage, SupplierDecision, World } from '@framvera/contracts';
import type { Deps, HiddenTruthLike } from './types.ts';

/**
 * The only surface strategies see. Supplier answers come from policies held in this closure.
 * This is a code-level boundary inside one process, not a security boundary: it stops
 * strategies from reading truth by construction, not against hostile code.
 */
export interface Boundary {
  ask(msg: NegotiationMessage): SupplierDecision;
  readonly asked: number;
  readonly accepted: number;
  readonly decisions: SupplierDecision[];
  /** Uncounted peek for the hindsight oracle only. */
  hindsight(msg: NegotiationMessage): SupplierDecision;
  /** Shares the buyer proposes for each coalition; suppliers see only their own share when asked to join. */
  setCoalitions(cs: Coalition[]): void;
  /** Counts a supplier counter the buyer chose to take as an accepted term. */
  countAccepted(): void;
}

export function createBoundary(deps: Deps, truth: HiddenTruthLike, world: World): Boundary {
  const decisions: SupplierDecision[] = [];
  let asked = 0;
  let accepted = 0;
  let coalitions: Coalition[] = [];
  const answer = (msg: NegotiationMessage): SupplierDecision => {
    if (msg.type !== 'Propose' && msg.type !== 'AskPreference') throw new Error(`cannot ask with ${msg.type}`);
    const policy = truth.policies[msg.to];
    if (policy === undefined) {
      return { message: msg.id, accept: false, basis: 'synthetic-policy', reason: 'no policy for this actor' };
    }
    return deps.negotiation.decide(msg, policy, world, { coalitions });
  };
  return {
    ask(msg) {
      const d = answer(msg);
      asked++;
      if (d.accept) accepted++;
      decisions.push(d);
      return d;
    },
    get asked() { return asked; },
    get accepted() { return accepted; },
    decisions,
    hindsight: answer,
    setCoalitions(cs) { coalitions = cs; },
    countAccepted() { accepted++; },
  };
}
