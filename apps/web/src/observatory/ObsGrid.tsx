import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, type CellKeyDownEvent, type ColDef, type GetRowIdParams, type GridApi, type GridReadyEvent, type ICellRendererParams, type IRowNode, type RowClassParams } from 'ag-grid-community';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { defaultColDef } from './columns.tsx';
import type { GroupRow } from './model.ts';
import { observatoryTheme } from './theme.ts';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface GridContext {
  toggleGroup?: (stage: string) => void;
}

export function GroupCell(p: ICellRendererParams<GroupRow, unknown, GridContext>) {
  const g = p.data;
  if (!g) return null;
  const short = g.needed !== undefined && g.capacity < g.needed;
  const label = `${g.stage.name}, ${g.count} ${g.count === 1 ? 'offer' : 'offers'}`;
  return (
    <div className="obs-group">
      <button type="button" aria-expanded={g.expanded} aria-label={`${label}. ${g.expanded ? 'Collapse' : 'Expand'}`} onClick={() => p.context.toggleGroup?.(g.stage.id)}>
        <span className="obs-caret" data-open={g.expanded} aria-hidden="true">
          ▸
        </span>
        {g.stage.name}
      </button>
      <span className="meta">
        {g.count} {g.count === 1 ? 'offer' : 'offers'}
        {' · '}
        {g.capacity} {g.stage.unit}
        {g.needed !== undefined ? ` of ${g.needed}${short ? ', short' : ''}` : ''}
        {g.blocking ? ` · ${g.blocking} blocking` : ''}
        {g.derived ? ` · ${g.derived} derived` : ''}
      </span>
    </div>
  );
}

export interface ObsGridProps<T extends { rowId: string }> {
  rows: T[];
  columns: ColDef<T>[];
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  quickFilter?: string;
  getRowClass?: (row: T) => string | undefined;
  grouped?: boolean;
  context?: GridContext;
  apiRef?: React.MutableRefObject<GridApi | null>;
  isSelectable?: (row: T) => boolean;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ObsGrid<T extends { rowId: string }>({ rows, columns, selectedId, onSelect, quickFilter, getRowClass, grouped, context, apiRef, isSelectable }: ObsGridProps<T>) {
  const api = useRef<GridApi | null>(null);
  const syncing = useRef(false);

  const colDef = useMemo<ColDef>(() => ({ ...defaultColDef, sortable: !grouped }), [grouped]);
  const getRowId = useCallback((p: GetRowIdParams<T>) => p.data.rowId, []);

  const applySelection = useCallback(
    (id: string | undefined) => {
      const a = api.current;
      if (!a || a.isDestroyed()) return;
      syncing.current = true;
      const node = id ? a.getRowNode(id) : undefined;
      a.deselectAll();
      if (node) {
        node.setSelected(true);
        a.ensureNodeVisible(node, 'middle');
      }
      syncing.current = false;
    },
    [],
  );

  useEffect(() => applySelection(selectedId), [selectedId, rows, applySelection]);

  const onReady = (e: GridReadyEvent) => {
    api.current = e.api;
    if (apiRef) apiRef.current = e.api;
    applySelection(selectedId);
  };

  const onKey = (e: CellKeyDownEvent) => {
    const ke = e.event as KeyboardEvent | null;
    if (!ke || ke.key !== 'Enter' || !e.node || !e.data) return;
    if ((e.data as { kind?: string }).kind === 'group') {
      context?.toggleGroup?.((e.data as GroupRow).stage.id);
      return;
    }
    onSelect(e.node.id);
  };

  return (
    <AgGridReact<T>
      theme={observatoryTheme}
      rowData={rows}
      columnDefs={columns}
      defaultColDef={colDef}
      getRowId={getRowId}
      context={context}
      quickFilterText={quickFilter}
      animateRows={!reduced()}
      tooltipShowDelay={400}
      suppressDragLeaveHidesColumns
      rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true, isRowSelectable: (n: IRowNode<T>) => (n.data ? (isSelectable ? isSelectable(n.data) : true) : false) }}
      isFullWidthRow={grouped ? (p) => (p.rowNode.data as { kind?: string } | undefined)?.kind === 'group' : undefined}
      fullWidthCellRenderer={grouped ? GroupCell : undefined}
      getRowClass={getRowClass ? (p: RowClassParams<T>) => (p.data ? getRowClass(p.data) : undefined) : undefined}
      onGridReady={onReady}
      onCellKeyDown={onKey}
      onSelectionChanged={(e) => {
        if (syncing.current) return;
        const sel = e.api.getSelectedNodes()[0];
        onSelect(sel?.id);
      }}
    />
  );
}
