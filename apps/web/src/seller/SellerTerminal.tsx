import { useCallback, useEffect, useRef, useState } from 'react';
import './seller.css';
import { parseSellerHash, seller, SellerError, storageKey, type Proposal, type SellerView } from './client.ts';

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, v);
  } catch {
    /* the seat then lasts until the page is closed */
  }
}

function toInput(p: Proposal): string {
  if (p.input.current === null) return '';
  if (p.input.kind === 'money') return String(p.input.current / 100);
  if (p.input.kind === 'time') {
    const d = new Date(p.input.current);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  return String(p.input.current);
}

function fromInput(p: Proposal, v: string): number | string | null {
  if (!v.trim()) return null;
  if (p.input.kind === 'time') {
    const t = new Date(v);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  }
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return p.input.kind === 'money' ? Math.round(n * 100) : Math.round(n);
}

function ProposalCard({ p, busy, onAnswer }: { p: Proposal; busy: boolean; onAnswer: (a: 'accept' | 'reject' | 'counter', counter?: number | string) => void }) {
  const [counter, setCounter] = useState(false);
  const [value, setValue] = useState(toInput(p));
  useEffect(() => {
    setValue(toInput(p));
    setCounter(false);
  }, [p.termsHash]);
  const parsed = fromInput(p, value);
  const unit = p.input.kind === 'money' ? 'kr' : '';
  return (
    <section className="sl-card" aria-labelledby={`t-${p.id}`}>
      <p className="sl-eyebrow">From {p.from}</p>
      <h2 id={`t-${p.id}`}>
        {p.fieldLabel}: {p.change.from} to {p.change.to}
      </h2>
      <p className="sl-benefit">{p.benefit}</p>
      <h3>If you accept</h3>
      <table className="sl-table">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Measure</span></th>
            <th scope="col">Now</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {p.copilot.lines.map((l, i) => (
            <tr key={i}>
              <th scope="row">{l.label}</th>
              <td>{l.now || '-'}</td>
              <td>{l.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.copilot.notes.map((n, i) => (
        <p key={i} className="sl-note">{n}</p>
      ))}
      {counter ? (
        <div className="sl-counter">
          <label>
            Your counter {unit && `(${unit})`}
            <input
              type={p.input.kind === 'time' ? 'datetime-local' : 'text'}
              inputMode={p.input.kind === 'time' ? undefined : 'decimal'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <div className="sl-row">
            <button className="sl-primary" disabled={busy || parsed === null} onClick={() => parsed !== null && onAnswer('counter', parsed)}>Send counter</button>
            <button className="sl-quiet" disabled={busy} onClick={() => setCounter(false)}>Back</button>
          </div>
        </div>
      ) : (
        <div className="sl-row">
          <button className="sl-primary" disabled={busy} onClick={() => onAnswer('accept')}>Accept</button>
          <button className="sl-quiet" disabled={busy} onClick={() => setCounter(true)}>Counter</button>
          <button className="sl-quiet" disabled={busy} onClick={() => onAnswer('reject')}>Reject</button>
        </div>
      )}
    </section>
  );
}

export function SellerTerminal() {
  const route = useRef(parseSellerHash(window.location.hash));
  const r = route.current;
  const [session, setSession] = useState<string | null>(() => (r ? read(storageKey(r.market, r.actor)) : null));
  const [view, setView] = useState<SellerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (!r || session || !r.seat) return;
    const token = r.seat;
    seller
      .redeem(r.market, r.actor, token)
      .then((x) => {
        write(storageKey(r.market, r.actor), x.session);
        history.replaceState(null, '', `#/seller/${encodeURIComponent(r.market)}/${encodeURIComponent(r.actor)}`);
        setSession(x.session);
      })
      .catch((e: unknown) => setError(e instanceof SellerError ? e.message : 'Could not open this seat'));
  }, [r, session]);

  const refresh = useCallback(async () => {
    if (!r || !session) return;
    try {
      setView(await seller.view(r.market, r.actor, session));
      setError(null);
    } catch (e) {
      if (e instanceof SellerError && (e.status === 401 || e.status === 403)) {
        write(storageKey(r.market, r.actor), null);
        setSession(null);
        setView(null);
      }
      setError(e instanceof Error ? e.message : 'Connection lost');
    }
  }, [r, session]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(t);
  }, [session, refresh]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      setSent(done ?? null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!r) return <main className="sl"><p>This seat link is not valid.</p></main>;
  if (!session) {
    return (
      <main className="sl">
        <h1>Seller terminal</h1>
        <p role={error ? 'alert' : undefined}>{error ?? (r.seat ? 'Opening your seat' : 'Open the seat link you were given to start answering.')}</p>
      </main>
    );
  }

  const p = view?.pending[0];
  const mine = view?.offers[0];
  return (
    <main className="sl">
      <header>
        <p className="sl-eyebrow">Seller terminal</p>
        <h1>{view?.actor.name ?? 'Connecting'}</h1>
        {view && <p className="sl-sub">{view.actor.city}</p>}
      </header>
      {error && <p className="sl-error" role="alert">{error}</p>}
      <div aria-live="polite">
        {sent && <p className="sl-ok">{sent}</p>}
        {view && !p && <p className="sl-empty">No proposal for you right now. This page updates by itself.</p>}
      </div>
      {p && view && (
        <ProposalCard
          p={p}
          busy={busy}
          onAnswer={(a, c) =>
            run(() => seller.answer(r.market, r.actor, session, { termsHash: p.termsHash, action: a, ...(c !== undefined ? { counter: { to: c } } : {}) }), a === 'accept' ? 'Accepted. The buyer sees it now.' : a === 'reject' ? 'Rejected. The buyer sees it now.' : 'Counter sent. The buyer sees it now.')
          }
        />
      )}
      {mine && (
        <section className="sl-card" aria-labelledby="offer-h">
          <h2 id="offer-h">Your offer</h2>
          <dl className="sl-dl">
            <dt>Work</dt><dd>{mine.stage}</dd>
            <dt>Price</dt><dd>{mine.price} per {mine.unit.replace(/s$/, '')}</dd>
            <dt>Capacity</dt><dd>{mine.capacity} {mine.unit}</dd>
            <dt>Minimum order</dt><dd>{mine.minQty} {mine.unit}</dd>
            <dt>Window</dt><dd>{mine.windowStart} to {mine.windowEnd}</dd>
          </dl>
          {view && view.commitments.length > 0 && (
            <>
              <h3>Committed</h3>
              <ul className="sl-list">
                {view.commitments.map((c) => (
                  <li key={c.id}>{c.qty} {mine.unit} due {c.due}, {c.amount}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {mine && view?.canWithdraw && !mine.withdrawn && (
        <section className="sl-card">
          {confirm === mine.id ? (
            <>
              <p>Withdrawing leaves the committed order. The buyer is told and a recovery starts.</p>
              <div className="sl-row">
                <button className="sl-danger" disabled={busy} onClick={() => run(() => seller.withdraw(r.market, r.actor, session, mine.id), 'Withdrawn. The buyer sees it now.').then(() => setConfirm(null))}>Withdraw now</button>
                <button className="sl-quiet" onClick={() => setConfirm(null)}>Keep my offer</button>
              </div>
            </>
          ) : (
            <button className="sl-quiet" onClick={() => setConfirm(mine.id)}>Withdraw from the order</button>
          )}
        </section>
      )}
      {mine?.withdrawn && <p className="sl-empty">You have withdrawn from the order.</p>}
    </main>
  );
}
