import { useId, type KeyboardEvent } from 'react';
import type { Currency } from '@framvera/contracts';
import { SourceTag } from '../components/ui.tsx';
import type { Frontier } from './engine.ts';
import { describeDelta, describeValue, shortLabel, type Lever } from './levers.ts';

interface Props {
  lever: Lever;
  delta: number;
  currency: Currency;
  frontier?: Frontier;
  onChange: (delta: number) => void;
  /** The card above already names the supplier. */
  compact?: boolean;
}

/** Positions along the slider where the order is known to be impossible or possible, exact under monotonicity. */
function bands(f: Frontier | undefined, max: number) {
  if (!f || !f.points.length) return { bad: 0, good: max };
  if (f.none) return { bad: max, good: max };
  if (f.threshold !== undefined) return { bad: f.threshold, good: f.threshold };
  const bad = Math.max(0, ...f.points.filter((p) => p.feasibility === 'infeasible').map((p) => p.delta));
  const good = Math.min(max, ...f.points.filter((p) => p.feasibility === 'feasible').map((p) => p.delta));
  return { bad, good };
}

export function LeverControl({ lever: l, delta, currency, frontier, onChange, compact }: Props) {
  const id = useId();
  const max = Math.max(l.max, delta);
  const pct = (v: number) => `${(Math.min(max, Math.max(0, v)) / max) * 100}%`;
  const { bad, good } = bands(frontier, max);
  const known = !!frontier && frontier.points.length > 0;
  const threshold = frontier?.done ? frontier.threshold : undefined;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? l.grain : l.kb;
    onChange(Math.min(max, Math.max(0, Math.round((delta + dir * step) / l.grain) * l.grain)));
  };

  if (l.unit === 'toggle') {
    const on = delta > 0;
    return (
      <div className="sg-lever" data-moved={on || undefined}>
        <div className="sg-lever-head">
          <span className="sg-lever-name" id={`${id}-name`}>
            <span className="sg-who">{l.who}</span>
            <span className="sg-what">{l.what}</span>
          </span>
          <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-name`} className="sg-switch" onClick={() => onChange(on ? 0 : 1)}>
            <span className="sg-switch-knob" aria-hidden="true" />
            <span className="sg-switch-text">{describeValue(l, delta, currency)}</span>
          </button>
        </div>
        <div className="sg-lever-foot">
          {frontier?.done && frontier.threshold === 1 && <span>Works when on</span>}
          {frontier?.done && frontier.threshold === 0 && <span>Not needed</span>}
          {frontier?.done && frontier.none && <span>Not enough on its own</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="sg-lever" data-own={l.own || undefined} data-moved={delta > 0 || undefined}>
      <div className="sg-lever-head">
        <label htmlFor={id} className="sg-lever-name">
          {compact ? (
            <span className="sg-who">{shortLabel(l)}</span>
          ) : (
            <>
              <span className="sg-who">{l.who}</span>
              <span className="sg-what">{l.what}</span>
            </>
          )}
        </label>
        {l.own && <SourceTag kind="buyer">Your own concession</SourceTag>}
        <output htmlFor={id} className="sg-lever-value num">
          {describeValue(l, delta, currency)}
          <span className="sg-lever-delta">{describeDelta(l, delta, currency)}</span>
        </output>
      </div>
      <div className="sg-track" style={{ ['--bad' as string]: pct(bad), ['--good' as string]: pct(good) }} data-known={known || undefined}>
        <div className="sg-band" aria-hidden="true">
          <span className="sg-band-bad" />
          <span className="sg-band-good" />
        </div>
        {threshold !== undefined && threshold > 0 && <span className="sg-tick" style={{ ['--at' as string]: Math.min(1, threshold / max) }} aria-hidden="true" />}
        <input
          id={id}
          type="range"
          min={0}
          max={max}
          step={l.grain}
          value={delta}
          onChange={(e) => onChange(Number(e.target.value))}
          onKeyDown={onKey}
          aria-valuetext={`${describeValue(l, delta, currency)}, ${describeDelta(l, delta, currency)}`}
        />
      </div>
      <div className="sg-lever-foot">
        {threshold !== undefined && threshold > 0 && threshold !== delta && (
          <button type="button" className="sg-link" onClick={() => onChange(threshold)}>
            Works from {describeDelta(l, threshold, currency)}
          </button>
        )}
        {threshold === 0 && <span>Not needed</span>}
        {frontier?.done && frontier.none && <span>Not enough on its own</span>}
        {delta > 0 && (
          <button type="button" className="sg-link" onClick={() => onChange(0)}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
