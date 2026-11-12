import { motion } from 'motion/react';
import type { Id } from '@framvera/contracts';
import { disruptionTarget, useStore } from '../store.tsx';
import { concessionSentence, count, hours, money, weekday } from '../lib/format.ts';
import { ErrorNote, SourceTag, Waiting } from './ui.tsx';
import { Schedule } from '../mounts.tsx';
import { PlanTable } from './Agreement.tsx';
import { paid } from './Commit.tsx';
import { KIND_LABEL } from '../lib/world.ts';

export function Adapt() {
  const { s, act, world } = useStore();
  const ag = s.agreement;
  const plan = s.negotiation?.report?.plan ?? s.analysis?.report.plan;
  if (!ag || !s.market || !plan || !s.intent) return null;
  const negotiated = s.negotiation?.world ?? s.market.world;
  const target = disruptionTarget(ag, negotiated);
  const name = (id?: Id) => (world ?? negotiated).actors.find((a) => a.id === id)?.name ?? id ?? 'a supplier';
  const d = s.disruption;
  const rec = s.recovery?.recovery;
  const affected = d ? [...new Map([...d.affected, ...d.atRisk, ...d.failed].map((o) => [o.id, o])).values()] : [];
  const changed = rec ? rec.amended.length + rec.cancelled.length : 0;
  const keptTotal = rec ? rec.kept.length : 0;
  const readyAt = rec?.plan?.readyAt;
  const onTime = readyAt ? new Date(readyAt) <= new Date(s.intent.deadline) : undefined;
  const chosenExtra = rec?.extraCost.minor ?? 0;
  const cheaper = (rec?.candidates ?? []).filter((c) => !c.permissible && c.extraCostMinor < chosenExtra);
  const withdrawnPay = d?.disruption.actor ? Object.values(s.payments).find((p) => p.payee === d.disruption.actor && paid(p)) : undefined;
  const currency = plan.total.currency;

  return (
    <section className="act" id="adapt" tabIndex={-1} aria-labelledby="adapt-h">
      <div className="act-head">
        <div className="act-num">Adapt</div>
        <h2 className="h2" id="adapt-h" aria-live="polite">
          {rec ? (rec.feasible ? <>Recovered. <em>Accepted promises kept.</em></> : 'No recovery keeps every promise.') : d ? `${name(d.disruption.actor)} left the deal.` : 'What if a supplier walks away?'}
        </h2>
        {!d ? <p className="lede">Test it: {name(target?.actor)} withdraws after accepting.</p> : null}
      </div>

      {!d ? (
        <div className="adapt-bar">
          <p>Framvera keeps every promise it can and changes only what it must.</p>
          <button className="btn btn-break" onClick={() => void act.breakDeal()} disabled={s.busy === 'disrupt' || !target}>
            {s.busy === 'disrupt' ? 'Breaking…' : 'Break the deal'}
          </button>
        </div>
      ) : null}
      {s.error?.step === 'disrupt' ? <ErrorNote title="The disruption was not applied.">{s.error.message}</ErrorNote> : null}

      {d ? (
        <motion.p className="disruption-line" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4 }}>
          <span className="mark" aria-hidden="true" />
          <span>
            {d.disruption.detail} {affected.length ? `${count(affected.length, 'obligation')} invalidated: ${affected.map((o) => `${o.qty} ${(world ?? negotiated).stages.find((st) => st.id === o.stage)?.unit ?? 'units'} from ${name(o.actor)}`).join(', ')}.` : ''}
          </span>
        </motion.p>
      ) : null}

      {d ? (
        <div style={{ marginTop: 28 }}>
          <Schedule
            plan={rec?.plan ?? plan}
            agreement={s.recovery?.agreement ?? ag}
            recovery={rec}
            world={world ?? negotiated}
            originalWorld={s.market.world}
            deadline={s.intent.deadline}
            disruption={d.disruption}
            loading="Drawing the schedule"
            fallback={<PlanTable plan={rec?.plan ?? plan} world={world ?? negotiated} />}
          />
        </div>
      ) : null}

      {d && !rec && s.busy === 'recover' ? <Waiting>Finding a recovery</Waiting> : null}
      {s.error?.step === 'recover' ? <ErrorNote title="Recovery could not be computed.">{s.error.message}</ErrorNote> : null}

      {rec ? (
        <>
          {rec.feasible ? (
            <p className="recovery-line" aria-label="Recovery summary">
              <span>
                <strong className="num">{keptTotal}</strong> kept
              </span>
              <span>
                <strong className="num">{changed}</strong> changed
              </span>
              <span>
                <strong className="num">{money(rec.extraCost, { sign: rec.extraCost.minor > 0 })}</strong> extra
              </span>
              <span>{rec.slipHours ? `${hours(rec.slipHours)} later` : readyAt && onTime ? `Ready ${weekday(readyAt)}, on time` : 'No delay'}</span>
            </p>
          ) : null}

          {rec.added.length ? (
            <div style={{ marginTop: 28 }}>
              <div className="h3">What changed</div>
              <ul className="rejected">
                {rec.added.map((a, i) => (
                  <li key={i} style={{ background: 'var(--accent-soft)' }}>
                    <div style={{ fontSize: 15 }}>
                      <SourceTag kind="new">New</SourceTag> {name(a.actor)} takes over {a.qty} {(world ?? negotiated).stages.find((st) => st.id === a.stage)?.unit ?? 'units'}, {weekday(a.start)} to {weekday(a.finish)}, {money(a.cost)}.
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {rec.rejected.length || cheaper.length ? (
            <div style={{ marginTop: 28 }}>
              <div className="h3">Rejected plans</div>
              <ul className="rejected">
                {rec.rejected.map((r, i) => (
                  <li key={`r${i}`}>
                    <div className="r-what">{r.description}</div>
                    <div className="r-why">{r.reason}</div>
                  </li>
                ))}
                {cheaper
                  .filter((c) => !rec.rejected.some((r) => r.description === c.description))
                  .map((c, i) => (
                    <li key={`c${i}`}>
                      <div className="r-what">
                        {c.description} ({money({ currency, minor: chosenExtra - c.extraCostMinor })} cheaper)
                      </div>
                      <div className="r-why">{c.reasons.join(' ')}</div>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {!rec.feasible ? (
            <div style={{ marginTop: 28 }}>
              <ErrorNote title={rec.core?.summary ?? 'Every recovery breaks an accepted promise or a hard limit.'}>
                {rec.core?.constraints.map((c) => `${KIND_LABEL[c.kind] ?? c.kind}: ${c.text}`).join(' ')}
              </ErrorNote>
              {rec.concessionsNeeded?.length ? (
                <div style={{ marginTop: 16 }}>
                  <div className="h3">Smallest changes that would restore it</div>
                  <ul className="rejected">
                    {rec.concessionsNeeded.map((c) => (
                      <li key={c.id} style={{ background: 'var(--accent-soft)' }}>
                        <div style={{ fontSize: 15 }}>{concessionSentence(c, world ?? negotiated)}</div>
                        <div className="r-why">
                          <SourceTag kind="estimate">{`About ${money(c.estimate)}`}</SourceTag> {c.rationale}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {withdrawnPay || rec.payments?.refunds.length ? (
            <div className="approve">
              <div className="approve-text">
                {withdrawnPay ? `${name(withdrawnPay.payee)} was already paid ${money(withdrawnPay.charged)} in PayPal Sandbox for work it will not do.` : rec.payments?.refunds.map((r) => `Refund ${money(r.amount)}: ${r.reason}`).join(' ')}
              </div>
              {withdrawnPay ? (
                <button className="btn btn-quiet" onClick={() => void act.refund(withdrawnPay.id)} disabled={s.busy === 'refund'}>
                  {s.busy === 'refund' ? 'Refunding…' : `Approve refund of ${money(withdrawnPay.charged)}`}
                </button>
              ) : null}
              {s.payments[withdrawnPay?.id ?? '']?.state === 'REFUND_COMPLETED' ? <SourceTag kind="sandbox">Refunded in PayPal Sandbox</SourceTag> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
