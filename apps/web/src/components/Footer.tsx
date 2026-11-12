import { SourceTag } from './ui.tsx';

export function Footer() {
  return (
    <footer className="foot">
      <div className="legend" aria-label="Labels used on this page">
        <SourceTag kind="synthetic" />
        <SourceTag kind="sandbox" />
        <SourceTag kind="estimate" />
        <SourceTag kind="solver" />
      </div>
      <span style={{ flex: 1 }} />
    </footer>
  );
}
