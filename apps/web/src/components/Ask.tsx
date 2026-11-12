import { useEffect, useRef, useState } from 'react';
import type { IntentDraft } from '../api.ts';
import { useStore } from '../store.tsx';
import { isoToStockholm, money, stockholmToIso, when } from '../lib/format.ts';
import { Drawer, ErrorNote, SourceTag } from './ui.tsx';
import { ScenarioGallery } from '../mounts.tsx';
import { Outcome } from './Outcome.tsx';

function nextFriday(): string {
  const d = new Date();
  const day = d.getUTCDay();
  let add = (5 - day + 7) % 7;
  if (add < 5) add += 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

export function defaultDraft(): IntentDraft {
  return {
    text: '500 promotional kits by Friday under 55 000 kr',
    budget: { currency: 'SEK', minor: 5_500_000 },
    deadline: stockholmToIso(nextFriday(), '12:00'),
  };
}

const STEP_TEXT: Record<string, string> = {
  market: 'Opening the market',
  compile: 'Reading your request',
  analyze: 'Testing every combination of offers',
};

export function Ask() {
  const { s, act } = useStore();
  const started = !!s.market || s.busy === 'market';
  const [gallery, setGallery] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const local = isoToStockholm(s.draft.deadline);
  const kr = Math.round(s.draft.budget.minor / 100);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [s.draft.text, started]);

  const set = (patch: Partial<IntentDraft>) => act.setDraft({ ...s.draft, ...patch });
  const canGo = s.server === 'ready' && s.draft.text.trim().length > 2 && kr > 0 && !s.busy;
  const busyEarly = s.busy === 'market' || s.busy === 'compile' || s.busy === 'analyze';

  if (started) {
    const intent = s.intent;
    return (
      <section className="ask" data-compact="true" aria-labelledby="objective">
        {s.scenario ? <div className="eyebrow">{s.scenario}</div> : null}
        <h1 className="display" id="objective">
          {intent?.text ?? s.draft.text}
        </h1>
        <div className="ask-foot" style={{ marginTop: 0, marginBottom: 18 }}>
          {!intent ? (
            <span>
              by <strong className="num">{when(s.draft.deadline)}</strong> · within <strong className="num">{money(s.draft.budget)}</strong>
            </span>
          ) : null}
          <button className="btn btn-quiet btn-small" onClick={act.reset}>
            Start over
          </button>
        </div>
        <Outcome />
        {busyEarly ? (
          <div className="waiting" role="status" aria-live="polite">
            <span className="pulse" aria-hidden="true" />
            {STEP_TEXT[s.busy!]}
          </div>
        ) : null}
        {s.error && ['market', 'compile', 'analyze'].includes(s.error.step) ? (
          <div style={{ marginTop: 18 }}>
            <ErrorNote title="The market could not be tested." onRetry={act.start}>
              {s.error.message}
            </ErrorNote>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="ask" aria-labelledby="ask-title">
      <div className="ask-inner">
        {s.scenario ? <div className="eyebrow">Market · {s.scenario}</div> : null}
        <h1 className="display" id="ask-title">
          What do you need to make <em>possible</em>?
        </h1>
        <form
          className="field-want"
          onSubmit={(e) => {
            e.preventDefault();
            if (canGo) void act.start();
          }}
        >
          <label htmlFor="want" className="sr-only">
            What you need
          </label>
          <textarea
            id="want"
            ref={area}
            className="want"
            rows={1}
            value={s.draft.text}
            onChange={(e) => set({ text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canGo) void act.start();
              }
            }}
            maxLength={600}
            spellCheck
          />
          <div className="want-row">
            <div className="chip-field">
              <label htmlFor="budget">Budget</label>
              <div className="control">
                <input
                  id="budget"
                  inputMode="numeric"
                  value={kr.toLocaleString('sv-SE')}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/[^\d]/g, ''));
                    if (Number.isFinite(n)) set({ budget: { ...s.draft.budget, minor: n * 100 } });
                  }}
                  style={{ width: `${Math.max(5, String(kr).length + 2)}ch` }}
                  aria-describedby="budget-unit"
                />
                <span className="unit" id="budget-unit">
                  kr
                </span>
              </div>
            </div>
            <div className="chip-field">
              <label htmlFor="deadline-date">Deadline</label>
              <div className="control">
                <input id="deadline-date" type="date" value={local.date} onChange={(e) => e.target.value && set({ deadline: stockholmToIso(e.target.value, local.time) })} aria-label="Deadline date" />
                <input id="deadline-time" type="time" value={local.time} onChange={(e) => e.target.value && set({ deadline: stockholmToIso(local.date, e.target.value) })} aria-label="Deadline time, Stockholm" />
              </div>
            </div>
            <div className="want-go">
              <button className="btn btn-primary" type="submit" disabled={!canGo} aria-describedby="server-state">
                Make it possible
                <svg className="arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </form>
        <div className="ask-foot" id="server-state" aria-live="polite">
          {s.server === 'waking' ? (
            <span className="waiting" style={{ padding: 0 }}>
              <span className="pulse" aria-hidden="true" />
              Waking the server, up to a minute.
            </span>
          ) : s.server === 'down' ? null : (
            <>
              <span>Suppliers:</span>
              <SourceTag kind="synthetic" />
              <span>Payments:</span>
              <SourceTag kind="sandbox" />
            </>
          )}
          {ScenarioGallery.available ? (
            <button className="top-link" style={{ marginLeft: 'auto' }} onClick={() => setGallery(true)}>
              Try another market
            </button>
          ) : null}
        </div>
        {s.server === 'down' ? (
          <div style={{ marginTop: 16 }}>
            <ErrorNote title="The market service is unreachable right now." onRetry={act.retryStatus}>
              Nothing was sent. {s.statusError}
            </ErrorNote>
          </div>
        ) : null}
      </div>
      {ScenarioGallery.available ? (
        <Drawer open={gallery} onClose={() => setGallery(false)} label="Choose a market" title="Try another market">
          <ScenarioGallery
            runSolve={false}
            onPick={(started) => {
              setGallery(false);
              void act.startWith(started);
            }}
          />
        </Drawer>
      ) : null}
    </section>
  );
}
