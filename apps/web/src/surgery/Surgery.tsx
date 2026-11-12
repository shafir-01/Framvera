import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Concession, ConstraintRef, InfeasibleCore, Intent, Intervention, SolveReport, Verification, World } from '@framvera/contracts';
import { SourceTag } from '../components/ui.tsx';
import { count, money, weekday } from '../lib/format.ts';
import { LABELS, MAX_BRANCHES, makeBranch, type SurgeryBranch } from './branch.ts';
import { Engine, scanFrontier, type Frontier } from './engine.ts';
import { LeverControl } from './LeverControl.tsx';
import { allLevers, applyWhatIf, changeItems, expressible, jointLevers, leversFor, tightest, toConcessions, type Lever } from './levers.ts';
import { Multiverse } from './Multiverse.tsx';
import './surgery.css';

export interface SurgeryProps {
  world: World;
  intent: Intent;
  core: InfeasibleCore;
  interventions?: Intervention[];
  /** Hands a branch to the app as a proposal to negotiate. It is never an agreement. */
  onCommitBranch?: (branch: SurgeryBranch) => void;
  api?: unknown;
  market?: string;
}

type Deltas = Record<string, number>;

interface Live {
  sig: string;
  pending: boolean;
  feasibility?: 'feasible' | 'infeasible' | 'unknown';
  report?: SolveReport;
  verification?: Verification;
  reportSig?: string;
  ms?: number;
  core?: InfeasibleCore;
  coreSig?: string;
  error?: string;
}

const sigOf = (d: Deltas, without?: string) =>
  Object.keys(d)
    .filter((k) => k !== without && (d[k] ?? 0) > 0)
    .sort()
    .map((k) => `${k}=${d[k]}`)
    .join('&');

/** True when every change in `b` is matched or exceeded in `a`. */
const dominates = (a: Deltas, b: Deltas) => Object.keys(b).every((k) => (a[k] ?? 0) >= (b[k] ?? 0));

const CORE_PAUSE_MS = 600;
const SCAN_PAUSE_MS = 250;

export function Surgery({ world, intent, core, interventions, onCommitBranch }: SurgeryProps) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [deltas, setDeltas] = useState<Deltas>({});
  const [open, setOpen] = useState<string | null>(null);
  const [live, setLive] = useState<Live>({ sig: '', pending: true });
  const [frontiers, setFrontiers] = useState<Record<string, Frontier>>({});
  const [branches, setBranches] = useState<SurgeryBranch[]>([]);
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [showFixed, setShowFixed] = useState(false);
  const liveGen = useRef(0);
  const knownFeasible = useRef<Deltas[]>([]);
  const scanGen = useRef(0);
  const frontiersRef = useRef(frontiers);
  frontiersRef.current = frontiers;

  useEffect(() => {
    const e = new Engine(world, intent);
    setEngine(e);
    setDeltas({});
    setFrontiers({});
    setBranches([]);
    knownFeasible.current = [];
    return () => e.close();
  }, [world, intent]);

  const joints = useMemo(() => jointLevers(interventions ?? [], world), [interventions, world]);
  const suggestions = useMemo(() => {
    const base = allLevers(world, intent, joints);
    return (interventions ?? []).flatMap((iv, i) => {
      const placed = expressible(iv, base);
      return placed ? [{ iv, i, placed }] : [];
    });
  }, [world, intent, interventions, joints]);

  const levers = useMemo(() => {
    const widen = new Map<string, number>();
    for (const s of suggestions) for (const p of s.placed) widen.set(p.key, Math.max(widen.get(p.key) ?? 0, p.delta));
    const map = new Map<string, Lever>();
    for (const l of allLevers(world, intent, joints)) map.set(l.key, { ...l, max: Math.max(l.max, widen.get(l.key) ?? 0) });
    return map;
  }, [world, intent, suggestions, joints]);

  const cards = useMemo(() => {
    const all = core.constraints.map((ref) => ({ ref, levers: leversFor(ref, world, intent, joints).map((l) => levers.get(l.key) ?? l) }));
    return { bendable: all.filter((c) => c.levers.length), fixed: all.filter((c) => !c.levers.length) };
  }, [core, world, intent, levers, joints]);

  useEffect(() => {
    if (open === null && cards.bendable[0]) setOpen(cards.bendable[0].ref.id);
  }, [cards, open]);

  const concessionsOf = useCallback(
    (d: Deltas): Concession[] =>
      Object.keys(d)
        .filter((k) => (d[k] ?? 0) > 0 && levers.has(k))
        .sort()
        .flatMap((k) => toConcessions(levers.get(k)!, d[k]!, world, intent)),
    [levers, world, intent],
  );

  const sig = sigOf(deltas);
  const concessions = useMemo(() => concessionsOf(deltas), [concessionsOf, deltas]);
  const applied = useMemo(() => {
    try {
      return applyWhatIf(world, intent, concessions);
    } catch {
      return { world, intent };
    }
  }, [world, intent, concessions]);

  useEffect(() => {
    if (!engine) return;
    const gen = ++liveGen.current;
    const cs = concessions;
    setLive((l) => ({ ...l, sig, pending: true, error: undefined }));
    const snapshot = deltas;
    (async () => {
      // Every lever only relaxes, so a superset of a possible set of changes is possible too; skip the quick check then.
      const implied = knownFeasible.current.some((k) => dominates(snapshot, k));
      let fMs = 0;
      if (!implied) {
        const f = await engine.feasible('live', cs);
        if (!f || gen !== liveGen.current) return;
        fMs = f.ms;
        const ok = f.feasibility === 'feasible';
        setLive((l) => ({ ...l, feasibility: f.feasibility, pending: ok, ms: f.ms, ...(ok ? {} : { report: undefined, verification: undefined, reportSig: undefined }) }));
        if (!ok) return;
      } else {
        setLive((l) => ({ ...l, feasibility: 'feasible' }));
      }
      const s = await engine.solve('live', cs);
      if (!s || gen !== liveGen.current) return;
      if (s.report.plan) knownFeasible.current = [snapshot, ...knownFeasible.current.filter((k) => !dominates(k, snapshot))].slice(0, 8);
      const ok = s.report.status === 'optimal' || s.report.status === 'feasible';
      setLive((l) => ({ ...l, feasibility: ok ? 'feasible' : s.report.status === 'infeasible' ? 'infeasible' : 'unknown', report: s.report, verification: s.verification, reportSig: sig, ms: fMs + s.ms, pending: false }));
    })().catch((e: unknown) => {
      if (gen === liveGen.current) setLive((l) => ({ ...l, pending: false, error: e instanceof Error ? e.message : String(e) }));
    });
  }, [engine, sig, concessions]);

  useEffect(() => {
    if (!engine || live.sig !== sig || live.feasibility !== 'infeasible' || live.coreSig === sig) return;
    if (!sig) {
      setLive((l) => ({ ...l, core, coreSig: '' }));
      return;
    }
    const cs = concessions;
    const t = setTimeout(() => {
      engine
        .core(cs)
        .then((r) => {
          if (r) setLive((l) => (l.sig === sig ? { ...l, core: r.core, coreSig: sig } : l));
        })
        .catch(() => {});
    }, CORE_PAUSE_MS);
    return () => clearTimeout(t);
  }, [engine, sig, concessions, live.sig, live.feasibility, live.coreSig, core]);

  useEffect(() => {
    if (engine && live.feasibility === 'feasible') engine.stopCore();
  }, [engine, live.feasibility, sig]);

  const openLevers = useMemo(() => cards.bendable.find((c) => c.ref.id === open)?.levers ?? [], [cards, open]);

  useEffect(() => {
    if (!engine || !openLevers.length) return;
    const gen = ++scanGen.current;
    const snapshot = deltas;
    const t = setTimeout(() => {
      engine.cancelScan('scan:');
      (async () => {
        for (const l of openLevers) {
          const fkey = `${l.key}|${sigOf(snapshot, l.key)}`;
          if (frontiersRef.current[fkey]?.done) continue;
          await scanFrontier(
            engine,
            l.key,
            l.max,
            l.grain,
            (d) => concessionsOf({ ...snapshot, [l.key]: d }),
            (f) => setFrontiers((m) => ({ ...m, [fkey]: f })),
            () => gen === scanGen.current,
          );
          if (gen !== scanGen.current) return;
        }
      })().catch(() => {});
    }, SCAN_PAUSE_MS);
    return () => clearTimeout(t);
  }, [engine, openLevers, deltas, concessionsOf]);

  const setDelta = (key: string, d: number) => setDeltas((m) => ({ ...m, [key]: d }));

  const settled = live.sig === sig && !live.pending && !live.error && (live.feasibility === 'infeasible' || live.reportSig === sig);
  const ok = live.sig === sig && live.feasibility === 'feasible';
  const plan = live.reportSig === sig ? live.report?.plan : undefined;
  const stalePlan = !plan && ok ? live.report?.plan : undefined;
  const shown = plan ?? stalePlan;
  const branchSigs = new Set(branches.map((b) => sigOf(b.deltas as Deltas)));
  const freeLabel = LABELS.find((l) => !branches.some((b) => b.label === l));
  const canKeep = !!sig && settled && branches.length < MAX_BRANCHES && !branchSigs.has(sig) && !!freeLabel;
  const keptAs = sig ? branches.find((b) => sigOf(b.deltas as Deltas) === sig)?.label : undefined;

  const keep = () => {
    if (!canKeep || !freeLabel) return;
    const status = live.feasibility === 'feasible' && plan ? 'possible' : live.feasibility === 'infeasible' ? 'impossible' : 'unknown';
    const kept = Object.fromEntries(Object.entries(deltas).filter(([, v]) => v > 0));
    setBranches((bs) => [
      ...bs,
      makeBranch({ label: freeLabel, world, intent: intent.id, concessions, deltas: kept, status, optimal: live.report?.status === 'optimal', plan }),
    ]);
  };

  const commit = (b: SurgeryBranch) => {
    if (!onCommitBranch || b.status !== 'possible') return;
    onCommitBranch(b);
    setSent((s) => new Set(s).add(b.id));
  };

  const tight = plan ? tightest(plan, applied.world, applied.intent).slice(0, 2) : [];
  const coreNow = live.coreSig === sig ? live.core : undefined;
  const before = new Set(core.constraints.map((c) => c.id));
  const cleared = coreNow ? core.constraints.filter((c) => !coreNow.constraints.some((x) => x.id === c.id) && cards.bendable.some((b) => b.ref.id === c.id)) : [];
  const supplierAsks = concessions.filter((c) => c.target.kind === 'offer');
  const askEstimate = supplierAsks.reduce((a, c) => a + c.estimate.minor, 0);
  const usedActors = shown ? [...new Set(shown.allocations.map((a) => a.actor))] : [];
  const name = (actor: string) => world.actors.find((a) => a.id === actor)?.name ?? actor;

  const verdict = live.error
    ? 'Solver unavailable'
    : live.sig !== sig || live.feasibility === undefined
      ? 'Checking'
      : live.feasibility === 'feasible'
        ? 'Possible'
        : live.feasibility === 'infeasible'
          ? sig
            ? 'Still impossible'
            : 'Impossible'
          : 'Undecided';

  return (
    <section className="sg" aria-labelledby="sg-title">
      <header className="sg-head">
        <h2 className="h2" id="sg-title">
          What would make it <em>possible</em>?
        </h2>
        <p className="lede">Pick a blocking limit and bend it.</p>
      </header>

      {suggestions.length > 0 && (
        <div className="sg-suggest" role="group" aria-label="Start from a planner suggestion">
          <span className="fine">Suggested</span>
          {suggestions.map((s) => (
            <button
              key={s.iv.id}
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => setDeltas(Object.fromEntries(s.placed.map((p) => [p.key, p.delta])))}
              title={changeItems(s.iv.concessions, world).map((c) => c.text).join('. ')}
            >
              {count(s.iv.concessions.length, 'change')}
              {s.iv.totalAfter ? <span className="num sg-muted">{money(s.iv.totalAfter)}</span> : null}
            </button>
          ))}
        </div>
      )}

      <div className="sg-grid">
        <div className="sg-cards">
          <h3 className="h3">
            Blocking limits <span className="count">{core.constraints.length}</span>
          </h3>
          {core.constraints.length === 0 ? (
            <p className="notice">Nothing blocks this order as published.</p>
          ) : (
            <ol className="sg-card-list">
              {cards.bendable.map(({ ref, levers: ls }) => {
                const isOpen = ref.id === open;
                const moved = ls.filter((l) => (deltas[l.key] ?? 0) > 0).length;
                const gone = cleared.some((c) => c.id === ref.id);
                return (
                  <li key={ref.id} className="sg-card" data-open={isOpen || undefined} data-cleared={gone || undefined}>
                    <button type="button" className="sg-card-head" aria-expanded={isOpen} aria-controls={`sg-l-${ref.id}`} onClick={() => setOpen(isOpen ? '' : ref.id)}>
                      <span className="sg-card-text">{ref.text}</span>
                      <span className="sg-card-meta">{gone ? 'Cleared' : moved ? count(moved, 'change') : ''}</span>
                    </button>
                    {isOpen && (
                      <div className="sg-levers" id={`sg-l-${ref.id}`}>
                        {ls.map((l) => (
                          <LeverControl
                            key={l.key}
                            lever={l}
                            delta={deltas[l.key] ?? 0}
                            currency={intent.budget.currency}
                            frontier={frontiers[`${l.key}|${sigOf(deltas, l.key)}`]}
                            compact={!l.own && !l.joint && l.offer === ref.subject}
                            onChange={(d) => setDelta(l.key, d)}
                          />
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {concessions.length > 0 && (
            <div className="sg-bar" data-ok={ok || undefined} aria-hidden="true">
              <span className="sg-dot" />
              <span>{verdict}</span>
              {shown && <span className="num sg-muted">{money(shown.total)}, {weekday(shown.readyAt)}</span>}
            </div>
          )}
          {cards.fixed.length > 0 && (
            <div className="sg-fixed">
              <button type="button" className="sg-link" aria-expanded={showFixed} onClick={() => setShowFixed((v) => !v)}>
                {showFixed ? 'Hide' : 'Show'} {count(cards.fixed.length, 'fixed limit')}
              </button>
              {showFixed && (
                <ul>
                  {cards.fixed.map(({ ref }) => (
                    <li key={ref.id}>
                      {ref.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <aside className="sg-result panel" data-ok={ok || undefined} data-busy={live.pending || undefined} aria-labelledby="sg-verdict">
          <p className="sg-verdict" id="sg-verdict" role="status" aria-live="polite">
            <span className="sg-dot" aria-hidden="true" />
            {verdict}
          </p>
          {live.error ? (
            <p className="fine">{live.error}</p>
          ) : (
            <>
              {shown ? (
                <dl className="sg-figs" data-stale={(!plan && !!stalePlan) || undefined}>
                  <div>
                    <dt>Cost</dt>
                    <dd className="num">{money(shown.total)}</dd>
                    <span className="sg-sub num">budget {money(applied.intent.budget)}</span>
                  </div>
                  <div>
                    <dt>Ready</dt>
                    <dd className="num">{weekday(shown.readyAt)}</dd>
                    <span className="sg-sub num">deadline {weekday(applied.intent.deadline)}</span>
                  </div>
                </dl>
              ) : (
                <p className="sg-target num">
                  {money(applied.intent.budget)} by {weekday(applied.intent.deadline)}
                </p>
              )}

              {ok && tight.length > 0 && (
                <div className="sg-next">
                  <p className="sg-label">Tightest now</p>
                  <ul>
                    {tight.map((t) => (
                      <li key={t.id}>{t.text}</li>
                    ))}
                  </ul>
                </div>
              )}

              {!!sig && live.sig === sig && live.feasibility === 'infeasible' && (
                <div className="sg-next">
                  <p className="sg-label">Still blocked by</p>
                  {coreNow ? (
                    <>
                      <ul>
                        {coreNow.constraints.slice(0, 4).map((c: ConstraintRef) => (
                          <li key={c.id}>
                            {!before.has(c.id) && <span className="sg-new">New</span>}
                            {c.text}
                          </li>
                        ))}
                      </ul>
                      {coreNow.constraints.length > 4 && <p className="fine">+{coreNow.constraints.length - 4} more</p>}
                    </>
                  ) : (
                    <p className="fine sg-wait">Finding</p>
                  )}
                </div>
              )}

              {shown && usedActors.length > 0 && (
                <p className="sg-uses">
                  <span className="sg-label">Uses {count(usedActors.length, 'supplier')}</span>
                  {usedActors.map((a) => (
                    <span key={a} className="sg-actor">
                      {name(a)}
                    </span>
                  ))}
                </p>
              )}

              <p className="sg-proof">
                <SourceTag
                  kind="solver"
                  title={[
                    live.ms !== undefined ? `${Math.round(live.ms)} ms` : '',
                    plan && live.verification ? `re-checked independently: ${live.verification.checks.filter((c) => c.ok).length} of ${live.verification.checks.length} checks pass` : '',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                >
                  Solved on this device
                </SourceTag>
                {plan && live.verification && !live.verification.ok && (
                  <span>
                    Re-check failed: {live.verification.checks.filter((c) => c.ok).length} of {live.verification.checks.length}
                  </span>
                )}
                {plan && live.report?.status === 'feasible' && <span>A cheaper plan may exist</span>}
              </p>
            </>
          )}

          {concessions.length > 0 && (
            <div className="sg-changes">
              <p className="sg-label">Your changes</p>
              <ul>
                {changeItems(concessions, world).map((c) => (
                  <li key={c.key}>
                    {c.own && <span className="sg-own">Your own</span>}
                    <span>{c.text}</span>
                    <button type="button" className="sg-x" onClick={() => setDelta(c.key, 0)} aria-label={`Undo: ${c.text}`}>
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <path d="M1 1l8 8M9 1 1 9" stroke="currentColor" strokeWidth="1.4" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
              {supplierAsks.length > 0 && (
                <p className="sg-proof">
                  <SourceTag kind="estimate" />
                  <span className="num">{money({ currency: intent.budget.currency, minor: askEstimate })}</span>
                  <span>cost to suppliers</span>
                </p>
              )}
            </div>
          )}

          <div className="sg-actions">
            {keptAs ? (
              <p className="fine">Kept as branch {keptAs}</p>
            ) : (
              <button type="button" className="btn btn-primary" onClick={keep} disabled={!canKeep}>
                Keep as branch
              </button>
            )}
            {concessions.length > 0 && (
              <button type="button" className="sg-link" onClick={() => setDeltas({})}>
                Clear all
              </button>
            )}
          </div>
          {branches.length >= MAX_BRANCHES && !keptAs && <p className="fine">Remove a branch to keep another.</p>}
        </aside>
      </div>

      <Multiverse
        world={world}
        intent={intent}
        branches={branches}
        sent={sent}
        activeSig={sig}
        sigOf={(b) => sigOf(b.deltas as Deltas)}
        onOpen={(b) => setDeltas({ ...(b.deltas as Deltas) })}
        onRemove={(b) => setBranches((bs) => bs.filter((x) => x.id !== b.id))}
        onCommit={onCommitBranch ? commit : undefined}
      />
    </section>
  );
}
