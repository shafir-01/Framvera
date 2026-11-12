import { themeQuartz } from 'ag-grid-community';

/** Grid theme bound to the observatory's CSS tokens, so light and dark follow the page. */
export const observatoryTheme = themeQuartz.withParams({
  fontFamily: "var(--obs-font)",
  fontSize: 13,
  spacing: 6,
  accentColor: 'var(--obs-accent)',
  backgroundColor: 'var(--obs-surface)',
  foregroundColor: 'var(--obs-ink)',
  textColor: 'var(--obs-ink)',
  borderColor: 'var(--obs-line)',
  headerBackgroundColor: 'var(--obs-surface-2)',
  headerTextColor: 'var(--obs-ink-soft)',
  headerFontWeight: 600,
  oddRowBackgroundColor: 'var(--obs-surface)',
  rowHoverColor: 'var(--obs-hover)',
  selectedRowBackgroundColor: 'var(--obs-selected)',
  wrapperBorderRadius: 10,
  headerHeight: 38,
  rowHeight: 40,
  cellHorizontalPaddingScale: 0.9,
  focusShadow: '0 0 0 2px var(--obs-accent)',
  columnBorder: false,
});
