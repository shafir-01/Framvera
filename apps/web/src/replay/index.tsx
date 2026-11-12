import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Id, MarketEvent, Obligation, PaymentIntent } from '@framvera/contracts';
import { ErrorNote, SourceTag, Waiting, sourceKind } from '../components/ui.tsx';
import { clock, hours, money, when } from '../lib/format.ts';
import { branchOf, chapterOf, describe, orderEvents, reasonFor, snapshotAt, spans, type Chapter } from './model.ts';
import type { ReplayProps } from './types.ts';
import './replay.css';

export type { ReplayProps } from './types.ts';

const STATE_WORDS: Record<string, string> = {
  PENDING: 'Waiting',
  ACTIVE: 'Active',
  AT_RISK: 'At risk',
  FULFILLED: 'Fulfilled',
  BREACHED: 'Breached',
  CANCELLED: 'Cancelled',
  REPLACED: 'Replaced',
};

const PAY_WORDS: Record<string, string> = {
  PAYMENT_PROPOSED: 'Proposed',
  ORDER_CREATED: 'Order created',
  PAYER_ACTION_REQUIRED: 'Waiting for the buyer',
  APPROVED: 'Approved',
  CAPTURE_PENDING: 'Capture pending',
  CAPTURE_COMPLETED: 'Captured',
  CAPTURE_DENIED: 'Capture denied',
  CAPTURE_UNKNOWN: 'Capture unconfirmed',
  VOIDED: 'Voided',
  REFUND_PENDING: 'Refund pending',
  REFUND_COMPLETED: 'Refunded',
  REFUND_DENIED: 'Refund denied',
  REFUND_UNKNOWN: 'Refund unconfirmed',
};

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Replay({ market, api, world, events: given, agreement, recovery, payments: knownPayments }: ReplayProps) {
  const [fetched, setFetched] = useState<MarketEvent[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fresh, setFresh] = useState<Record<Id, PaymentIntent>>({});
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (given) return;
    let live = true;
    setFailed(null);
    api
      .events(market)
      .then((list) => live && setFetched(list))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : 'The record could not be loaded.'));
    const off = api.subscribe(market, (e) => setFetched((prev) => (prev && prev.some((x) => x.id === e.id) ? prev : [...(prev ?? []), e])));
    return () => {
      live = false;
      off();
    };
  }, [api, market, given, attempt]);

  const events = useMemo(() => orderEvents(given ?? fetched ?? []), [given, fetched]);
  const chapters = useMemo(() => chapterOf(events), [events]);
  const parts = useMemo(() => spans(chapters), [chapters]);
  const last = events.length - 1;
  const at = Math.min(cursor ?? last, last);
  const following = cursor === null || cursor >= last;

  const setAt = useCallback((n: number) => setCursor(Math.max(0, Math.min(n, last))), [last]);

  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCursor(at + 1), reduced() ? 1600 : 1100);
    return () => clearTimeout(t);
  }, [playing, at, last]);

  const snap = useMemo(() => snapshotAt(events, world, at), [events, world, at]);
  const reason = useMemo(() => (events[at + 1] ? reasonFor(events, at + 1, world) : undefined), [events, world, at]);
  const nextEvent = events[at + 1];
  const current = events[at];

  const obligationIndex = useMemo(() => {
    const m = new Map<Id, Obligation>();
    for (const o of [...(recovery?.agreement?.obligations ?? []), ...(agreement?.obligations ?? [])]) m.set(o.id, o);
    return m;
  }, [agreement, recovery]);

  const name = useCallback((id?: Id) => world?.actors.find((a) => a.id === id)?.name ?? id ?? 'Unknown party', [world]);
  const stageName = useCallback((id: Id) => world?.stages.find((s) => s.id === id)?.name ?? id, [world]);

  const branch = useMemo(() => {
    if (!snap.recoveryReached) return undefined;
    return branchOf(snap.recovery ?? recovery?.recovery);
  }, [snap.recoveryReached, snap.recovery, recovery]);

  const chapter: Chapter | undefined = chapters[at];
  const atEnd = at >= last;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const i = parts.findIndex((p) => at >= p.from && at <= p.to);
      const target = e.key === 'PageDown' ? parts[i + 1] : at > (parts[i]?.from ?? 0) ? parts[i] : parts[i - 1];
      if (target) setAt(target.from);
    }
  };

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const results = await Promise.all(snap.payments.map((p) => api.payment(p.id)));
      setFresh(Object.fromEntries(results.map((r) => [r.id, r])));
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : 'PayPal could not be reached.');
    } finally {
      setChecking(false);
    }
  };

  if (failed && !events.length) {
    return <ErrorNote title="The record could not be loaded" onRetry={() => setAttempt((n) => n + 1)}>{failed}</ErrorNote>;
  }
  if (!events.length) {
    return given || fetched ? <p className="rp-empty">Nothing has happened in this market yet.</p> : <Waiting>Loading the record</Waiting>;
  }

  const pct = last > 0 ? (at / last) * 100 : 100;
  const known = (id: Id) => knownPayments?.find((p) => p.id === id);
  const challenged = snap.findings.filter((f) => f.verdict !== 'consistent');

  return (
    <section className="rp" aria-label="Replay of this market">
      <nav className="rp-chapters" aria-label="Chapters">
        {parts.map((p) => (
          <button key={p.from} className="rp-chip" aria-current={chapter === p.chapter && at >= p.from && at <= p.to} data-ahead={p.from > at} onClick={() => setAt(p.from)}>
            {p.chapter}
          </button>
        ))}
      </nav>

      <div className="rp-bar">
        <button className="rp-play" aria-label={playing ? 'Pause replay' : atEnd ? 'Replay from the start' : 'Play replay'} onClick={() => (playing ? setPlaying(false) : (atEnd && setCursor(0), setPlaying(true)))}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            {playing ? <path d="M3 2v8M9 2v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> : <path d="M3 1.8v8.4L10 6z" fill="currentColor" />}
          </svg>
        </button>
        <div className="rp-track">
          <div className="rp-line" />
          <div className="rp-fill" style={{ width: `${pct}%` }} />
          <div className="rp-ticks" aria-hidden="true">
            {events.map((e, i) => (
              <span key={e.id} className="rp-tick" data-passed={i <= at} data-mark={i === 0 || chapters[i] !== chapters[i - 1]} style={{ left: `${last > 0 ? (i / last) * 100 : 0}%` }} />
            ))}
          </div>
          <input
            className="rp-range"
            type="range"
            min={0}
            max={last}
            step={1}
            value={at}
            aria-label="Position in the market record"
            aria-valuetext={`Step ${at + 1} of ${events.length}: ${current ? describe(current, world): ''}`}
            onChange={(e) => {
              setPlaying(false);
              setCursor(Number(e.target.value));
            }}
            onKeyDown={onKey}
          />
        </div>
        <span className="rp-count">
          {at + 1} / {events.length}
          {following && !given ? ' live': ''}
        </span>
      </div>

      {current ? (
        <div className="rp-now rp-fade" key={current.id}>
          <div className="rp-meta">
            <time dateTime={current.at}>{when(current.at)}</time>
            <SourceTag kind={sourceKind(current.source)} />
          </div>
          <h3 aria-live="polite">{describe(current, world)}</h3>
        </div>
      ) : null}

      <div className="rp-why" aria-live="polite">
        {nextEvent && reason ? (
          <>
            <h4>Next: {describe(nextEvent, world)}</h4>
            {reason.recorded ? (
              <ul>
                {reason.causes.map((c) => (
                  <li key={c.id}>
                    Because{' '}
                    <button className="rp-link" onClick={() => setAt(c.index)}>
                      {c.sentence.charAt(0).toLowerCase() + c.sentence.slice(1)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rp-note">
                No cause is recorded for this step. It followed{' '}
                {reason.prior ? (
                  <button className="rp-link" onClick={() => setAt(reason.prior!.index)}>
                    {reason.prior.sentence.charAt(0).toLowerCase() + reason.prior.sentence.slice(1)}
                  </button>
                ) : (
                  'the start of the record'
                )}{' '}
                in the log.
              </p>
            )}
          </>
        ) : (
          <>
            <h4>End of the record</h4>
            {following && !given ? <p className="rp-note">New steps appear here as they happen.</p> : null}
          </>
        )}
      </div>

      <div className="rp-cols">
        <div className="rp-col">
          <h4>What was known</h4>
          {snap.offers.length ? (
            <ul className="rp-list" style={{ maxHeight: 220, overflow: 'auto' }}>
              {snap.offers.map(({ offer, derived }) => (
                <li key={offer.id} className="rp-row" data-new={derived}>
                  <span>
                    {name(offer.actor)}
                    <span className="rp-sub">
                      {stageName(offer.stage)}, up to {offer.capacity}
                    </span>
                  </span>
                  <span>{derived ? 'New' : `v${offer.version}`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rp-empty">No offers are known yet.</p>
          )}
          {snap.claims.length ? (
            <p className="rp-note">
              {snap.claims.length} supplier {snap.claims.length === 1 ? 'claim' : 'claims'}
              {snap.findings.length ? `, ${challenged.length} of ${snap.findings.length} checked ${challenged.length === 1 ? 'was' : 'were'} questioned` : ', none checked yet'}.
            </p>
          ) : null}
          {snap.solve ? (
            <p className="rp-note">
              {snap.solve.status === 'infeasible' ? (snap.solve.summary ?? 'No combination of the offers works.') : snap.solve.verified !== undefined ? (snap.solve.verified ? 'A plan exists and passed the independent check.' : 'A plan exists but failed the independent check.') : 'A plan exists.'}
            </p>
          ) : null}
        </div>

        <div className="rp-col">
          <h4>What was owed</h4>
          {snap.obligations.length ? (
            <ul className="rp-list">
              {snap.obligations.map((o) => {
                const full = obligationIndex.get(o.id);
                return (
                  <li key={o.id} className="rp-row" data-broken={o.state === 'AT_RISK' || o.state === 'BREACHED' || o.state === 'CANCELLED' || o.state === 'REPLACED'}>
                    <span>
                      {name(o.actor ?? full?.actor)}
                      <span className="rp-sub">{full ? `${stageName(full.stage)}, ${full.qty}, ${money(full.amount)}` : o.id}</span>
                    </span>
                    <span>{STATE_WORDS[o.state] ?? o.state}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rp-empty">Nothing is owed yet.</p>
          )}
        </div>

        <div className="rp-col">
          <h4>Money</h4>
          {snap.payments.length || snap.approvalIssued ? (
            <ul className="rp-list">
              {snap.approvalIssued && !snap.payments.length ? (
                <li className="rp-row">
                  <span>
                    Approval to pay {name(snap.approvalIssued.payee)}
                    <span className="rp-sub">{money(snap.approvalIssued.amount)}</span>
                  </span>
                  <span>Issued</span>
                </li>
              ) : null}
              {snap.payments.map((p) => {
                const live = atEnd ? fresh[p.id] : undefined;
                const info = known(p.id);
                const status = live?.paypal.status ?? p.paypalStatus;
                const fetchedAt = live?.paypal.lastFetchedAt;
                return (
                  <li key={p.id} className="rp-row">
                    <span>
                      <SourceTag kind="sandbox" />
                      <span className="rp-sub">
                        {info ? `${money(info.amount)}. `: ''}
                        PayPal says {status ?? 'nothing recorded'}
                        {fetchedAt ? `, fetched ${clock(fetchedAt)}` : ''}
                      </span>
                    </span>
                    <span>{PAY_WORDS[live?.state ?? p.state ?? ''] ?? (p.approved ? 'Approved' : 'Open')}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rp-empty">No money has moved.</p>
          )}
          {atEnd && snap.payments.length ? (
            <>
              <button className="btn btn-quiet btn-small rp-fetch" onClick={check} disabled={checking}>
                {checking ? 'Asking PayPal' : 'Check with PayPal now'}
              </button>
              {checkError ? <p className="rp-note" role="alert">{checkError}</p> : null}
            </>
          ) : null}
        </div>
      </div>

      {branch ? (
        <div className="rp-branch rp-fade">
          <h3>The recovery that was not taken</h3>
          <div className="rp-sides">
            <div className="rp-side" data-kind="rejected">
              <h4>{branch.rejected.length === 1 ? 'Rejected plan' : 'Rejected plans'}</h4>
              {branch.rejected.map((r, i) => (
                <div key={i} className="rp-plan">
                  <span>{r.description}</span>
                  <span className="rp-sub">
                    {r.extraCost ? `Extra cost ${money(r.extraCost)}` : 'Cost not recorded'}
                    {r.slipHours !== undefined ? `, slip ${hours(r.slipHours)}`: ''}
                  </span>
                  <span className="rp-reason">
                    <b>Why not:</b> {r.reason}
                  </span>
                </div>
              ))}
            </div>
            <div className="rp-side" data-kind="committed">
              <h4>Committed plan</h4>
              <div className="rp-plan">
                <span>
                  Extra cost {money(branch.committed.extraCost)}, slip {hours(branch.committed.slipHours)}
                </span>
                <span className="rp-sub">
                  {branch.committed.kept} kept, {branch.committed.amended} amended, {branch.committed.cancelled} cancelled, {branch.committed.added} added
                </span>
                <span className="rp-reason">{branch.committed.feasible ? '' : 'No plan met every commitment.'}</span>
              </div>
            </div>
          </div>
          {branch.cheaperRejected ? <p className="rp-note">A cheaper plan existed and was ruled out for the reason shown.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export default Replay;
