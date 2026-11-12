import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { EvidenceTier } from '@framvera/contracts';
import { money, stamp, when } from '../lib/format.ts';
import {
  STATUS_LABEL,
  TIER_LABEL,
  VERDICT_LABEL,
  type ClaimRow,
  type CoalitionRow,
  type OfferGridRow,
  type OfferRow,
  type OfferStatus,
  type PaymentRow,
  type PolicyOutcome,
  type QuestionRow,
  type Tone,
} from './model.ts';

type ToneClass = Tone | 'derived' | 'sandbox';

export function Chip({ tone, children }: { tone?: ToneClass; children: string }) {
  return <span className={`obs-chip${tone && tone !== 'neutral' ? ` t-${tone}` : ''}`}>{children}</span>;
}

const statusTone: Record<OfferStatus, ToneClass> = { published: 'neutral', derived: 'derived', 'in-plan': 'good', challenged: 'bad' };
const tierTone: Record<EvidenceTier, ToneClass> = { verified: 'good', corroborated: 'good', 'single-claim': 'warn', 'simulation-only': 'bad' };
const outcomeTone: Record<PolicyOutcome, ToneClass> = { Accepted: 'good', Rejected: 'bad', Countered: 'warn', 'Awaiting answer': 'neutral' };

const asOffer = (p: ICellRendererParams) => p.data as OfferRow;

const base: ColDef = { resizable: true, filter: true, sortable: true, minWidth: 90 };
export const defaultColDef: ColDef = base;
const wrap = { wrapText: true, autoHeight: true } as const;

export function offerColumns(grouped: boolean): ColDef<OfferGridRow>[] {
  return [
    {
      headerName: 'Supplier',
      colId: 'supplier',
      pinned: 'left',
      minWidth: 190,
      valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.actor + (p.data.offer.version > 1 ? ` (v${p.data.offer.version})` : '') : ''),
    },
    { headerName: 'Stage', colId: 'stage', hide: grouped, minWidth: 150, valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.stageName : '') },
    {
      headerName: 'Price by tier',
      colId: 'price',
      minWidth: 190,
      headerClass: 'ag-left-aligned-header',
      filter: 'agNumberColumnFilter',
        valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.firstUnitMinor / 100 : undefined),
      valueFormatter: (p) => (p.data?.kind === 'offer' ? p.data.tiersText : ''),
      cellStyle: { textAlign: 'left' },
    },
    {
      headerName: 'Setup fee',
      colId: 'setup',
      headerClass: 'ag-left-aligned-header',
      filter: 'agNumberColumnFilter',
      valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.offer.setupFee.minor / 100 : undefined),
      valueFormatter: (p) => (p.data?.kind === 'offer' ? (p.data.offer.setupFee.minor ? money(p.data.offer.setupFee) : 'None') : ''),
      cellStyle: { textAlign: 'left' },
    },
    {
      headerName: 'Capacity',
      colId: 'capacity',
      headerClass: 'ag-left-aligned-header',
      filter: 'agNumberColumnFilter',
      headerTooltip: 'The supplier claim, not proof.',
      valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.offer.capacity : undefined),
      valueFormatter: (p) => (p.data?.kind === 'offer' ? `${p.data.offer.capacity} ${p.data.unit}` : ''),
      cellStyle: { textAlign: 'left' },
      minWidth: 140,
    },
    {
      headerName: 'Evidence',
      colId: 'evidence',
      minWidth: 150,
      headerTooltip: 'How strongly the capacity claim is backed.',
      valueGetter: (p) => (p.data?.kind === 'offer' ? (p.data.capacityTier ? TIER_LABEL[p.data.capacityTier] : 'No claim') : ''),
      cellRenderer: (p: ICellRendererParams) => {
        const r = asOffer(p);
        if (!r?.capacityTier) return <span className="obs-muted">No claim</span>;
        return <Chip tone={tierTone[r.capacityTier]}>{TIER_LABEL[r.capacityTier]}</Chip>;
      },
    },
    { headerName: 'Window', colId: 'window', minWidth: 230, valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.windowText : '') },
    { headerName: 'Negotiable', colId: 'negotiable', minWidth: 150, valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.negotiableText : '') },
    {
      headerName: 'Constraint',
      colId: 'constraint',
      minWidth: 120,
      valueGetter: (p) => (p.data?.kind === 'offer' ? (p.data.blocking ? 'Blocking' : '') : ''),
      cellRenderer: (p: ICellRendererParams) => (p.value ? <Chip tone="bad">Blocking</Chip> : <span className="obs-sr">Not blocking</span>),
    },
    {
      headerName: 'Status',
      colId: 'status',
      minWidth: 260,
      valueGetter: (p) => (p.data?.kind === 'offer' ? p.data.statuses.map((s) => STATUS_LABEL[s]).join(', ') : ''),
      cellRenderer: (p: ICellRendererParams) => (
        <>
          {asOffer(p)?.statuses.map((s) => (
            <Chip key={s} tone={statusTone[s]}>
              {STATUS_LABEL[s]}
            </Chip>
          ))}
        </>
      ),
    },
  ];
}

export const coalitionColumns: ColDef<CoalitionRow>[] = [
  { headerName: 'Members', field: 'members', flex: 2, minWidth: 260, wrapText: false },
  { headerName: 'Creates', field: 'output', minWidth: 200 },
  {
    headerName: 'Input cost',
    colId: 'inputCost',
    headerTooltip: 'Sum of member offers at their tier price for the quantities used.',
    valueGetter: (p) => (p.data?.inputCost ? p.data.inputCost.minor / 100 : undefined),
    valueFormatter: (p) => money(p.data?.inputCost),
    filter: 'agNumberColumnFilter',
  },
  {
    headerName: 'Payout split',
    colId: 'payout',
    valueGetter: (p) => (p.data?.payout ? p.data.payout.minor / 100 : undefined),
    valueFormatter: (p) => money(p.data?.payout),
    filter: 'agNumberColumnFilter',
  },
  {
    headerName: 'Beats outside option',
    colId: 'rational',
    minWidth: 190,
    valueGetter: (p) => (p.data ? { yes: 'Yes', no: 'No', unchecked: 'Not checked' }[p.data.rational] : ''),
    cellRenderer: (p: ICellRendererParams) => <Chip tone={p.value === 'Yes' ? 'good' : p.value === 'No' ? 'bad' : 'neutral'}>{String(p.value)}</Chip>,
  },
  {
    headerName: 'State',
    field: 'state',
    cellRenderer: (p: ICellRendererParams) => <Chip tone={p.value === 'In plan' ? 'good' : 'neutral'}>{String(p.value)}</Chip>,
  },
];

export const questionColumns: ColDef<QuestionRow>[] = [
  { headerName: 'Asked of', field: 'to', minWidth: 170 },
  { headerName: 'Question', field: 'ask', flex: 2, minWidth: 320, ...wrap },
  {
    headerName: 'Value of information',
    colId: 'voi',
    minWidth: 190,
    headerTooltip: 'Higher is a better question to ask.',
    sort: 'desc',
    valueGetter: (p) => p.data?.voi,
    filter: 'agNumberColumnFilter',
    cellRenderer: (p: ICellRendererParams) => {
      const r = p.data as QuestionRow;
      if (r.voi === undefined) return <span className="obs-muted">Not computed</span>;
      return (
        <span className="obs-voi">
          <i style={{ width: `${Math.max(2, Math.round((r.voiShare ?? 0) * 70))}px` }} aria-hidden="true" />
          {r.voi.toFixed(2)}
        </span>
      );
    },
  },
  {
    headerName: 'Decision',
    colId: 'outcome',
    minWidth: 160,
    valueGetter: (p) => p.data?.outcome,
    cellRenderer: (p: ICellRendererParams) => <Chip tone={outcomeTone[p.value as PolicyOutcome]}>{String(p.value)}</Chip>,
  },
  { headerName: 'Decided by', field: 'basis', minWidth: 150, valueFormatter: (p) => p.value || '' },
  {
    headerName: 'Counter',
    field: 'counter',
    flex: 2,
    minWidth: 280,
    ...wrap,
    valueFormatter: (p) => p.value || 'None',
  },
];

export const claimColumns: ColDef<ClaimRow>[] = [
  { headerName: 'Supplier', field: 'actor', minWidth: 170 },
  {
    headerName: 'Claim',
    colId: 'claim',
    flex: 2,
    minWidth: 300,
    ...wrap,
    valueGetter: (p) => p.data?.claim.assertion,
    cellRenderer: (p: ICellRendererParams) => <span className="obs-claim-text">{String(p.value)}</span>,
  },
  { headerName: 'About', colId: 'subject', minWidth: 140, valueGetter: (p) => p.data?.claim.subject, cellClass: 'obs-mono' },
  {
    headerName: 'Value',
    colId: 'value',
    headerClass: 'ag-left-aligned-header',
    filter: 'agNumberColumnFilter',
    valueGetter: (p) => p.data?.claim.value,
    valueFormatter: (p) => (p.value === undefined ? '–' : String(p.value)),
  },
  {
    headerName: 'Evidence',
    colId: 'tier',
    minWidth: 150,
    valueGetter: (p) => (p.data ? TIER_LABEL[p.data.claim.tier] : ''),
    cellRenderer: (p: ICellRendererParams) => {
      const r = p.data as ClaimRow;
      return <Chip tone={tierTone[r.claim.tier]}>{TIER_LABEL[r.claim.tier]}</Chip>;
    },
  },
  {
    headerName: 'Verdict',
    colId: 'verdict',
    minWidth: 150,
    valueGetter: (p) => (p.data ? VERDICT_LABEL[p.data.verdict] : ''),
    cellRenderer: (p: ICellRendererParams) => {
      const v = (p.data as ClaimRow).verdict;
      return <Chip tone={v === 'contradicted' || v === 'expired' ? 'bad' : v === 'consistent' ? 'good' : 'neutral'}>{VERDICT_LABEL[v]}</Chip>;
    },
  },
  { headerName: 'Expires', colId: 'expires', valueGetter: (p) => p.data?.claim.expiresAt, valueFormatter: (p) => (p.value ? when(p.value) : 'No expiry') },
  { headerName: 'Source', colId: 'source', valueGetter: (p) => p.data?.claim.provenance.source },
  { headerName: 'Offers', colId: 'offers', headerClass: 'ag-left-aligned-header', valueGetter: (p) => p.data?.relied.length, maxWidth: 110 },
];

export const paymentColumns: ColDef<PaymentRow>[] = [
  { headerName: 'Payee', field: 'payee', minWidth: 180 },
  { headerName: 'Amount', colId: 'amount', valueGetter: (p) => (p.data ? p.data.payment.amount.minor / 100 : undefined), valueFormatter: (p) => money(p.data?.payment.amount), filter: 'agNumberColumnFilter' },
  { headerName: 'Charged', colId: 'charged', valueGetter: (p) => (p.data ? p.data.payment.charged.minor / 100 : undefined), valueFormatter: (p) => money(p.data?.payment.charged), filter: 'agNumberColumnFilter' },
  {
    headerName: 'Status (Sandbox)',
    colId: 'status',
    minWidth: 280,
    valueGetter: (p) => p.data?.payment.paypal.status ?? '',
    cellRenderer: (p: ICellRendererParams) => (
      <>
        {p.value ? <span className="obs-mono">{String(p.value)}</span> : <span className="obs-muted">No order yet</span>}
      </>
    ),
  },
  { headerName: 'Order', colId: 'order', minWidth: 170, valueGetter: (p) => p.data?.payment.paypal.orderId ?? '', cellClass: 'obs-mono' },
  { headerName: 'Capture', colId: 'capture', minWidth: 170, valueGetter: (p) => p.data?.payment.paypal.captureId ?? '', cellClass: 'obs-mono' },
  {
    headerName: 'Refunded',
    colId: 'refunded',
    valueGetter: (p) => p.data?.payment.paypal.refunds.reduce((n, r) => n + r.amount.minor, 0) ?? 0,
    valueFormatter: (p) => (p.value ? money({ currency: p.data!.payment.charged.currency, minor: p.value }) : 'None'),
  },
  {
    headerName: 'Fetched',
    colId: 'fetched',
    minWidth: 190,
    valueGetter: (p) => p.data?.payment.paypal.lastFetchedAt ?? '',
    valueFormatter: (p) => (p.value ? stamp(p.value) : 'Not fetched yet'),
  },
];
