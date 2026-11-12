import { useState } from 'react';
import type { Plan, World } from '@framvera/contracts';
import { useStore } from '../store.tsx';
import { count, money, shortHash, weekday } from '../lib/format.ts';
import { Copy, ErrorNote, SourceTag, Waiting } from './ui.tsx';
import { Observatory, Schedule } from '../mounts.tsx';
import { indexWorld } from '../lib/world.ts';

export function PlanTable({ plan, world }: { plan: Plan; world?: World }) {
  const ix = world ? indexWorld(world) : undefined;
  return (
    <table className="plan-table">
      <caption className="sr-only">Planned work</caption>
      <thead>
        <tr>
          <th scope="col">Supplier</th>
          <th scope="col">Stage</th>
          <th scope="col">Quantity</th>
          <th scope="col">Starts</th>
          <th scope="col">Ready</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {plan.allocations.map((a) => (
          <tr key={`${a.offer}-${a.start}`}>
            <td>{ix?.actorName(a.actor) ?? a.actor}</td>
            <td>{ix?.stage(a.stage)?.name ?? a.stage}</td>
            <td className="num">{a.qty}</td>
            <td className="num">{weekday(a.start)}</td>
            <td className="num">{weekday(a.finish)}</td>
            <td className="num">{money(a.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AgreementSection({ theme }: { theme: 'light' | 'dark' }) {
  const { s, act, api, world } = useStore();
  const [records, setRecords] = useState(false);
  const plan = s.negotiation?.report?.plan ?? (s.analysis?.report.status !== 'infeasible' ? s.analysis?.report.plan : undefined);
  if (!plan || !s.market || !s.intent) return null;
  const ag = s.committed ?? s.agreement;
  const negotiated = s.negotiation?.world ?? s.market.world;
  const parties = new Set(plan.allocations.map((a) => a.actor));
  const acceptedBySuppliers = s.negotiation?.decisions.filter((d) => d.accept).length ?? 0;
  const hashesMatch = ag ? ag.acceptances.every((x) => x.termsHash === ag.termsHash) : false;

  return (
    <section className="act" id="agreement" tabIndex={-1} aria-labelledby="agreement-h">
      <div className="act-head">
        <div className="act-num">Commit · Agreement</div>
        <h2 className="h2" id="agreement-h">
          {ag ? 'Committed.' : 'Who owes what, and when.'}
        </h2>
        <p className="lede">
          {count(parties.size, 'supplier')} · {count(plan.allocations.length, 'piece', 'pieces')} of work.
        </p>
      </div>

      <div className="fv-host">
  
        <Schedule
          plan={plan}
          agreement={ag}
          world={negotiated}
          originalWorld={s.market.world}
          deadline={s.intent.deadline}
          loading="Drawing the schedule"
          fallback={<PlanTable plan={plan} world={negotiated} />}
        />

      </div>

      {!ag ? (
        <div className="approve">
          <div className="approve-text">
            <strong>Total {money(plan.total)}.</strong> Payment comes after, one approval per supplier.
          </div>
          <button className="btn btn-primary" onClick={() => void act.commit()} disabled={s.busy === 'commit'}>
            {s.busy === 'commit' ? 'Committing…' : 'Approve and commit'}
          </button>
          {s.error?.step === 'commit' ? (
            <div style={{ flexBasis: '100%' }}>
              <ErrorNote title="The agreement was not committed." onRetry={() => void act.commit()}>
                {s.error.message}
              </ErrorNote>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="approve">
          <dl className="kv" style={{ flex: '1 1 340px' }}>
            <dt>Terms hash</dt>
            <dd className="mono">
              {shortHash(ag.termsHash, 16)}
              <Copy text={ag.termsHash} label="terms hash" />
            </dd>
            <dt>Signed by</dt>
            <dd>
              {hashesMatch ? <span className="match">All {ag.acceptances.length} parties ✓</span> : <span className="match" data-ok="false">Signatures do not match these terms</span>}
            </dd>
          </dl>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SourceTag kind="solver">Verified before commit</SourceTag>
            <SourceTag kind="synthetic">Supplier acceptances</SourceTag>
          </div>
        </div>
      )}

      <div className="obs-head">
        <div>
          <div className="h3" style={{ marginBottom: 4 }}>
            Market records
          </div>
          <div className="fine">Every fact behind this deal, with its source.</div>
        </div>
        <button className="btn btn-quiet btn-small" aria-expanded={records} aria-controls="records" onClick={() => setRecords((v) => !v)}>
          {records ? 'Close' : 'Open'}
        </button>
      </div>
      {records ? (
        <div id="records" className="records-shell">
          <Observatory
            market={s.market.market}
            api={api}
            world={world ?? negotiated}
            intent={s.intent}
            invention={s.invention}
            negotiation={s.negotiation}
            agreement={ag}
            payments={Object.values(s.payments)}
            recovery={s.recovery}
            events={s.events}
            theme={theme}
            loading="Loading the market records"
            fallback={<Waiting>The records view is not available in this build.</Waiting>}
          />
        </div>
      ) : null}
    </section>
  );
}
