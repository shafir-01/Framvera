import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { Concession, NegotiableField } from '@framvera/contracts';
import { day, hours, money, weekday } from '../lib/format.ts';
import { describe } from './describe.ts';
import { BAND_H, BAR_H, computeGeo, type Geo, type Placed } from './layout.ts';
import { buildModel, isLive, type Bar, type Model, type ScheduleProps } from './model.ts';
import './schedule.css';

const iso = (t: number) => new Date(t).toISOString();
const SNAP = 15 * 60_000;
const snap = (t: number) => Math.round(t / SNAP) * SNAP;

interface Draft {
  bar: Bar;
  field: Extract<NegotiableField, 'windowStart' | 'windowEnd'>;
  t: number;
}

const WIN = 'fv-sched';

export function Schedule(props: ScheduleProps) {
  const { onAdjust } = props;
  const model = useMemo(() => buildModel(props), [props.plan, props.agreement, props.recovery, props.world, props.originalWorld, props.deadline, props.disruption]);
  const uid = useId().replace(/:/g, '');
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(960);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [proposed, setProposed] = useState<Record<string, number>>({});

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setW(el.clientWidth || 960);
    const ro = new ResizeObserver(([e]) => e && setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetKey = `${props.plan.id}|${props.agreement?.version ?? 0}|${props.recovery?.id ?? ''}|${props.world?.version ?? 0}`;
  useEffect(() => {
    setProposed({});
    setDraft(null);
  }, [resetKey]);

  const geo = useMemo(() => computeGeo(model, w), [model, w]);
  const bars = useMemo(() => model.lanes.flatMap((l) => l.bars), [model]);
  const activeKey = hover ?? focus ?? sel;
  const active = bars.find((b) => b.key === activeKey);
  const info = active ? describe(active, model) : undefined;
  const unresolved = !props.recovery && bars.some((b) => b.status === 'at-risk' || b.status === 'withdrawn');

  const proposeEdge = (bar: Bar, field: Draft['field'], t: number) => {
    if (!onAdjust || !bar.window) return;
    const from = field === 'windowEnd' ? bar.window.to : bar.window.from;
    if (t === from) return;
    const c: Concession = {
      id: `adj_${bar.offer}_${field}_${Date.now()}`,
      target: { kind: 'offer', offer: bar.offer, field },
      from: iso(from),
      to: iso(t),
      estimate: { currency: model.currency, minor: 0 },
      rationale: 'Proposed from the schedule by moving a window edge. The new plan comes from a re-solve.',
    };
    setProposed((p) => ({ ...p, [`${bar.offer}:${field}`]: t }));
    onAdjust(c);
  };

  const bounds = (bar: Bar, field: Draft['field'], t: number) => {
    const win = bar.window!;
    return field === 'windowEnd' ? Math.max(snap(t), win.from + SNAP) : Math.min(snap(t), win.to - SNAP);
  };

  const hasConcession = bars.some((b) => b.window && b.originalWindow && (b.window.from !== b.originalWindow.from || b.window.to !== b.originalWindow.to));
  const delay = (b: Bar) => (b.status === 'withdrawn' ? 0 : b.status === 'at-risk' ? 520 : b.status === 'added' || b.status === 'amended' ? 1040 : 0);

  return (
    <section className={WIN} aria-label="Schedule">
      <Summary model={model} unresolved={unresolved} />
      <div className={`${WIN}__scroll`} ref={wrap}>
        <svg
          ref={svg}
          className={`${WIN}__svg`}
          width={geo.width}
          height={geo.height}
          viewBox={`0 0 ${geo.width} ${geo.height}`}
          role="group"
          aria-label="Timeline of the deal, one lane per stage"
        >
          <defs>
            <pattern id={`${uid}-risk`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height="7" fill="var(--fv-risk)" />
            </pattern>
            <pattern id={`${uid}-ext`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <rect width="6" height="6" fill="var(--fv-concede-soft)" />
              <rect width="2" height="6" fill="var(--fv-concede)" opacity=".55" />
            </pattern>
            <marker id={`${uid}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--fv-edge)" />
            </marker>
            <marker id={`${uid}-arrow-bad`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--fv-withdrawn)" />
            </marker>
          </defs>

          <Axis geo={geo} />

          {geo.lanes.map((lg, i) => (
            <g key={lg.lane.stage} className={`${WIN}__lane`}>
              <rect className="lane-bg" x={0} y={lg.top} width={geo.width} height={lg.height} rx={12} data-alt={i % 2} />
              {geo.mobile ? (
                <text className="lane-name" x={geo.plotLeft} y={lg.top + 19}>
                  {lg.lane.name}
                  <tspan className="lane-unit" dx="8">{lg.lane.unit}</tspan>
                </text>
              ) : (
                <text className="lane-name" x={16} y={lg.top + lg.height / 2 - 2}>
                  {lg.lane.name}
                  <tspan className="lane-unit" x={16} dy="17">{lg.lane.unit}</tspan>
                </text>
              )}
            </g>
          ))}

          {geo.lanes.flatMap((lg) => lg.units).flatMap((ug) => ug.unit.bars).map((b) => (
            <WindowBand key={`win-${b.key}`} bar={b} geo={geo} uid={uid} />
          ))}

          {model.edges.map((e, i) => {
            const a = geo.place.get(e.from.key);
            const z = geo.place.get(e.to.key);
            if (!a || !z) return null;
            return <Edge key={i} a={a} z={z} geo={geo} broken={e.broken} slack={e.slackHours} uid={uid} />;
          })}

          {geo.lanes.flatMap((lg) => lg.units).map((ug) =>
            ug.unit.coalition ? (
              <g key={`co-${ug.unit.coalition}`} className="coalition">
                <rect x={geo.x(ug.unit.from) - 7} y={ug.top + 6} width={geo.x(ug.unit.to) - geo.x(ug.unit.from) + 14} height={ug.height - 9} rx={10} />
                <text x={geo.x(ug.unit.from) - 2} y={ug.top + 3}>Shared run, {ug.unit.bars.length} suppliers</text>
              </g>
            ) : null,
          )}

          {geo.lanes.flatMap((lg) => lg.units).flatMap((ug) => ug.unit.bars).map((b) => {
            const p = geo.place.get(b.key)!;
            const desc = describe(b, model);
            return (
              <BarShape
                key={`${b.key}:${b.status}`}
                bar={b}
                p={p}
                geo={geo}
                uid={uid}
                label={desc.label}
                delay={delay(b)}
                dim={!!activeKey && activeKey !== b.key}
                selected={sel === b.key}
                onHover={(on) => setHover(on ? b.key : null)}
                onFocus={(on) => setFocus(on ? b.key : null)}
                onSelect={() => setSel((s) => (s === b.key ? null : b.key))}
              />
            );
          })}

          {model.deadline !== undefined && <Deadline model={model} geo={geo} />}

          {onAdjust &&
            bars
              .filter((b) => isLive(b) && b.window)
              .flatMap((b) =>
                (['windowStart', 'windowEnd'] as const)
                  .filter((f) => b.negotiable.includes(f))
                  .map((f) => (
                    <Handle
                      key={`${b.key}:${f}`}
                      bar={b}
                      field={f}
                      geo={geo}
                      svg={svg}
                      draft={draft?.bar.key === b.key && draft.field === f ? draft : null}
                      pending={proposed[`${b.offer}:${f}`]}
                      setDraft={setDraft}
                      clamp={(t) => bounds(b, f, t)}
                      commit={(t) => proposeEdge(b, f, t)}
                    />
                  )),
              )}
        </svg>
      </div>

      {geo.mobile && <p className="fv-sched__swipe">Swipe sideways to follow the deal through time.</p>}
      <Legend model={model} hasConcession={hasConcession} draggable={!!onAdjust} />

      <div className={`${WIN}__detail`} aria-live="polite">
        {info && active ? (
          <>
            <strong>{info.title}</strong>
            <span className={`chip st-${active.status}`}>{model.adapting || active.status !== 'planned' ? statusWord(active) : 'Planned'}</span>
            <ul>
              {info.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        ) : (
          null
        )}
      </div>
    </section>
  );
}

function statusWord(b: Bar): string {
  return { planned: 'Planned', kept: 'Kept', withdrawn: 'Withdrawn', superseded: 'Replaced', 'at-risk': 'At risk', added: 'New', amended: 'Moved' }[b.status];
}

function Summary({ model, unresolved }: { model: Model; unresolved: boolean }) {
  const iso2 = model.readyAt !== undefined ? iso(model.readyAt) : undefined;
  const margin = model.marginHours;
  return (
    <div className={`${WIN}__summary`} role="status">
      <div className="fig">
        <span className="k">Ready</span>
        <span className="v">{unresolved ? 'At risk' : (iso2 && weekday(iso2)) || '–'}</span>
        {!unresolved && margin !== undefined && <span className="s">{margin >= 0 ? `${hours(margin)} early` : `${hours(-margin)} late`}</span>}
      </div>
      <div className="fig">
        <span className="k">Total</span>
        <span className="v">{money(model.total)}</span>
      </div>
      {model.extraCost && (
        <div className="fig adapt">
          <span className="k">Extra cost</span>
          <span className="v">{money(model.extraCost, { sign: true })}</span>
          
        </div>
      )}
      {model.slipHours !== undefined && (
        <div className={`fig adapt${model.slipHours > 0 ? ' bad' : ''}`}>
          <span className="k">Delivery slip</span>
          <span className="v">{model.slipHours > 0 ? hours(model.slipHours) : 'None'}</span>
        </div>
      )}
    </div>
  );
}

function Axis({ geo }: { geo: Geo }) {
  return (
    <g className="axis" aria-hidden="true">
      {geo.ticks.map((t) => (
        <g key={t.t}>
          <line className={t.midnight ? 'grid day' : 'grid'} x1={t.x} x2={t.x} y1={t.midnight ? 4 : 26} y2={geo.height - 4} />
          <text className="tick" x={t.x + 4} y={38}>
            {String(t.hour).padStart(2, '0')}:00
          </text>
          {t.midnight && (
            <text className="dayname" x={t.x + 4} y={16}>
              {day(iso(t.t + 3_600_000))}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

function WindowBand({ bar: b, geo, uid }: { bar: Bar; geo: Geo; uid: string }) {
  const p = geo.place.get(b.key);
  if (!p || !b.window || !isLive(b)) return null;
  const y = p.mid - BAND_H / 2;
  const x1 = geo.x(b.window.from);
  const x2 = geo.x(b.window.to);
  const o = b.originalWindow;
  const ox1 = o ? geo.x(o.from) : x1;
  const ox2 = o ? geo.x(o.to) : x2;
  return (
    <g className="window" aria-hidden="true">
      <rect className="neg" x={x1} y={y} width={Math.max(0, x2 - x1)} height={BAND_H} rx={7} />
      {o && x2 > ox2 + 0.5 && <rect className="ext" x={ox2} y={y} width={x2 - ox2} height={BAND_H} rx={4} fill={`url(#${uid}-ext)`} />}
      {o && ox1 > x1 + 0.5 && <rect className="ext" x={x1} y={y} width={ox1 - x1} height={BAND_H} rx={4} fill={`url(#${uid}-ext)`} />}
      {o && (ox1 !== x1 || ox2 !== x2) && <rect className="orig" x={ox1} y={y} width={Math.max(0, ox2 - ox1)} height={BAND_H} rx={7} />}
      {o && x2 > ox2 + 28 && (
        <text className="plus" x={(ox2 + x2) / 2} y={y - 3} textAnchor="middle">
          +{hours((b.window.to - o.to) / 3_600_000)}
        </text>
      )}
    </g>
  );
}

function Edge({ a, z, geo, broken, slack, uid }: { a: Placed; z: Placed; geo: Geo; broken: boolean; slack: number; uid: string }) {
  const x1 = geo.x(a.bar.finish);
  const x2 = geo.x(z.bar.start);
  const dx = Math.max(24, Math.min(90, Math.abs(x2 - x1) / 2));
  const d = `M${x1} ${a.mid} C${x1 + dx} ${a.mid} ${x2 - dx} ${z.mid} ${x2 - 1} ${z.mid}`;
  return (
    <path className={`edge${broken ? ' broken' : ''}`} d={d} markerEnd={`url(#${uid}-arrow${broken ? '-bad' : ''})`}>
      <title>{`${a.bar.actorName} to ${z.bar.actorName}: ${slack >= 0 ? `${hours(slack)} between output ready and start` : 'starts before its input is ready'}`}</title>
    </path>
  );
}

function BarShape(props: {
  bar: Bar;
  p: Placed;
  geo: Geo;
  uid: string;
  label: string;
  delay: number;
  dim: boolean;
  selected: boolean;
  onHover: (on: boolean) => void;
  onFocus: (on: boolean) => void;
  onSelect: () => void;
}) {
  const { bar: b, p, geo, uid } = props;
  const x1 = geo.x(b.start);
  const x2 = Math.max(geo.x(b.workEnd), x1 + 3);
  const xf = geo.x(b.finish);
  const w = x2 - x1;
  const y = p.top;
  const cx = (e: RKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      props.onSelect();
    }
  };
  const frags = [0, 0.3, 0.57, 0.8, 1];
  const need = Math.max(b.actorName.length, `${b.qty} ${b.unit} · ${money(b.cost)}`.length) * 6.4 + 18;
  const inside = w >= need;
  const outRight = xf + 10 + need <= geo.plotRight + 8;
  const lx = inside ? x1 + 9 : outRight ? Math.max(xf, x2) + 10 : x1 - 10;
  const anchor = inside || outRight ? 'start' : 'end';
  const text1 = b.actorName;
  const text2 = `${b.qty} ${b.unit} · ${money(b.cost)}`;
  return (
    <g
      className={`bar st-${b.status}${props.dim ? ' dim' : ''}${props.selected ? ' selected' : ''}`}
      style={{ ['--d' as string]: `${props.delay}ms` }}
      tabIndex={0}
      role="button"
      aria-pressed={props.selected}
      aria-label={props.label}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
      onFocus={() => props.onFocus(true)}
      onBlur={() => props.onFocus(false)}
      onClick={props.onSelect}
      onKeyDown={cx}
    >
      <title>{props.label}</title>
      {b.handoffHours > 0 && xf > x2 + 1 && (
        <g className="handoff">
          <line x1={x2} x2={xf} y1={p.mid} y2={p.mid} />
          <circle cx={xf} cy={p.mid} r={3.2} />
        </g>
      )}
      {b.status === 'withdrawn' ? (
        <g className="shards">
          {frags.slice(0, -1).map((f, i) => {
            const fx = x1 + w * f;
            const fw = w * (frags[i + 1]! - f);
            return <rect key={i} className="shard" style={{ ['--i' as string]: i }} x={fx} y={y} width={Math.max(1, fw - 1.5)} height={BAR_H} rx={5} />;
          })}
        </g>
      ) : (
        <>
          <rect className="body" x={x1} y={y} width={Math.max(w, 3)} height={BAR_H} rx={7} />
          {b.status === 'at-risk' && <rect className="risk" x={x1} y={y} width={Math.max(w, 3)} height={BAR_H} rx={7} fill={`url(#${uid}-risk)`} />}
        </>
      )}
      <rect className="ring" x={x1 - 3} y={y - 3} width={Math.max(w, 3) + 6} height={BAR_H + 6} rx={9} />
      {b.status !== 'withdrawn' && b.status !== 'superseded' && (
        <g className={inside ? 'label' : 'label out'} textAnchor={anchor}>
          {text1 && (
            <text className="t1" x={lx} y={y + 14}>
              {text1}
            </text>
          )}
          {text2 && (
            <text className="t2" x={lx} y={y + 27}>
              {text2}
            </text>
          )}
        </g>
      )}
      {b.status === 'kept' && w > 40 && <path className="kept-mark" d={`M${x2 - 17} ${y + 9} l3.2 3.4 l6 -7`} />}
    </g>
  );
}

function Deadline({ model, geo }: { model: Model; geo: Geo }) {
  const x = geo.x(model.deadline!);
  const text = `Deadline ${weekday(iso(model.deadline!))}`;
  const right = x > geo.width - 150;
  return (
    <g className="deadline">
      <line x1={x} x2={x} y1={20} y2={geo.height - 24} />
      <rect x={right ? x - 128 : x} y={geo.height - 24} width={128} height={18} rx={9} />
      <text x={right ? x - 64 : x + 64} y={geo.height - 11} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

function Handle(props: {
  bar: Bar;
  field: Draft['field'];
  geo: Geo;
  svg: React.RefObject<SVGSVGElement | null>;
  draft: Draft | null;
  pending?: number;
  setDraft: (d: Draft | null) => void;
  clamp: (t: number) => number;
  commit: (t: number) => void;
}) {
  const { bar: b, field, geo, draft, pending } = props;
  const p = geo.place.get(b.key);
  if (!p || !b.window) return null;
  const edge = field === 'windowEnd' ? b.window.to : b.window.from;
  const shown = draft?.t ?? pending ?? edge;
  const x = geo.x(edge);
  const gx = geo.x(shown);
  const y = p.mid - BAND_H / 2;
  const name = `${field === 'windowEnd' ? 'Latest finish' : 'Earliest start'} for ${b.actorName}`;
  const moving = shown !== edge;
  const fromPointer = (e: RPointerEvent) => {
    const r = props.svg.current!.getBoundingClientRect();
    return props.clamp(geo.invX(e.clientX - r.left));
  };
  const key = (e: RKeyboardEvent) => {
    const step = e.shiftKey ? 3_600_000 : SNAP;
    const cur = draft?.t ?? edge;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      props.setDraft({ bar: b, field, t: props.clamp(cur + (e.key === 'ArrowRight' ? step : -step)) });
    } else if (e.key === 'Enter' && draft) {
      e.preventDefault();
      props.commit(draft.t);
      props.setDraft(null);
    } else if (e.key === 'Escape') {
      props.setDraft(null);
    }
  };
  return (
    <g className={`handle${moving ? ' moving' : ''}${pending !== undefined && !draft ? ' pending' : ''}`}>
      {moving && (
        <g aria-hidden="true">
          <rect className="ghost" x={Math.min(x, gx)} y={y} width={Math.abs(gx - x)} height={BAND_H} rx={4} />
          <line className="ghost-edge" x1={gx} x2={gx} y1={y - 4} y2={y + BAND_H + 4} />
          <g transform={`translate(${gx}, ${y + BAND_H + 6})`}>
            <rect x={-64} y={0} width={128} height={17} rx={8.5} className="bubble" />
            <text x={0} y={12} textAnchor="middle">
              {pending !== undefined && !draft ? 'Pending' : `Propose ${weekday(iso(shown))}`}
            </text>
          </g>
        </g>
      )}
      <rect
        className="grip"
        x={x - 7}
        y={y + 6}
        width={14}
        height={BAND_H - 12}
        rx={7}
        tabIndex={0}
        role="slider"
        aria-label={name}
        aria-valuemin={b.window.from}
        aria-valuemax={b.window.to + 86_400_000}
        aria-valuenow={shown}
        aria-valuetext={`${weekday(iso(shown))}. Arrow keys move, Enter proposes, Escape cancels.`}
        onKeyDown={key}
        onBlur={() => draft && props.setDraft(null)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          props.setDraft({ bar: b, field, t: edge });
        }}
        onPointerMove={(e) => {
          if (e.buttons) props.setDraft({ bar: b, field, t: fromPointer(e) });
        }}
        onPointerUp={(e) => {
          const t = fromPointer(e);
          e.currentTarget.releasePointerCapture(e.pointerId);
          props.setDraft(null);
          props.commit(t);
        }}
        onPointerCancel={() => props.setDraft(null)}
      >
        <title>{`${name}. Drag to propose a different time.`}</title>
      </rect>
      <line className="grip-line" x1={x} x2={x} y1={y + 12} y2={y + BAND_H - 12} />
    </g>
  );
}

function Legend({ model, hasConcession, draggable }: { model: Model; hasConcession: boolean; draggable: boolean }) {
  const items: { cls: string; text: string }[] = [];
  if (model.hasWindows) items.push({ cls: 'lg-win', text: 'Allowed window' });
  if (hasConcession) items.push({ cls: 'lg-ext', text: 'Stretched' });
  if (model.hasCoalition) items.push({ cls: 'lg-co', text: 'Shared run' });
  if (model.adapting) items.push({ cls: 'lg-bad', text: 'Withdrawn' }, { cls: 'lg-risk', text: 'At risk' }, { cls: 'lg-new', text: 'Changed' });
  return (
    <ul className={`${WIN}__legend`} aria-label="Legend">
      {items.map((i) => (
        <li key={i.text}>
          <i className={i.cls} aria-hidden="true" />
          {i.text}
        </li>
      ))}
    </ul>
  );
}
