import { useEffect, useMemo, useRef, useState } from 'react';
import type { Coalition, Id, Intent, Money, StageId, World } from '@framvera/contracts';
import { SourceTag, Waiting } from '../components/ui.tsx';
import { count, money, singular, weekday } from '../lib/format.ts';
import { analyze, memberViews, MAX_SHAPLEY_EXACT, type Analysis, type ForgeEngine } from './analyze.ts';
import { defaultEngine } from './engine.ts';
import { candidatesFor, draft, unitPrice, type Candidate } from './model.ts';
import './forge.css';

export interface ForgeProps {
  world: World;
  intent: Intent;
  /** Called with the candidate bundle and its proposed split. A proposal only: nothing here is an agreement. */
  onPropose?: (coalition: Coalition) => void;
  /** Public estimates of what each supplier could earn elsewhere. */
  outside?: Record<Id, Money>;
  /** Overrides the in-browser solver and split. */
  engine?: ForgeEngine;
  stage?: StageId;
  initialMembers?: Id[];
}

type Phase = { kind: 'idle' } | { kind: 'working' } | { kind: 'ready'; analysis: Analysis } | { kind: 'error'; message: string };

const MAX = MAX_SHAPLEY_EXACT;

function Tick({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="fg-tick" data-ok="true">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="var(--accent-soft)" stroke="var(--accent-mid)" />
        <path d="M4.8 8.3l2.1 2.1 4.3-4.6" stroke="var(--accent)" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only">Meets its estimated alternative</span>
    </span>
  ) : (
    <span className="fg-tick" data-ok="false">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="var(--hatch)" strokeDasharray="2 2" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--ink-3)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="sr-only">Below its estimated alternative</span>
    </span>
  );
}

export function Forge({ world, intent, onPropose, outside, engine: given, stage: stageProp, initialMembers }: ForgeProps) {
  const stages = useMemo(() => world.stages.filter((s) => candidatesFor(world, s.id).length > 0), [world]);
  const [stageId, setStageId] = useState<StageId>(stageProp ?? stages.find((s) => candidatesFor(world, s.id).length > 1)?.id ?? stages[0]?.id ?? '');
  const [members, setMembers] = useState<Id[]>(initialMembers ?? []);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [sent, setSent] = useState<Coalition | null>(null);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const token = useRef(0);
  const open = useRef<{ key: string; p: Promise<import('@framvera/contracts').SolveReport> } | null>(null);

  useEffect(() => {
    if (stageProp) setStageId(stageProp);
  }, [stageProp]);

  const stage = world.stages.find((s) => s.id === stageId);
  const cands = useMemo(() => candidatesFor(world, stageId), [world, stageId]);
  const byActor = useMemo(() => new Map(cands.map((c) => [c.actor.id, c])), [cands]);
  const name = (id: Id) => world.actors.find((a) => a.id === id)?.name ?? id;
  const fmt = (m: Money) => money(m);
  const demand = stage ? Math.ceil(intent.quantity * stage.perOutcome - 1e-9) : 0;
  const unit = stage?.unit ?? 'units';
  const bundle = useMemo(() => (stage ? draft(world, intent, stage.id, members) : undefined), [world, intent, stage, members]);

  useEffect(() => {
    setSent(null);
    const my = ++token.current;
    if (!bundle || members.length === 0 || !bundle.covers) {
      setPhase({ kind: 'idle' });
      return;
    }
    setPhase({ kind: 'working' });
    const timer = setTimeout(async () => {
      try {
        const eng = given ?? (await defaultEngine());
        const key = `${world.id}:${world.version}:${intent.id}:${intent.quantity}:${intent.budget.minor}:${intent.deadline}`;
        if (open.current?.key !== key) open.current = { key, p: eng.solve(world, intent) };
        const a = await analyze(eng, world, intent, stageId, members, { ...(outside ? { outside } : {}), open: open.current.p.catch(() => undefined as never) });
        if (my !== token.current) return;
        setPhase(a ? { kind: 'ready', analysis: a } : { kind: 'idle' });
      } catch (e) {
        if (my === token.current) setPhase({ kind: 'error', message: e instanceof Error ? e.message : 'The check could not run.' });
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [bundle, members, world, intent, stageId, given, outside]);

  const toggle = (id: Id) => {
    setMembers((cur) => {
      if (cur.includes(id)) {
        setNote(`${name(id)} removed`);
        return cur.filter((x) => x !== id);
      }
      if (cur.length >= MAX) {
        setNote(`A bundle holds up to ${MAX} suppliers`);
        return cur;
      }
      setNote(`${name(id)} added`);
      return [...cur, id];
    });
  };

  const pickStage = (id: StageId) => {
    setStageId(id);
    setMembers([]);
    setNote('');
  };

  const analysis = phase.kind === 'ready' ? phase.analysis : undefined;
  const plan = analysis?.report?.plan;
  const views = analysis ? memberViews(analysis, fmt, name) : [];
  const split = analysis?.split;
  const blocked = bundle?.conflicts.some((c) => c.kind === 'below-minimum') ?? false;
  const canSend = !!plan && !!split && !blocked && analysis?.verification?.ok !== false;
  const withinBudget = plan ? plan.total.minor <= intent.budget.minor : false;
  const openTotal = analysis?.open?.plan?.total;
  const delta = plan && openTotal ? plan.total.minor - openTotal.minor : undefined;

  const send = () => {
    if (!split) return;
    const { analysis: _a, ...proposal } = split;
    setSent(proposal);
    onPropose?.(proposal);
  };

  const onShelfKey = (e: React.KeyboardEvent, i: number) => {
    const list = (e.currentTarget.closest('ul') as HTMLElement).querySelectorAll<HTMLButtonElement>('button.fg-card');
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      list[Math.min(list.length - 1, i + 1)]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      list[Math.max(0, i - 1)]?.focus();
    }
  };

  const sharing = (c: Candidate) =>
    c.pool ? cands.filter((o) => o.pool === c.pool && o.actor.id !== c.actor.id).map((o) => o.actor.name) : [];

  if (!stage) return <section className="fg" aria-label="Coalition forge"><p className="fg-muted">No stage has suppliers to combine.</p></section>;

  return (
    <section className="fg" aria-label="Coalition forge">
      <header className="fg-head">
        <div>
          <h2 className="fg-title">{stage.name}</h2>
        </div>
        {stages.length > 1 ? (
          <div className="fg-stages" role="radiogroup" aria-label="Stage">
            {stages.map((s) => (
              <button key={s.id} role="radio" aria-checked={s.id === stageId} className="fg-stage" data-on={s.id === stageId} onClick={() => pickStage(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="fg-grid">
        <div
          className="fg-shelf"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('text/plain');
            if (members.includes(id)) toggle(id);
          }}
        >
          <h3 className="sr-only" id="fg-shelf-h">Suppliers for this stage</h3>
          <ul className="fg-list" aria-labelledby="fg-shelf-h">
            {cands.map((c, i) => {
              const on = members.includes(c.actor.id);
              const shared = sharing(c);
              return (
                <li key={c.actor.id}>
                  <button
                    className="fg-card"
                    aria-pressed={on}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', c.actor.id)}
                    onClick={() => toggle(c.actor.id)}
                    onKeyDown={(e) => onShelfKey(e, i)}
                  >
                    <span className="fg-card-main">
                      <span className="fg-card-name">{c.actor.name}</span>
                      <span className="fg-card-meta">
                        {c.actor.city} · up to {c.offer.capacity} {unit} · {money({ currency: world.currency, minor: unitPrice(c.offer, demand) })} per {singular(unit)}
                      </span>
                      {shared.length ? <span className="fg-card-share">Shares capacity with {shared.join(', ')}</span> : null}
                    </span>
                    <span className="fg-check" aria-hidden="true">
                      {on ? (
                        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7.3l2.7 2.7L11 4.2" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="fg-bench">
          <div
            className="fg-drop"
            data-over={over}
            data-empty={members.length === 0}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const id = e.dataTransfer.getData('text/plain');
              if (byActor.has(id) && !members.includes(id)) toggle(id);
            }}
          >
            {members.length === 0 ? (
              <p className="fg-muted">Pick suppliers, or drag them here.</p>
            ) : (
              <ul className="fg-chips" aria-label="Candidate coalition">
                {members.map((m) => {
                  const lane = bundle?.lanes.find((l) => l.actor === m);
                  return (
                    <li key={m} className="fg-chip">
                      <span>{name(m)}</span>
                      {lane ? <span className="fg-chip-qty">{lane.allotted} {unit}</span> : null}
                      <button className="fg-x" onClick={() => toggle(m)} aria-label={`Remove ${name(m)}`}>
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {bundle && members.length > 0 ? (
            <div className="fg-block">
              <div className="fg-row">
                <h3 className="fg-h3">Coverage</h3>
                <span className="fg-fig" data-ok={bundle.covers}>{Math.min(bundle.covered, 99999)} of {demand} {unit}</span>
              </div>
              <div
                className="fg-meter"
                role="img"
                aria-label={`${bundle.covered} of ${demand} ${unit} covered. ${bundle.covers ? 'Stage is covered.' : `${demand - bundle.covered} ${unit} short.`}`}
              >
                {bundle.lanes.map((l, i) => (
                  <span key={l.offer} className="fg-seg" data-i={i % 4} style={{ width: `${Math.min(100, (l.allotted / Math.max(demand, bundle.covered)) * 100)}%` }} title={`${name(l.actor)}: ${l.allotted}`} />
                ))}
              </div>
              <p className="fg-line" hidden={bundle.covers}>
                {bundle.covers ? '' : `${demand - bundle.covered} ${unit} short.`}
              </p>
              {bundle.conflicts.map((c) => (
                <div key={c.text} className="fg-conflict" role="note">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5l6 10.5H1z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" /><path d="M7 5.6v3M7 10v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {phase.kind === 'working' ? <Waiting>Checking the whole plan</Waiting> : null}
          {phase.kind === 'error' ? <div className="fg-conflict" role="alert"><span>{phase.message}</span></div> : null}

          {analysis && analysis.report ? (
            <div className="fg-block">
              <div className="fg-row">
                <h3 className="fg-h3">Whole plan</h3>
                <SourceTag kind="solver" />
              </div>
              {plan ? (
                <>
                  <p className="fg-big">
                    {fmt(plan.total)}
                    <span className="fg-fig" data-ok={withinBudget}> {withinBudget ? `within ${fmt(intent.budget)} budget` : `over ${fmt(intent.budget)} budget`}</span>
                  </p>
                  <p className="fg-line">
                    Ready {weekday(plan.readyAt)} · due {weekday(intent.deadline)}.
                    {delta !== undefined && delta !== 0 ? ` ${fmt({ currency: plan.total.currency, minor: Math.abs(delta) })} ${delta > 0 ? 'more' : 'less'} than using every supplier.` : ''}
                    {analysis.verification && !analysis.verification.ok ? ' Independent re-check found a problem.' : ''}
                  </p>
                </>
              ) : (
                <p className="fg-line">{analysis.report.core?.summary ?? 'No plan fits with this coalition.'}</p>
              )}
            </div>
          ) : null}

          {split && views.length ? (
            <div className="fg-block">
              <div className="fg-row">
                <h3 className="fg-h3">Payment split</h3>
                <span className="fg-hint">{split.analysis.method === 'shapley-exact' ? '' : 'Sampled'}</span>
              </div>
              <table className="fg-table">
                <thead>
                  <tr>
                    <th scope="col">Supplier</th>
                    <th scope="col" className="r">Share</th>
                    <th scope="col" className="r">
                      Alternative <SourceTag kind="estimate">Estimate</SourceTag>
                    </th>
                    <th scope="col"><span className="sr-only">Meets alternative</span></th>
                  </tr>
                </thead>
                <tbody>
                  {views
                    .filter((v) => v.verdict !== 'idle')
                    .map((v) => (
                      <tr key={v.actor}>
                        <th scope="row">
                          {name(v.actor)}
                          <span className="fg-why">{v.line}</span>
                        </th>
                        <td className="r fg-num">{fmt(v.share!)}</td>
                        <td className="r fg-num">{fmt(v.outside!)}</td>
                        <td className="c"><Tick ok={v.verdict === 'agrees'} /></td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {views.filter((v) => v.verdict === 'idle').map((v) => (
                <p key={v.actor} className="fg-line fg-idle">{v.line}</p>
              ))}
              {split.analysis.shortfall ? <p className="fg-line">{split.analysis.summary}</p> : null}
            </div>
          ) : null}

          <div className="fg-act">
            <button className="btn btn-primary" disabled={!canSend} onClick={send}>
              Propose to {members.length > 0 ? count(analysis?.used.length || members.length, 'supplier') : 'suppliers'}
              <span className="arrow" aria-hidden="true"> →</span>
            </button>
            <p className="fg-hint" aria-live="polite">
              {sent
                ? 'Proposal ready.'
                : canSend
                  ? split && !split.analysis.irAfter
                    ? 'Some suppliers may decline this split. Each decides for itself.'
                    : 'Each supplier decides for itself.'
                  : members.length === 0
                    ? ''
                    : blocked
                      ? 'Below a minimum order.'
                      : !bundle?.covers
                        ? 'The stage is not covered yet.'
                        : phase.kind === 'working'
                          ? ''
                          : 'No plan fits with this coalition.'}
            </p>
          </div>
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{note}</div>
    </section>
  );
}
