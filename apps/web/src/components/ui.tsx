import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Source } from '@framvera/contracts';

export type TagKind = 'synthetic' | 'sandbox' | 'estimate' | 'solver' | 'policy' | 'buyer' | 'new' | 'catalog' | 'terminal';

const TAG_TEXT: Record<TagKind, string> = {
  synthetic: 'Synthetic market',
  sandbox: 'PayPal Sandbox',
  estimate: 'Planner estimate',
  solver: 'Solver',
  policy: 'Supplier policy',
  buyer: 'You',
  new: 'New',
  catalog: 'External catalog',
  terminal: 'Live seller',
};

export function sourceKind(s: Source): TagKind {
  switch (s) {
    case 'synthetic-market':
      return 'synthetic';
    case 'paypal-sandbox':
      return 'sandbox';
    case 'solver':
      return 'solver';
    case 'buyer':
      return 'buyer';
    case 'model-proposal':
      return 'estimate';
    case 'external-catalog':
      return 'catalog';
    case 'seller-terminal':
      return 'terminal';
  }
}

function Glyph({ kind }: { kind: TagKind }) {
  switch (kind) {
    case 'sandbox':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <rect width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      );
    case 'estimate':
      return (
        <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
          <path d="M1 3c1.3-1.2 2.7-1.2 4 0s2.7 1.2 4 0M1 6c1.3-1.2 2.7-1.2 4 0s2.7 1.2 4 0" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      );
    case 'solver':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M4 0 8 4 4 8 0 4z" fill="currentColor" />
        </svg>
      );
    case 'policy':
    case 'synthetic':
    case 'terminal':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <circle cx="4" cy="4" r="3.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
      );
    case 'new':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <circle cx="4" cy="4" r="4" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

export function SourceTag({ kind, children, title }: { kind: TagKind; children?: ReactNode; title?: string }) {
  return (
    <span className="tag" data-kind={kind} title={title}>
      <Glyph kind={kind} />
      {children ?? TAG_TEXT[kind]}
    </span>
  );
}

export function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="waiting" role="status" aria-live="polite">
      <span className="pulse" aria-hidden="true" />
      {children}
    </div>
  );
}

export function ErrorNote({ title, children, onRetry }: { title: string; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="notice" data-tone="error" role="alert">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ flex: 'none', marginTop: 1 }}>
        <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <path d="M9 5v5M9 12.4v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <div style={{ flex: 1 }}>
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
      {onRetry ? (
        <button className="btn btn-quiet btn-small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Drawer({ open, onClose, eyebrow, title, children, label }: { open: boolean; onClose: () => void; eyebrow?: ReactNode; title: ReactNode; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="drawer-in">
          <div className="drawer-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
              <h2>{title}</h2>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="drawer-body">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

export function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          },
          () => {},
        );
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6.5" fill="var(--ink)" />
      <path d="M7.5 17V7h9M7.5 12h6.5" stroke="var(--bg)" strokeWidth="2.1" fill="none" strokeLinecap="round" />
      <circle cx="17" cy="17" r="2.1" fill="var(--accent)" />
    </svg>
  );
}

export type Theme = 'light' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void] {
  const sys = () => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const read = (): Theme => {
    const a = document.documentElement.dataset.theme;
    return a === 'light' || a === 'dark' ? a : sys();
  };
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTheme(read());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return [
    theme,
    (t) => {
      document.documentElement.dataset.theme = t;
      try {
        localStorage.setItem('framvera.theme', t);
      } catch {
        /* storage unavailable */
      }
      setTheme(t);
    },
  ];
}

export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="icon-btn" onClick={() => onChange(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? (
        <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="3.6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M15 11.2A6.5 6.5 0 0 1 6.8 3a6.5 6.5 0 1 0 8.2 8.2z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
