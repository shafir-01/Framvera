import type { GridApi } from 'ag-grid-community';
import type { PaymentIntent } from '@framvera/contracts';
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { claimColumns, coalitionColumns, offerColumns, paymentColumns, questionColumns, Chip } from './columns.tsx';
import { DetailPanel } from './DetailPanel.tsx';
import {
  buildClaimRows,
  buildCoalitionRows,
  buildOfferRows,
  buildPaymentRows,
  buildQuestionRows,
  claimDetail,
  coalitionDetail,
  groupOfferRows,
  indexMarket,
  offerDetail,
  paymentDetail,
  questionDetail,
  summary,
  type Detail,
  type OfferGridRow,
} from './model.ts';
import { ObsGrid, type GridContext } from './ObsGrid.tsx';
import type { ObservatoryProps } from '../api.ts';
import { toMarket, type TabId } from './types.ts';
import './observatory.css';

const TABS: { id: TabId; label: string }[] = [
  { id: 'offers', label: 'Offers' },
  { id: 'coalitions', label: 'Coalitions' },
  { id: 'questions', label: 'Questions' },
  { id: 'claims', label: 'Claims' },
  { id: 'payments', label: 'Payments' },
];

const EMPTY: Record<TabId, string> = {
  offers: 'No offers in this market yet.',
  coalitions: 'No coalition has been proposed.',
  questions: 'No questions have been selected yet.',
  claims: 'No claims have been recorded.',
  payments: 'No payment yet.',
};

export function Observatory(props: ObservatoryProps) {
  const { api, theme } = props;
  const uid = useId();
  const [tab, setTab] = useState<TabId>('offers');
  const [selected, setSelected] = useState<Partial<Record<TabId, string>>>({});
  const [filter, setFilter] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const apis = useRef<GridApi | null>(null);

  const [fresh, setFresh] = useState<Record<string, PaymentIntent>>({});
  const [refreshError, setRefreshError] = useState('');
  const market = useMemo(() => {
    const m = toMarket(props);
    return { ...m, payments: m.payments.map((p) => fresh[p.id] ?? p) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.market, props.world, props.intent, props.invention, props.negotiation, props.agreement, props.payments, props.recovery, props.events, fresh]);
  const now = useMemo(() => Date.now(), [props.world, props.events]);
  const ix = useMemo(() => indexMarket(market), [market]);
  const offerRows = useMemo(() => buildOfferRows(ix, now), [ix, now]);
  const coalitionRows = useMemo(() => buildCoalitionRows(ix), [ix]);
  const questionRows = useMemo(() => buildQuestionRows(ix), [ix]);
  const claimRows = useMemo(() => buildClaimRows(ix, now), [ix, now]);
  const paymentRows = useMemo(() => buildPaymentRows(ix), [ix]);
  const facts = useMemo(() => summary(offerRows, ix, now), [offerRows, ix, now]);

  const flat = !grouped || filter.trim() !== '';
  const offerGrid = useMemo<OfferGridRow[]>(() => (flat ? offerRows : groupOfferRows(ix, offerRows, collapsed)), [flat, ix, offerRows, collapsed]);
  const offerCols = useMemo(() => offerColumns(!flat), [flat]);

  const counts: Record<TabId, number> = { offers: offerRows.length, coalitions: coalitionRows.length, questions: questionRows.length, claims: claimRows.length, payments: paymentRows.length };

  const select = useCallback(
    (t: TabId, id: string | undefined, say?: string) => {
      setSelected((s) => ({ ...s, [t]: id }));
      if (say) setAnnounce(say);
    },
    [],
  );

  const go = (t: TabId, id: string) => {
    setTab(t);
    setFilter('');
    select(t, id);
  };

  const context = useMemo<GridContext>(
    () => ({
      toggleGroup: (stage) =>
        setCollapsed((c) => {
          const n = new Set(c);
          if (n.has(stage)) n.delete(stage);
          else n.add(stage);
          return n;
        }),
    }),
    [],
  );

  const sel = selected[tab];
  const detail: Detail | undefined = useMemo(() => {
    if (!sel) return undefined;
    switch (tab) {
      case 'offers': {
        const o = ix.offerById.get(sel);
        return o ? offerDetail(ix, o, now) : undefined;
      }
      case 'coalitions': {
        const r = coalitionRows.find((x) => x.rowId === sel);
        return r ? coalitionDetail(ix, r) : undefined;
      }
      case 'questions': {
        const r = questionRows.find((x) => x.rowId === sel);
        return r ? questionDetail(r) : undefined;
      }
      case 'claims': {
        const r = claimRows.find((x) => x.rowId === sel);
        return r ? claimDetail(ix, r) : undefined;
      }
      case 'payments': {
        const r = paymentRows.find((x) => x.rowId === sel);
        return r ? paymentDetail(ix, r) : undefined;
      }
    }
  }, [tab, sel, ix, now, coalitionRows, questionRows, claimRows, paymentRows]);

  const refresh = async (id: string) => {
    setBusy(true);
    setRefreshError('');
    try {
      const p = await api.payment(id);
      setFresh((f) => ({ ...f, [id]: p }));
      setAnnounce('Payment state fetched from PayPal');
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'PayPal state could not be fetched.');
    } finally {
      setBusy(false);
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -i : e.key === 'End' ? TABS.length - 1 - i : 0;
    if (!d) return;
    e.preventDefault();
    const next = TABS[(i + d + TABS.length) % TABS.length]!;
    setTab(next.id);
    document.getElementById(`${uid}-tab-${next.id}`)?.focus();
  };

  const exportCsv = () =>
    apis.current?.exportDataAsCsv({
      fileName: `framvera-${tab}`,
      shouldRowBeSkipped: (p) => (p.node.data as { kind?: string } | undefined)?.kind === 'group',
    });

  const grid = (() => {
    const common = { onSelect: (id: string | undefined) => select(tab, id, id ? 'Provenance panel updated' : undefined), selectedId: sel, quickFilter: filter, apiRef: apis };
    switch (tab) {
      case 'offers':
        return (
          <ObsGrid<OfferGridRow>
            key={flat ? 'flat' : 'grouped'}
            rows={offerGrid}
            columns={offerCols}
            grouped={!flat}
            context={context}
            isSelectable={(r) => r.kind === 'offer'}
            getRowClass={(r) => (r.kind !== 'offer' ? undefined : r.blocking ? 'obs-row-blocking' : r.statuses.includes('derived') ? 'obs-row-derived' : undefined)}
            {...common}
          />
        );
      case 'coalitions':
        return <ObsGrid rows={coalitionRows} columns={coalitionColumns} {...common} />;
      case 'questions':
        return <ObsGrid rows={questionRows} columns={questionColumns} {...common} />;
      case 'claims':
        return <ObsGrid rows={claimRows} columns={claimColumns} getRowClass={(r) => (r.verdict === 'contradicted' ? 'obs-row-contradicted' : undefined)} {...common} />;
      case 'payments':
        return <ObsGrid rows={paymentRows} columns={paymentColumns} {...common} />;
    }
  })();

  return (
    <section className="obs" data-obs-theme={theme} aria-label="Economic observatory">
      <div className="obs-head">
        <ul className="obs-facts" aria-label="Market at a glance">
          <li>
            <b>{facts.offers}</b> offers
          </li>
          <li className={facts.blocking ? 'is-bad' : undefined}>
            <b>{facts.blocking}</b> blocking
          </li>
          <li>
            <b>{facts.derived}</b> derived
          </li>
          <li className={facts.contradicted ? 'is-bad' : undefined}>
            <b>{facts.contradicted}</b> contradicted
          </li>
        </ul>
        <span className="obs-muted" role={refreshError ? 'alert' : undefined}>
          {refreshError}
        </span>
      </div>

      <div className="obs-tabs" role="tablist" aria-label="Observatory views">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`${uid}-tab-${t.id}`}
            type="button"
            role="tab"
            className="obs-tab"
            aria-selected={tab === t.id}
            aria-controls={`${uid}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
            <small>{counts[t.id]}</small>
          </button>
        ))}
      </div>

      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`} className="obs-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <div className="obs-bar">
          <input className="obs-input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows" aria-label={`Filter ${TABS.find((t) => t.id === tab)!.label}`} />
          {tab === 'offers' ? (
            <label className="obs-check">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              Group by stage
            </label>
          ) : null}
          {tab === 'payments' ? <Chip tone="sandbox">Sandbox</Chip> : null}
          <span className="grow" />
          {tab === 'payments' ? (
            <button
              type="button"
              className="obs-btn"
              disabled={busy || !paymentRows.length}
              onClick={async () => {
                for (const r of paymentRows) await refresh(r.rowId);
              }}
            >
              Refresh
            </button>
          ) : null}
          <button type="button" className="obs-btn" onClick={exportCsv} disabled={!counts[tab]}>
            Export CSV
          </button>
        </div>

        <div className={`obs-body${detail ? ' has-detail' : ''}`}>
          <div className="obs-gridwrap" role="region" aria-label={`${TABS.find((t) => t.id === tab)!.label} table`}>
            {counts[tab] ? grid : <div className="obs-empty">{EMPTY[tab]}</div>}
          </div>
          {detail ? (
            <DetailPanel
              detail={detail}
              onClose={() => select(tab, undefined)}
              onGo={go}
              action={tab === 'payments' && sel ? { label: 'Fetch latest from PayPal', busy, run: () => void refresh(sel) } : undefined}
            />
          ) : null}
        </div>
      </div>
      <div className="obs-sr" role="status" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}
