import { useEffect, useState } from 'react';
import type { Agreement, MarketEvent, NegotiationMessage, PaymentIntent, SolveReport, Verification, World } from '@framvera/contracts';
import { errorText, useStore } from '../store.tsx';
import type { MarketSnapshot } from '../api.ts';
import { money, shortHash, stamp } from '../lib/format.ts';
import { Copy, ErrorNote, SourceTag, Waiting } from './ui.tsx';
import { EvidenceTrail, Replay } from '../mounts.tsx';
import { EventRows } from './Inspect.tsx';
import { KIND_LABEL } from '../lib/world.ts';

function entityFromHash(): string | undefined {
  const q = location.hash.split('?')[1];
  return q ? (new URLSearchParams(q).get('entity') ?? undefined) : undefined;
}

function Report({ title, report, verification }: { title: string; report?: SolveReport; verification?: Verification }) {
  if (!report) return null;
  return (
    <div className="panel ev-card">
      <div className="h3">
        {title} <SourceTag kind="solver" />
      </div>
      <dl className="kv">
        <dt>Status</dt>
        <dd>{report.status}</dd>
        <dt>Solver</dt>
        <dd className="mono">
          {report.solver.name} {report.solver.version} · {report.solver.ms} ms{report.solver.gap !== undefined ? ` · gap ${report.solver.gap}` : ''}
        </dd>
        {report.plan ? (
          <>
            <dt>Plan</dt>
            <dd>
              <span className="mono">{report.plan.id}</span> · {money(report.plan.total)} · {report.plan.allocations.length} allocations
            </dd>
            <dt>Objective</dt>
            <dd>{report.plan.objective}</dd>
          </>
        ) : null}
        {report.core ? (
          <>
            <dt>Core</dt>
            <dd>
              {report.core.constraints.length} constraint groups · {report.core.method} · minimal {String(report.core.minimal)} · proven {String(report.core.proven)}
            </dd>
          </>
        ) : null}
      </dl>
      {report.core ? (
        <ol className="msg-list" style={{ marginTop: 12 }}>
          {report.core.constraints.map((c) => (
            <li className="msg" key={c.id}>
              <span className="ty">{c.id}</span>
              <span>
                <span style={{ color: 'var(--ink-3)' }}>{KIND_LABEL[c.kind] ?? c.kind} · </span>
                {c.text}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {verification ? (
        <>
          <div className="h3" style={{ marginTop: 18 }}>
            Independent check <span className="count">recomputed without the solver</span>
          </div>
          <ol className="msg-list">
            {verification.checks.map((c) => (
              <li className="msg" key={c.id}>
                <span className="ty">
                  {c.ok ? '✓' : '✕'} {c.id}
                </span>
                <span>{c.text}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

function msgLine(m: NegotiationMessage, name: (id?: string) => string): string {
  switch (m.type) {
    case 'RequestQuote':
      return `${name(m.from)} → ${name(m.to)} · ${m.qty} on ${m.stage}`;
    case 'AskPreference':
      return `${name(m.from)} → ${name(m.to)} · ${m.question.target.kind === 'offer' ? `${m.question.target.offer}.${m.question.target.field}` : m.question.target.field}: ${m.question.from} → ${m.question.to}`;
    case 'Propose':
    case 'CounterOffer':
      return `${name(m.from)} → ${name(m.to)} · ${m.concession.target.kind === 'offer' ? `${m.concession.target.offer}.${m.concession.target.field}` : m.concession.target.field}: ${m.concession.from} → ${m.concession.to}`;
    case 'Accept':
      return `${name(m.from)} → ${name(m.to)} · re ${m.replyTo} · terms ${shortHash(m.termsHash, 12)}`;
    case 'Reject':
      return `${name(m.from)} → ${name(m.to)} · re ${m.replyTo} · ${m.reason}`;
    case 'Withdraw':
      return `${name(m.from)} withdrew ${m.offer} · ${m.reason}`;
    case 'Expire':
      return `${m.ref} expired`;
  }
}

export function Evidence({ market }: { market?: string }) {
  const { s, api, world: liveWorld } = useStore();
  const own = !!market && s.market?.market === market;
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [events, setEvents] = useState<MarketEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const entity = entityFromHash();

  useEffect(() => {
    if (!market || own) return;
    let alive = true;
    api
      .market(market)
      .then((r) => alive && setSnap(r))
      .catch((e) => alive && setErr(errorText(e)));
    api
      .events(market)
      .then((r) => alive && setEvents(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, market, own]);

  if (!market) {
    return (
      <div className="page ev-page">
        <div className="act-head">
          <div className="act-num">Evidence</div>
          <h1 className="h2">Start a deal to see its evidence.</h1>
          <p className="lede">
            <a href="#/">Back to the first screen</a>
          </p>
        </div>
      </div>
    );
  }

  const world: World | undefined = own ? (liveWorld ?? s.market?.world) : snap?.world;
  const evs = own ? s.events : (events ?? []);
  const agreement: Agreement | null | undefined = own ? (s.recovery?.agreement ?? s.agreement) : snap?.agreement;
  const payments: PaymentIntent[] = own ? Object.values(s.payments) : (snap?.payments ?? []);
  const neg = own ? s.negotiation : snap?.run;
  const before = own ? s.analysis?.report : (neg?.before ?? undefined);
  const name = (id?: string) => world?.actors.find((a) => a.id === id)?.name ?? id ?? '–';
  const messages = neg?.messages ?? evs.filter((e) => e.type === 'negotiation.message').map((e) => e.data as NegotiationMessage);

  return (
    <div className="page ev-page">
      <div className="act-head" style={{ maxWidth: 900 }}>
        <div className="act-num">Evidence</div>
        <h1 className="h2">Every claim on the deal page, traced to its record.</h1>
        <p className="lede">
          Market <span className="mono">{market}</span> · {evs.length} recorded events.
        </p>
      </div>
      {err ? <ErrorNote title="This market could not be loaded.">{err}</ErrorNote> : null}
      {!own && !snap && !err ? <Waiting>Loading the record</Waiting> : null}

      <div className="ev-grid">
        <div className="panel ev-card wide">
          <div className="h3">From payment back to your objective</div>
          <EvidenceTrail market={market} entity={entity} loading="Tracing the record" fallback={<p className="fine">Trail view unavailable in this build.</p>} />
        </div>

        <div className="panel ev-card wide">
          <div className="h3">Replay</div>
          <Replay
            market={market}
            api={api}
            world={world}
            events={evs.length ? evs : undefined}
            agreement={agreement ?? undefined}
            recovery={own ? s.recovery : undefined}
            payments={payments}
            loading="Loading the replay"
            fallback={<EventRows events={evs} />}
          />
        </div>

        <Report title="First solve: published offers" report={before} />
        <Report title="Re-solve after accepted changes" report={neg?.report} verification={neg?.verification} />

        <div className="panel ev-card">
          <div className="h3">
            Negotiation messages
          </div>
          {messages.length ? (
            <ol className="msg-list">
              {messages.map((m) => (
                <li className="msg" key={m.id}>
                  <span className="ty">{m.type}</span>
                  <span>
                    {msgLine(m, name)} <span className="mono" style={{ color: 'var(--ink-3)' }}>{m.id}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="fine">No messages yet.</p>
          )}
          {neg?.decisions.length ? (
            <>
              <div className="h3" style={{ marginTop: 18 }}>
                Decisions
              </div>
              <ol className="msg-list">
                {neg.decisions.map((d) => (
                  <li className="msg" key={d.message}>
                    <span className="ty">{d.accept ? 'accept' : d.counter ? 'counter' : 'reject'}</span>
                    <span>
                      re <span className="mono">{d.message}</span> · {d.reason} <SourceTag kind={d.basis === 'seller-terminal' ? 'terminal' : 'policy'}>{d.basis === 'seller-terminal' ? 'Person at seller terminal' : 'Private supplier policy'}</SourceTag>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>

        <div className="panel ev-card">
          <div className="h3">Signed terms</div>
          {agreement ? (
            <>
              <dl className="kv">
                <dt>Agreement</dt>
                <dd className="mono">
                  {agreement.id} v{agreement.version} · {agreement.state}
                </dd>
                <dt>Terms hash</dt>
                <dd className="mono">
                  {agreement.termsHash}
                  <Copy text={agreement.termsHash} label="terms hash" />
                </dd>
              </dl>
              <ol className="msg-list" style={{ marginTop: 12 }}>
                {agreement.acceptances.map((a) => (
                  <li className="msg" key={a.actor + a.message}>
                    <span className="ty">{name(a.actor)}</span>
                    <span>
                      <span className="mono">{shortHash(a.termsHash, 16)}</span>{' '}
                      <span className="match" data-ok={a.termsHash === agreement.termsHash}>
                        {a.termsHash === agreement.termsHash ? '✓ matches' : 'differs'}
                      </span>{' '}
                      <span style={{ color: 'var(--ink-3)' }}>· {a.basis}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="fine">Nothing committed yet.</p>
          )}
          <div className="h3" style={{ marginTop: 22 }}>
            PayPal records <SourceTag kind="sandbox" />
          </div>
          {payments.length ? (
            <ol className="msg-list">
              {payments.map((p) => (
                <li className="msg" key={p.id}>
                  <span className="ty">{p.paypal.status ?? p.state}</span>
                  <span>
                    {name(p.payee)} · {money(p.charged)} · order <span className="mono">{p.paypal.orderId ?? '–'}</span>
                    {p.paypal.captureId ? (
                      <>
                        {' '}
                        · capture <span className="mono">{p.paypal.captureId}</span>
                      </>
                    ) : null}
                    {p.paypal.refunds.map((r) => (
                      <span key={r.id}>
                        {' '}
                        · refund <span className="mono">{r.id}</span>
                      </span>
                    ))}
                    {p.paypal.lastFetchedAt ? <span style={{ color: 'var(--ink-3)' }}> · fetched {stamp(p.paypal.lastFetchedAt)}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="fine">No PayPal orders yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
