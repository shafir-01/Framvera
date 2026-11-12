import { useEffect, useRef } from 'react';
import { Chip } from './columns.tsx';
import type { Detail, DetailItem } from './model.ts';
import type { TabId } from './types.ts';

interface Props {
  detail: Detail;
  onClose: () => void;
  onGo: (tab: TabId, id: string) => void;
  action?: { label: string; busy: boolean; run: () => void };
}

function Item({ item, onGo }: { item: DetailItem; onGo: Props['onGo'] }) {
  return (
    <li>
      <div className="row">
        <span>{item.text}</span>
        {item.badge ? <Chip tone={item.badge === 'Sandbox' ? 'sandbox' : item.tone}>{item.badge}</Chip> : null}
      </div>
      {item.note ? <span className="note">{item.note}</span> : null}
      {item.link ? (
        <button type="button" className="obs-link" onClick={() => onGo(item.link!.tab, item.link!.id)}>
          {item.link.label}
        </button>
      ) : null}
    </li>
  );
}

export function DetailPanel({ detail, onClose, onGo, action }: Props) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = 0;
  }, [detail.title]);

  return (
    <aside
      ref={ref}
      className="obs-detail"
      aria-label={`Provenance: ${detail.title}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header>
        <div>
          <h3>{detail.title}</h3>
          <p className="sub">{detail.subtitle}</p>
        </div>
        <button type="button" className="obs-btn" onClick={onClose} aria-label="Close provenance">
          Close
        </button>
      </header>
      {action ? (
        <p>
          <button type="button" className="obs-btn" disabled={action.busy} onClick={action.run}>
            {action.busy ? 'Fetching from PayPal' : action.label}
          </button>
        </p>
      ) : null}
      {detail.sections.filter((s) => s.items.length || s.keep).map((s) => (
        <section key={s.heading}>
          <h4>{s.heading}</h4>
          {s.items.length ? (
            <ul>
              {s.items.map((it, i) => (
                <Item key={i} item={it} onGo={onGo} />
              ))}
            </ul>
          ) : (
            <p className="none">{s.empty}</p>
          )}
        </section>
      ))}
    </aside>
  );
}
