import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useStore } from '../store.tsx';
import { constraintStages, indexWorld, KIND_LABEL } from '../lib/world.ts';
import { count, money, when } from '../lib/format.ts';
import { SourceTag } from './ui.tsx';
import { Surgery } from '../mounts.tsx';

export const solveTime = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export function Discover() {
  const { s, api } = useStore();
  const [focus, setFocus] = useState<string | null>(null);
  const [surgery, setSurgery] = useState(false);
  const [all, setAll] = useState(false);
  const report = s.analysis?.report;
  const world = s.market?.world;
  const ix = useMemo(() => (world ? indexWorld(world) : undefined), [world]);
  if (!report || !ix || !s.intent) return null;
  const core = report.core;

  if (report.status !== 'infeasible') {
    return (
      <section className="act" id="discover" tabIndex={-1} aria-labelledby="discover-h">
        <div className="act-head">
          <div className="act-num">Discover</div>
          <h2 className="h2" id="discover-h">
            {report.plan ? 'Today’s offers can already do this.' : 'The market could not be tested.'}
          </h2>
          <p className="lede">{report.plan ? `Cheapest plan: ${money(report.plan.total)}.` : `Solver status: ${report.status}.`}</p>
        </div>
      </section>
    );
  }

  const blockedStages = new Map<string, string[]>();
  let globalIds: string[] = [];
  for (const c of core?.constraints ?? []) {
    const st = constraintStages(c, ix);
    if (st === 'global') globalIds.push(c.id);
    else for (const id of st) blockedStages.set(id, [...(blockedStages.get(id) ?? []), c.id]);
  }
  const focusStages = focus ? (blockedStages.size ? [...blockedStages.entries()].filter(([, ids]) => ids.includes(focus)).map(([id]) => id) : []) : [];
  const focusGlobal = focus ? globalIds.includes(focus) : false;
  globalIds = [...new Set(globalIds)];

  return (
    <section className="act" id="discover" tabIndex={-1} aria-labelledby="discover-h">
      <div className="act-head">
        <div className="act-num">Discover</div>
        <h2 className="h2" id="discover-h">
          No combination of today’s offers can do this.
        </h2>
      </div>

      <div className="chain" role="list" aria-label="Production chain">
        {ix.layers.map((layer, li) => (
          <div className="chain-col" key={li} role="presentation">
            {layer.map((st, si) => {
              const offers = ix.offersByStage.get(st.id) ?? [];
              const cap = offers.reduce((a, o) => a + o.capacity, 0);
              const blocked = blockedStages.has(st.id);
              const lit = focusStages.includes(st.id);
              return (
                <motion.div
                  key={st.id}
                  role="listitem"
                  className="stage-node"
                  data-blocked={blocked}
                  data-lit={lit}
                  data-dim={!!focus && !lit}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 * (li * 3 + si), duration: 0.4 }}
                >
                  <div className="s-name">{st.name}</div>
                  <div className="s-meta num">
                    {count(offers.length, 'offer')} · up to {cap.toLocaleString('en-GB').replace(/,/g, ' ')} {st.unit}
                  </div>
                  {blocked ? (
                    <span className="block-flag">
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      Blocks the order
                    </span>
                  ) : null}
                </motion.div>
              );
            })}
          </div>
        ))}
        <div className="chain-col" role="presentation">
          <motion.div
            role="listitem"
            className="stage-node venue-node"
            data-blocked={globalIds.length > 0}
            data-lit={focusGlobal}
            data-dim={!!focus && !focusGlobal}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35, duration: 0.4 }}
          >
            <div className="s-name">{s.intent.deliverTo || 'Delivered'}</div>
            <div className="s-meta">Deadline and budget</div>
          </motion.div>
        </div>
      </div>

      {core ? (
        <>
          <ol className="core-list" aria-label="Why it fails">
            {(all ? core.constraints : core.constraints.slice(0, 6)).map((c, i) => (
              <li
                key={c.id}
                className="core-item"
                tabIndex={0}
                onMouseEnter={() => setFocus(c.id)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(c.id)}
                onBlur={() => setFocus(null)}
              >
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <span className="k">{KIND_LABEL[c.kind] ?? c.kind}</span>
                <span className="t">{c.text}</span>
              </li>
            ))}
          </ol>
          {core.constraints.length > 6 ? (
            <button className="top-link" style={{ marginTop: 8 }} aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${core.constraints.length} conditions`}
            </button>
          ) : null}
          <div className="proof-line">
            <SourceTag kind="solver" />
            <span className="num">{solveTime(report.solver.ms)}</span>
            {core.minimal && core.proven ? <span>Remove any one and the order works.</span> : core.proven ? <span>Proven impossible.</span> : <span>Not proven: the solver stopped early.</span>}
            {Surgery.available ? (
              <button className="top-link" style={{ marginLeft: 'auto' }} aria-expanded={surgery} onClick={() => setSurgery((v) => !v)}>
                {surgery ? 'Hide' : 'Change a limit yourself'}
              </button>
            ) : null}
          </div>
          {surgery && s.market ? (
            <div style={{ marginTop: 24 }}>
              <Surgery api={api} market={s.market.market} world={ix.world} intent={s.intent} core={core} loading="Opening the constraint editor" />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
