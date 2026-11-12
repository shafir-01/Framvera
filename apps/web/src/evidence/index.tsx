import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Id, MarketEvent } from '@framvera/contracts';
import { Copy, ErrorNote, SourceTag, Waiting, sourceKind } from '../components/ui.tsx';
import { shortHash, stamp } from '../lib/format.ts';
import { buildBundle, downloadBundle } from './bundle.ts';
import { buildTrace } from './chain.ts';
import { httpEvidenceSource } from './source.ts';
import type { Candidate, Dossier, EvidenceSource, Fact, NodeSource, Trace, TraceItem, TraceNode } from './types.ts';
import './evidence.css';

export interface EvidenceTrailProps {
  market: Id;
  /** Any id the trail can start from: payment, PayPal order, capture or refund id, agreement, obligation, claim, offer, supplier or disruption. Defaults to the latest payment. */
  entity?: Id;
  /** Override where records come from. Defaults to the Framvera API. */
  source?: EvidenceSource;
}

function SourceLabel({ source }: { source: NodeSource }) {
  switch (source) {
    case 'supplier-policy':
      return <SourceTag kind="policy">Supplier policy</SourceTag>;
    case 'planner-estimate':
      return <SourceTag kind="estimate">Planner estimate</SourceTag>;
    case 'model-proposal':
      return <SourceTag kind="estimate">Model proposal</SourceTag>;
    default:
      return <SourceTag kind={sourceKind(source)} />;
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function Time({ at }: { at?: string }) {
  if (!at) return null;
  return (
    <time dateTime={at} title={at}>
      {stamp(at)}
    </time>
  );
}

function FactValue({ f }: { f: Fact }) {
  const v = ISO.test(f.value) ? stamp(f.value) : f.value;
  return (
    <>
      {f.mono ? <code title={f.value}>{f.value.length > 36 ? shortHash(f.value, 14) : v}</code> : v}
      {f.copy ? <Copy text={f.value} label={f.label} /> : null}
      {f.estimate ? (
        <>
          {' '}
          <SourceTag kind="estimate">Planner estimate</SourceTag>
        </>
      ) : null}
    </>
  );
}

function Facts({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <dl className="evt-facts">
      {facts.map((f, i) => (
        <div key={`${f.label}:${i}`} style={{ display: 'contents' }}>
          <dt>{f.label}</dt>
          <dd data-tone={f.tone}>
            {f.tone === 'bad' ? <span className="sr-only">Attention: </span> : null}
            <FactValue f={f} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Item({ item, nodeKey, index, onFollow }: { item: TraceItem; nodeKey: string; index: number; onFollow: (id: Id) => void }) {
  const [open, setOpen] = useState(false);
  const has = Boolean(item.facts?.length);
  const panel = `evt-${nodeKey}-${index}`;
  return (
    <li className="evt-item" data-tone={item.tone}>
      <div className="evt-item-row">
        <button className="evt-toggle" data-static={!has} aria-expanded={has ? open : undefined} aria-controls={has ? panel : undefined} onClick={() => has && setOpen(!open)}>
          {item.title}
        </button>
        {item.meta ? <span className="evt-item-meta">{item.meta}</span> : null}
        {item.source ? <SourceLabel source={item.source} /> : null}
        {item.at ? (
          <span className="evt-item-meta">
            <Time at={item.at} />
          </span>
        ) : null}
        {item.follow ? (
          <button className="evt-link" onClick={() => onFollow(item.follow!)} aria-label={`Trace from ${item.title}`}>
            Trace from here
          </button>
        ) : null}
      </div>
      {has && open ? (
        <div id={panel}>
          <Facts facts={item.facts!} />
        </div>
      ) : null}
    </li>
  );
}

function Node({ node, onFollow, extra }: { node: TraceNode; onFollow: (id: Id) => void; extra?: ReactNode }) {
  return (
    <li className="evt-step" data-tone={node.tone}>
      <div className="evt-node" data-node tabIndex={0} aria-label={`${node.kind}: ${node.title}`}>
        <div className="evt-node-top">
          <span className="evt-kind">{node.kind}</span>
          <span className="evt-meta">
            <Time at={node.at} />
            <SourceLabel source={node.source} />
          </span>
        </div>
        <h3>{node.title}</h3>
        {node.note ? <p className="evt-note">{node.note}</p> : null}
        {node.ids.length ? (
          <div className="evt-ids">
            {node.ids.map((id) => (
              <div className="evt-id" key={id.label + id.value}>
                <span>{id.label}</span>
                <code title={id.value}>{id.value.length > 40 ? shortHash(id.value, 18) : id.value}</code>
                <Copy text={id.value} label={id.label.toLowerCase()} />
              </div>
            ))}
          </div>
        ) : null}
        <Facts facts={node.facts} />
        {extra}
        {node.items.length ? (
          <ul className="evt-items">
            {node.items.map((it, i) => (
              <Item key={`${it.title}:${i}`} item={it} nodeKey={node.key} index={i} onFollow={onFollow} />
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function Chips({ candidates, current, onPick }: { candidates: Candidate[]; current?: Id; onPick: (id: Id) => void }) {
  const groups = ['Payments', 'Agreement', 'Failed or contradicted'] as const;
  return (
    <nav className="evt-from" aria-label="Trace from">
      {groups.map((g) => {
        const list = candidates.filter((c) => c.group === g);
        if (!list.length) return null;
        return (
          <div className="evt-from-group" key={g} role="group" aria-label={g}>
            <span className="evt-from-label">{g}</span>
            {list.map((c) => (
              <button key={c.id} className="evt-chip" aria-pressed={c.id === current} title={c.label} onClick={() => onPick(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

function moveFocus(e: KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (!root || !(e.target as HTMLElement).hasAttribute('data-node')) return;
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-node]')];
  const at = nodes.indexOf(e.target as HTMLElement);
  const next = e.key === 'ArrowDown' || e.key === 'j' ? at + 1 : e.key === 'ArrowUp' || e.key === 'k' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : -1;
  if (next < 0 || next >= nodes.length) return;
  e.preventDefault();
  nodes[next]!.focus();
  nodes[next]!.scrollIntoView({ block: 'nearest' });
}

async function pickSource(given?: EvidenceSource): Promise<EvidenceSource> {
  if (given) return given;
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURE === '1') return (await import('./dev/fixture.ts')).fixtureSource();
  return httpEvidenceSource(import.meta.env.VITE_API_URL ?? '');
}

interface Loaded {
  dossier: Dossier;
  events: MarketEvent[];
}

export function EvidenceTrail({ market, entity: entityProp, source: given }: EvidenceTrailProps) {
  const [src, setSrc] = useState<EvidenceSource>();
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [entity, setEntity] = useState<Id | undefined>(entityProp);
  const [ledger, setLedger] = useState<MarketEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setEntity(entityProp), [entityProp, market]);
  useEffect(() => {
    let live = true;
    pickSource(given).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [given]);

  const load = useCallback(async () => {
    if (!src) return;
    setBusy(true);
    setError(undefined);
    try {
      const dossier = await src.dossier(market);
      const events = await src.events(market).catch(() => [] as MarketEvent[]);
      setData({ dossier, events });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The records could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [src, market]);
  useEffect(() => {
    setData(undefined);
    void load();
  }, [load]);

  const trace: Trace | undefined = useMemo(() => (data ? buildTrace(data.dossier, data.events.length ? data.events : ledger, entity) : undefined), [data, entity, ledger]);
  const entityId = trace?.entity?.id;

  useEffect(() => {
    if (!src || !entityId) return setLedger([]);
    let live = true;
    src.trace(market, entityId).then(
      (e) => live && setLedger(e),
      () => live && setLedger([]),
    );
    return () => {
      live = false;
    };
  }, [src, market, entityId]);

  const follow = useCallback((id: Id) => {
    setEntity(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const records = useMemo(() => {
    if (!trace || !data) return [];
    if (ledger.length) return ledger;
    const ids = new Set([...trace.backward, ...trace.forward].flatMap((n) => n.events));
    return data.events.filter((e) => ids.has(e.id));
  }, [trace, data, ledger]);

  const payment = trace?.entity?.kind === 'payment' ? data?.dossier.payments.find((p) => p.id === trace.entity!.id) : undefined;

  const refresh = async () => {
    if (!src?.refreshPayment || !payment) return;
    setFetching(true);
    try {
      await src.refreshPayment(payment.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PayPal could not be reached.');
    } finally {
      setFetching(false);
    }
  };

  if (error && !data) {
    return (
      <div className="evt">
        <ErrorNote title="The evidence could not be loaded" onRetry={() => void load()}>
          {error}
        </ErrorNote>
      </div>
    );
  }
  if (!data || !trace) return <Waiting>Loading the records</Waiting>;

  const exportBundle = () => downloadBundle(buildBundle(data.dossier, trace, data.events, ledger));

  return (
    <div className="evt" ref={root} onKeyDown={(e) => moveFocus(e, root.current)}>
      <header className="evt-head">
        <div>
          <h1 className="evt-title">Which fact made this possible, and what did PayPal process?</h1>
        </div>
        <div className="evt-export">
          <button className="btn btn-primary" onClick={exportBundle} disabled={!trace.entity} title="Redacted JSON of this whole chain">
            Export audit bundle
          </button>
        </div>
      </header>

      {error ? <ErrorNote title="Something went wrong">{error}</ErrorNote> : null}

      <Chips candidates={trace.candidates} current={entityId} onPick={setEntity} />

      {trace.notFound ? (
        <p className="evt-empty" role="status">
          {entity ? `No record in this market mentions ${entity}.` : 'Nothing has been committed or paid in this market yet.'}
        </p>
      ) : null}

      {trace.headline ? (
        <section className="evt-answer" aria-label={trace.headline.title}>
          <h2>{trace.headline.title}</h2>
          <ul>
            {trace.headline.changes.map((c) => (
              <li key={c.id}>
                <span>{c.text}</span>
                {c.estimate ? (
                  <span className="evt-item-meta">
                    <SourceTag kind="estimate">Planner estimate</SourceTag> {c.estimate}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p>{trace.headline.caveat}</p>
        </section>
      ) : null}

      {trace.backward.length ? (
        <section className="evt-section" aria-label="How it came about">
          <h2>{trace.entity?.kind === 'payment' ? 'Back to the objective' : 'Back to the objective'}</h2>
          <ol className="evt-list">
            {trace.backward.map((n) => (
              <Node
                key={n.key}
                node={n}
                onFollow={follow}
                extra={
                  n.key === 'paypal' && src?.refreshPayment && payment ? (
                    <p className="evt-note">
                      <button className="btn btn-quiet btn-small" onClick={() => void refresh()} disabled={fetching}>
                        {fetching ? 'Refreshing' : 'Refresh from PayPal'}
                      </button>
                    </p>
                  ) : null
                }
              />
            ))}
          </ol>
        </section>
      ) : null}

      {trace.forward.length ? (
        <section className="evt-section" aria-label="What it endangers">
          <h2>{trace.backward.length ? 'What depends on this' : 'What it endangers'}</h2>
          <ol className="evt-list">
            {trace.forward.map((n) => (
              <Node key={n.key} node={n} onFollow={follow} />
            ))}
          </ol>
        </section>
      ) : null}

      {records.length ? (
        <details className="evt-ledger">
          <summary>Ledger records ({records.length})</summary>
          <ol>
            {records.map((e) => (
              <li key={e.id}>
                <span>#{e.seq}</span>
                <code>{e.type}</code>
                <span>
                  <SourceLabel source={e.source} /> <Time at={e.at} />
                </span>
                <Copy text={e.id} label={`record ${e.id}`} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <p className="evt-foot">Times are Stockholm time.</p>
    </div>
  );
}
