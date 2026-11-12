import type { Intent, World } from '@framvera/contracts';
import { count, money, weekday } from '../lib/format.ts';
import { MAX_BRANCHES, type SurgeryBranch } from './branch.ts';
import { changeItems } from './levers.ts';

interface Props {
  world: World;
  intent: Intent;
  branches: SurgeryBranch[];
  sent: ReadonlySet<string>;
  activeSig: string;
  sigOf: (b: SurgeryBranch) => string;
  onOpen: (b: SurgeryBranch) => void;
  onRemove: (b: SurgeryBranch) => void;
  onCommit?: (b: SurgeryBranch) => void;
}

export function Multiverse({ world, intent, branches, sent, activeSig, sigOf, onOpen, onRemove, onCommit }: Props) {
  const possible = branches.filter((b) => b.status === 'possible' && b.total && b.readyAt);
  const best = (pick: (b: SurgeryBranch) => number) => {
    const vals = possible.map(pick);
    return vals.length > 1 && new Set(vals).size > 1 ? Math.min(...vals) : undefined;
  };
  const cheapest = best((b) => b.total!.minor);
  const earliest = best((b) => Date.parse(b.readyAt!));
  const fewest = best((b) => b.suppliersAsked.length);

  return (
    <section className="sg-mv" aria-labelledby="sg-mv-title">
      <div className="sg-mv-head">
        <h3 className="h3" id="sg-mv-title">
          Branches <span className="count">{branches.length} of {MAX_BRANCHES}</span>
        </h3>
        <span className="tag">What-if, not agreed</span>
      </div>
      {branches.length > 0 && (
        <ol className="sg-mv-list">
          {branches.map((b) => {
            const ok = b.status === 'possible';
            const isSent = sent.has(b.id);
            return (
              <li key={b.id} className="sg-branch" data-ok={ok || undefined} data-active={sigOf(b) === activeSig || undefined}>
                <div className="sg-branch-head">
                  <span className="sg-branch-label" aria-hidden="true">
                    {b.label}
                  </span>
                  <span className="sg-branch-verdict verdict" data-ok={ok}>
                    <span className="verdict-dot" aria-hidden="true" />
                    {ok ? 'Possible' : b.status === 'impossible' ? 'Impossible' : 'Unknown'}
                  </span>
                  <button type="button" className="sg-x" onClick={() => onRemove(b)} aria-label={`Remove branch ${b.label}`}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M1 1l8 8M9 1 1 9" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  </button>
                </div>
                <dl className="sg-branch-figs">
                  <div>
                    <dt>Cost</dt>
                    <dd className="num">
                      {b.total ? money(b.total) : '–'}
                      {cheapest !== undefined && b.total?.minor === cheapest && <span className="sg-best">Lowest</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Ready</dt>
                    <dd className="num">
                      {b.readyAt ? weekday(b.readyAt) : '–'}
                      {earliest !== undefined && b.readyAt && Date.parse(b.readyAt) === earliest && <span className="sg-best">Earliest</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Suppliers asked</dt>
                    <dd className="num">
                      {b.suppliersAsked.length}
                      {fewest !== undefined && b.suppliersAsked.length === fewest && ok && <span className="sg-best">Fewest</span>}
                    </dd>
                  </div>
                </dl>
                <ul className="sg-branch-changes">
                  {changeItems(b.concessions, world).map((c) => (
                    <li key={c.key}>
                      {c.own && <span className="sg-own">Your own</span>}
                      {c.text}
                    </li>
                  ))}
                </ul>
                {!b.optimal && ok && <p className="fine">A cheaper plan may exist.</p>}
                <div className="sg-branch-foot">
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => onOpen(b)}>
                    Open
                  </button>
                  {onCommit && ok && b.suppliersAsked.length > 0 && (
                    <button type="button" className={`btn btn-small ${sigOf(b) === activeSig ? 'btn-accent' : 'btn-quiet'}`} onClick={() => onCommit(b)} disabled={isSent}>
                      {isSent ? 'Sent' : 'Negotiate'}
                    </button>
                  )}
                </div>
                {isSent && <p className="fine">Waiting on {count(b.suppliersAsked.length, 'supplier')}.</p>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="sr-only">Branches are compared against your request: {money(intent.budget)} by {weekday(intent.deadline)}.</p>
    </section>
  );
}
