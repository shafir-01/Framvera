import { useState } from 'react';
import type { Id, PaymentIntent } from '@framvera/contracts';
import { payeesOf, useStore } from '../store.tsx';
import { count, money, stamp } from '../lib/format.ts';
import { Copy, Drawer, ErrorNote, SourceTag } from './ui.tsx';
import { PayPalButtons } from './PayPalButtons.tsx';

const STATE_TEXT: Record<string, string> = {
  PAYMENT_PROPOSED: 'Approved by you',
  ORDER_CREATED: 'Order created',
  PAYER_ACTION_REQUIRED: 'Waiting for PayPal approval',
  APPROVED: 'Approved in PayPal',
  CAPTURE_PENDING: 'Capturing',
  CAPTURE_COMPLETED: 'Paid',
  CAPTURE_DENIED: 'Capture denied',
  CAPTURE_UNKNOWN: 'Outcome unknown, check PayPal',
  VOIDED: 'Voided',
  REFUND_PENDING: 'Refund pending',
  REFUND_COMPLETED: 'Refunded',
  REFUND_DENIED: 'Refund denied',
  REFUND_UNKNOWN: 'Refund outcome unknown',
};

export const paid = (p?: PaymentIntent) => p?.state === 'CAPTURE_COMPLETED';

function Row({ k, v, copy }: { k: string; v?: string | number | null; copy?: boolean }) {
  return (
    <div className="proof-row">
      <dt>{k}</dt>
      <dd className={copy ? 'mono' : undefined}>
        {v === undefined || v === null || v === '' ? <span style={{ color: 'var(--ink-3)' }}>Not returned</span> : v}
        {copy && v ? <Copy text={String(v)} label={k} /> : null}
      </dd>
    </div>
  );
}

export function ProofDrawer({ payment, onClose }: { payment: PaymentIntent | null; onClose: () => void }) {
  const { s, act, world } = useStore();
  const live = payment ? (s.payments[payment.id] ?? payment) : null;
  const name = world?.actors.find((a) => a.id === live?.payee)?.name ?? live?.payee;
  const busy = (s.busy === 'refresh' || s.busy === 'refund') && s.busyKey === live?.id;
  return (
    <Drawer open={!!live} onClose={onClose} label="PayPal proof" eyebrow={<SourceTag kind="sandbox">PayPal Sandbox · test money</SourceTag>} title={`Payment to ${name ?? ''}`}>
      {live ? (
        <>
          <dl>
            <Row k="PayPal status" v={live.paypal.status} />
            <Row k="Order id" v={live.paypal.orderId} copy />
            <Row k="Capture id" v={live.paypal.captureId} copy />
            {live.paypal.refunds.map((r) => <Row key={r.id} k="Refund id" v={`${r.id} · ${money(r.amount)} · ${r.status}`} />)}
            <Row k="Fetched from PayPal" v={live.paypal.lastFetchedAt ? stamp(live.paypal.lastFetchedAt) : undefined} />
          </dl>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-quiet btn-small" disabled={busy} onClick={() => void act.refreshPayment(live.id)}>
              {s.busy === 'refresh' && s.busyKey === live.id ? 'Fetching…' : 'Fetch again from PayPal'}
            </button>
            {paid(live) ? (
              <button className="btn btn-quiet btn-small" disabled={busy} onClick={() => void act.refund(live.id)}>
                {s.busy === 'refund' && s.busyKey === live.id ? 'Refunding…' : `Approve refund of ${money(live.charged)}`}
              </button>
            ) : null}
          </div>
          {s.error && (s.error.step === 'refresh' || s.error.step === 'refund') ? <ErrorNote title="PayPal did not confirm.">{s.error.message}</ErrorNote> : null}
          <div>
            <div className="h3">In Framvera</div>
            <dl>
              <Row k="Payment state" v={STATE_TEXT[live.state] ?? live.state} />
              <Row k="Owed for" v={`${count(live.obligations.length, 'obligation')} in agreement ${live.agreement}`} />
              <Row k="Amount owed" v={money(live.amount)} />
              <Row k="Sent to PayPal" v={`${money(live.charged)}${live.fx ? ` at ${live.fx.rate} (${live.fx.source})` : ''}`} />
              <Row k="Record" v={live.id} copy />
            </dl>
          </div>
          <p className="fine" style={{ margin: 0 }}>
            Supplier names are from the synthetic market.
          </p>
          {s.market ? (
            <a className="top-link" style={{ alignSelf: 'start', padding: 0 }} href={`#/evidence/${encodeURIComponent(s.market.market)}?entity=${encodeURIComponent(live.id)}`}>
              Trace to your objective
            </a>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}

export function Commit() {
  const { s, act, api, world } = useStore();
  const [proof, setProof] = useState<PaymentIntent | null>(null);
  const [active, setActive] = useState<Id | null>(null);
  const [ppError, setPpError] = useState<string | null>(null);
  const ag = s.agreement;
  if (!ag || !s.market) return null;
  const payees = payeesOf(ag);
  const status = s.status?.paypal;
  const payFor = (actor: Id) => Object.values(s.payments).find((p) => p.payee === actor && p.agreement === ag.id);
  const firstOpen = payees.find((p) => !paid(payFor(p.actor)) && !payFor(p.actor)?.state.startsWith('REFUND'));
  const current = payees.find((p) => p.actor === active) ?? firstOpen;
  const name = (id: Id) => world?.actors.find((a) => a.id === id)?.name ?? id;
  const doneCount = payees.filter((p) => paid(payFor(p.actor))).length;
  const currency = status?.currency ?? current?.amount.currency ?? 'SEK';
  const currentPi = current ? payFor(current.actor) : undefined;

  return (
    <section className="act" id="commit" tabIndex={-1} aria-labelledby="commit-h">
      <div className="act-head">
        <div className="act-num">Commit · Payment</div>
        <h2 className="h2" id="commit-h">
          {doneCount === payees.length && payees.length ? 'Every supplier is paid.' : 'Pay each supplier, one approval at a time.'}
        </h2>
      </div>

      <div className="pay">
        <div className="pay-left">
          <div className="h3">
            Payments <span className="count">{doneCount} of {payees.length} paid</span>
          </div>
          <ol className="payee-list">
            {payees.map((p) => {
              const pi = payFor(p.actor);
              const isCurrent = current?.actor === p.actor;
              return (
                <li key={p.actor} className="payee" data-current={isCurrent} data-paid={paid(pi)}>
                  <button className="payee-main" onClick={() => setActive(p.actor)} aria-pressed={isCurrent}>
                    <span className="payee-name">{name(p.actor)}</span>
                    <span className="payee-amt num">{money(p.amount)}</span>
                    <span className="payee-state">
                      <span className="verdict-dot" aria-hidden="true" />
                      {pi ? (STATE_TEXT[pi.state] ?? pi.state) : <span className="sr-only">Not started</span>}
                    </span>
                  </button>
                  {pi ? (
                    <button className="copy" onClick={() => setProof(pi)} aria-label={`PayPal proof for ${name(p.actor)}`}>
                      Proof
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="pay-right">
          {!status?.configured ? (
            <ErrorNote title="PayPal Sandbox is not configured on this server.">No payment can be made here, and nothing on this page is shown as paid.</ErrorNote>
          ) : current ? (
            <>
              <div>
                <div className="eyebrow">
                  <SourceTag kind="sandbox" />
                </div>
                <div className="pay-amount">{money(current.amount)}</div>
                <div className="fine">
                  To {name(current.actor)}. Paying approves exactly this amount under terms {ag.termsHash.slice(0, 8)}.
                </div>
              </div>
              {paid(currentPi) ? (
                <div className="pay-state" data-ok="true">
                  <span className="verdict-dot" aria-hidden="true" /> Paid
                </div>
              ) : import.meta.env.DEV && api.mode === 'fixture' ? (
                <button
                  className="btn btn-quiet"
                  onClick={async () => {
                    const pi = await act.startPayment(current.actor);
                    if (pi) await act.capture(pi.id);
                  }}
                >
                  Simulate sandbox approval (dev fixture)
                </button>
              ) : status.clientId ? (
                <PayPalButtons
                  key={current.actor}
                  clientId={status.clientId}
                  currency={currency}
                  label={`Pay ${name(current.actor)} with PayPal Sandbox`}
                  createOrder={async () => {
                    setPpError(null);
                    const pi = await act.startPayment(current.actor);
                    if (!pi?.paypal.orderId) throw new Error('No PayPal order was created.');
                    return pi.paypal.orderId;
                  }}
                  onApprove={async () => {
                    const pi = payFor(current.actor) ?? (await act.startPayment(current.actor));
                    if (pi) await act.capture(pi.id);
                  }}
                  onError={setPpError}
                />
              ) : currentPi?.paypal.approveUrl ? (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <a className="btn btn-primary" href={currentPi.paypal.approveUrl} target="_blank" rel="noopener">
                    Approve in PayPal
                  </a>
                  <button className="btn btn-quiet" onClick={() => void act.capture(currentPi.id)} disabled={s.busy === 'capture'}>
                    {s.busy === 'capture' ? 'Capturing…' : 'Capture after approval'}
                  </button>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={() => void act.startPayment(current.actor)} disabled={s.busy === 'pay'}>
                  {s.busy === 'pay' ? 'Creating order…' : 'Create PayPal order'}
                </button>
              )}
              {s.busy === 'capture' ? <div className="fine">Capturing with PayPal…</div> : null}
              {ppError ? <ErrorNote title="Not paid.">{ppError}</ErrorNote> : null}
              {s.error && ['pay', 'capture'].includes(s.error.step) ? <ErrorNote title="PayPal did not complete this step.">{s.error.message}</ErrorNote> : null}
            </>
          ) : (
            <div className="pay-state" data-ok="true">
              <span className="verdict-dot" aria-hidden="true" /> All paid.
            </div>
          )}
        </div>
      </div>
      <ProofDrawer payment={proof} onClose={() => setProof(null)} />
    </section>
  );
}
