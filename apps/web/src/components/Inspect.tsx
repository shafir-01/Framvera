import { useEffect, useState } from 'react';
import type { MarketEvent, Offer, World } from '@framvera/contracts';
import { useStore } from '../store.tsx';
import { money, stamp, weekday } from '../lib/format.ts';
import { Drawer, SourceTag, sourceKind } from './ui.tsx';
import { errorText } from '../store.tsx';

const FIELD: Record<string, string> = {
  unitPrice: 'Price',
  windowEnd: 'Finish time',
  windowStart: 'Start time',
  capacity: 'Capacity',
  minQty: 'Minimum order',
  setupFee: 'Setup fee',
  joint: 'Shared runs',
};

export function EventRows({ events }: { events: MarketEvent[] }) {
  return (
    <ol className="event-list">
      {events.map((e) => (
        <li className="event" key={e.id}>
          <span className="seq num">#{e.seq}</span>
          <span>
            <span className="ty">{e.type}</span> <SourceTag kind={sourceKind(e.source)} />
          </span>
          <span className="at">{stamp(e.at).split(', ')[1] ?? stamp(e.at)}</span>
        </li>
      ))}
    </ol>
  );
}

export function InspectOffer({ offer, world, onClose }: { offer: Offer | null; world: World | undefined; onClose: () => void }) {
  const { api, s } = useStore();
  const [trace, setTrace] = useState<MarketEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const market = s.market?.market;

  useEffect(() => {
    setTrace(null);
    setErr(null);
    if (!offer || !market) return;
    let alive = true;
    api
      .trace(market, offer.id)
      .then((r) => alive && setTrace(r.events))
      .catch((e) => alive && setErr(errorText(e)));
    return () => {
      alive = false;
    };
  }, [api, market, offer]);

  const actor = world?.actors.find((a) => a.id === offer?.actor);
  const stage = world?.stages.find((st) => st.id === offer?.stage);
  const claims = world?.claims.filter((c) => offer?.claims.includes(c.id)) ?? [];
  const finding = s.invention?.findings.filter((f) => offer?.claims.includes(f.claim)) ?? [];

  return (
    <Drawer open={!!offer} onClose={onClose} label="Offer details" eyebrow={stage?.name ?? 'Offer'} title={actor?.name ?? offer?.actor ?? ''}>
      {offer ? (
        <>
          <div>
            <div className="h3">
              Published offer <SourceTag kind={sourceKind(offer.provenance.source)} />
              {offer.derivedFrom ? <SourceTag kind="new">Changed by agreement</SourceTag> : null}
            </div>
            <dl>
              <div className="proof-row">
                <dt>Capacity</dt>
                <dd className="num">
                  {offer.capacity} {stage?.unit} <span style={{ color: 'var(--ink-3)' }}>(claimed)</span>
                </dd>
              </div>
              <div className="proof-row">
                <dt>Price</dt>
                <dd className="num">
                  {offer.tiers.map((t) => `${money(t.unit)} from ${t.minQty}`).join(' · ')}
                  {offer.setupFee.minor ? ` · setup ${money(offer.setupFee)}` : ''}
                </dd>
              </div>
              <div className="proof-row">
                <dt>Window</dt>
                <dd className="num">
                  {weekday(offer.window.start)} to {weekday(offer.window.end)}
                </dd>
              </div>
              <div className="proof-row">
                <dt>Pace</dt>
                <dd className="num">
                  {offer.ratePerHour} per hour · handoff {offer.handoffHours} h
                </dd>
              </div>
              <div className="proof-row">
                <dt>Open to change</dt>
                <dd>{offer.negotiable.length ? offer.negotiable.map((f) => FIELD[f] ?? f).join(', ') : 'Nothing signalled'}</dd>
              </div>
              <div className="proof-row">
                <dt>Record</dt>
                <dd className="mono">
                  {offer.id} v{offer.version} · {stamp(offer.provenance.observedAt)}
                </dd>
              </div>
            </dl>
          </div>
          {claims.length ? (
            <div>
              <div className="h3">Claims</div>
              {claims.map((c) => (
                <div className="proof-row" key={c.id}>
                  <dt>{c.tier.replace('-', ' ')}</dt>
                  <dd>
                    {c.assertion}
                    {c.contradictedBy?.length ? <div style={{ color: 'var(--ink)', marginTop: 4 }}>Contradicted by {c.contradictedBy.join(', ')}</div> : null}
                  </dd>
                </div>
              ))}
              {finding.map((f, i) => (
                <p className="fine" key={i}>
                  {f.text}
                </p>
              ))}
            </div>
          ) : null}
          {actor?.description ? (
            <div>
              <div className="h3">
                Supplier’s own description <span className="count">shown as text, never followed</span>
              </div>
              <p className="fine" style={{ margin: 0, fontStyle: 'italic' }}>
                “{actor.description}”
              </p>
            </div>
          ) : null}
          <div>
            <div className="h3">Record trail</div>
            {err ? <p className="fine">{err}</p> : trace ? <EventRows events={trace} /> : <p className="fine">Loading…</p>}
          </div>
        </>
      ) : null}
    </Drawer>
  );
}
