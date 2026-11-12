import { useStore } from '../store.tsx';
import { concessionSentence, money } from '../lib/format.ts';

export function Outcome() {
  const { s, world } = useStore();
  const intent = s.intent;
  const report = s.analysis?.report;
  const plan = s.recovery?.recovery.plan ?? s.negotiation?.report?.plan ?? (report?.status !== 'infeasible' ? report?.plan : undefined);
  const verified = s.recovery ? s.recovery.recovery.feasible : s.negotiation?.verification?.ok;
  const broken = !!s.disruption && !s.recovery;
  const core = report?.core;
  const best = s.invention?.interventions.find((i) => i.unlocks && i.totalAfter);
  const lost = !!s.recovery && !s.recovery.recovery.feasible;
  const unlocked = s.negotiation?.accepted ?? [];

  let feasible: React.ReactNode = '…';
  let feasibleSub = '';
  if (lost) {
    feasible = 'Not anymore';
  } else if (broken) {
    feasible = 'At risk';
  } else if (plan) {
    feasible = <span className="yes">Yes</span>;
    feasibleSub = verified ? 'Independently checked' : 'Checking';
  } else if (report?.status === 'infeasible') {
    feasible = 'Not yet';
    feasibleSub = '';
  } else if (report) {
    feasible = report.status;
    feasibleSub = 'Solver result';
  }

  let cost: React.ReactNode = '–';
  let costSub = '';
  if (plan && intent) {
    cost = money(plan.total);
    const head = intent.budget.minor - plan.total.minor;
    costSub = head >= 0 ? `${money({ currency: plan.total.currency, minor: head })} under budget` : `${money({ currency: plan.total.currency, minor: -head })} over budget`;
  } else if (best?.totalAfter && intent) {
    cost = money(best.totalAfter);
    costSub = 'If suppliers agree (planner estimate)';
  }

  let block: React.ReactNode = '–';
  let blockSub = '';
  if (lost && s.recovery) {
    block = s.recovery.recovery.core?.constraints[0]?.text ?? 'No recovery keeps every accepted promise.';
    blockSub = s.disruption?.disruption.detail ?? '';
  } else if (broken && s.disruption) {
    block = s.disruption.disruption.detail;
    blockSub = 'Recovering';
  } else if (plan) {
    block = 'None';
    blockSub = unlocked[0] ? `Unlocked by: ${concessionSentence(unlocked[0], world)}` : '';
  } else if (core?.constraints[0]) {
    block = core.constraints[0].text;
    blockSub = core.constraints.length > 1 ? `and ${core.constraints.length - 1} more` : '';
  }

  return (
    <dl className="outcome" aria-label="Where the order stands" aria-live="polite">
      <div className="figure">
        <dt>Possible today</dt>
        <dd>
          {feasible}
          {feasibleSub ? <small>{feasibleSub}</small> : null}
        </dd>
      </div>
      <div className="figure">
        <dt>{plan ? 'Agreed total' : 'Best deal found'}</dt>
        <dd className="num">
          {cost}
          {costSub ? <small>{costSub}</small> : null}
        </dd>
      </div>
      <div className="figure">
        <dt>What blocks it</dt>
        <dd className="sentence">
          {block}
          {blockSub ? <small>{blockSub}</small> : null}
        </dd>
      </div>
    </dl>
  );
}
