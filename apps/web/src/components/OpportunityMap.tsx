import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { Coalition, Id, Offer, Plan, World } from '@framvera/contracts';
import { bestUnitPrice, indexWorld, offerParts } from '../lib/world.ts';
import { money } from '../lib/format.ts';

interface Props {
  world: World;
  coalition?: Coalition;
  touched: Set<Id>;
  plan?: Plan;
  disputed: Set<Id>;
  gone: Set<Id>;
  onInspect: (offer: Offer) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function OpportunityMap({ world, coalition, touched, plan, disputed, gone, onInspect }: Props) {
  const ix = useMemo(() => indexWorld(world), [world]);
  const stages = ix.layers.flat();
  const inPlan = new Set((plan?.allocations ?? []).flatMap((a) => [a.offer, ...offerParts(a.offer)]));
  const members = new Set<Id>([...(coalition?.inputs ?? []).flatMap((i) => [i.offer, ...offerParts(i.offer)]), ...touched]);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const centred = useRef('');
  const nodes = useRef(new Map<Id, HTMLElement>());
  const [boxes, setBoxes] = useState<Map<Id, Box>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });

  const memberKey = [...members].sort().join('|');
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const m = new Map<Id, Box>();
      for (const [id, n] of nodes.current) {
        if (!members.has(id) && !inPlan.has(id)) continue;
        const r = n.getBoundingClientRect();
        m.set(id, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
      }
      setBoxes(m);
      setSize({ w: base.width, h: base.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey, plan?.id, world.version]);

  const linked = coalition ? new Set((coalition.inputs ?? []).flatMap((i) => offerParts(i.offer)).filter((id) => ix.offer(id))) : members;
  const memberBoxes = [...linked].map((id) => boxes.get(id)).filter((b): b is Box => !!b);
  const hub = (() => {
    if (memberBoxes.length < 2) return undefined;
    const cols = [...new Set(memberBoxes.map((b) => Math.round(b.x)))].sort((x, y) => x - y);
    const y = memberBoxes.reduce((a, b) => a + b.y + b.h / 2, 0) / memberBoxes.length;
    if (cols.length < 2) {
      const b0 = memberBoxes[0]!;
      return { x: b0.x + b0.w + 14, y };
    }
    const right = memberBoxes.filter((b) => Math.round(b.x) === cols[cols.length - 1]);
    const rx = Math.min(...right.map((b) => b.x));
    return { x: rx - 14, y };
  })();

  const hubKey = hub ? `${coalition?.id ?? ''}|${Math.round(hub.x)}` : '';
  useEffect(() => {
    const sc = scroller.current;
    if (!hub || !sc || centred.current === hubKey || sc.scrollWidth <= sc.clientWidth + 4) return;
    centred.current = hubKey;
    sc.scrollTo({ left: Math.max(0, hub.x - sc.clientWidth / 2), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [hubKey, hub]);

  const flows: { from: Box; to: Box; key: string }[] = [];
  if (plan) {
    for (const st of stages) {
      for (const pred of st.after) {
        const ups = plan.allocations.filter((a) => a.stage === pred).flatMap((a) => offerParts(a.offer));
        const downs = plan.allocations.filter((a) => a.stage === st.id).flatMap((a) => offerParts(a.offer));
        for (const u of ups)
          for (const d of downs) {
            const a = boxes.get(u);
            const b = boxes.get(d);
            if (a && b) flows.push({ from: a, to: b, key: `${u}>${d}` });
          }
      }
    }
  }

  const sorted = (list: Offer[]) =>
    [...list].sort((a, b) => {
      const rank = (o: Offer) => (members.has(o.id) ? 0 : inPlan.has(o.id) ? 1 : 2);
      return rank(a) - rank(b) || bestUnitPrice(a, 0) - bestUnitPrice(b, 0);
    });

  return (
    <>
      {coalition || touched.size ? (
        <p className="coalition-caption">
          <span className="hub-dot" aria-hidden="true" />
          {coalition
            ? `New coalition: ${coalition.members.map((m) => ix.actorName(m)).join(', ')} · ${coalition.output.qty.toLocaleString('en-GB').replace(/,/g, ' ')} ${ix.stage(coalition.output.stage)?.unit ?? 'units'}`
            : `Proposed change: ${[...touched].map((o) => ix.actorName(ix.offer(o)?.actor)).join(', ')}`}
        </p>
      ) : null}
    <div className="map-scroll" ref={scroller}>
      <div className="map" ref={wrap}>
        <div className="map-grid" style={{ ['--cols' as string]: stages.length }}>
          {stages.map((st) => {
            const offers = sorted(ix.offersByStage.get(st.id) ?? []);
            return (
              <div className="map-col" key={st.id}>
                <h4>
                  <span>{st.name}</span>
                  <span className="num">{offers.length}</span>
                </h4>
                <ul aria-label={`${st.name} suppliers`}>
                  {offers.map((o) => {
                    const actor = ix.actor(o.actor);
                    const role = members.has(o.id) ? 'member' : inPlan.has(o.id) ? 'plan' : coalition || plan ? 'idle' : 'neutral';
                    const isGone = gone.has(o.actor) || actor?.active === false;
                    const label = `${actor?.name ?? o.actor}, ${st.name}, capacity ${o.capacity} ${st.unit}, ${money(o.tiers[0]?.unit)} per unit${role === 'member' ? ', part of the new arrangement' : role === 'plan' ? ', in the plan' : ''}${isGone ? ', withdrawn' : ''}${disputed.has(o.id) ? ', capacity claim disputed' : ''}`;
                    return (
                      <li key={o.id}>
                        <button
                          ref={(el) => {
                            if (el) nodes.current.set(o.id, el);
                            else nodes.current.delete(o.id);
                          }}
                          className="node"
                          data-role={role}
                          data-gone={isGone}
                          onClick={() => onInspect(o)}
                          aria-label={label}
                        >
                          <span className="n-name">
                            <span>{actor?.name ?? o.actor}</span>
                          </span>
                          <span className="n-meta">
                            {o.capacity.toLocaleString('en-GB').replace(/,/g, ' ')} · {money(o.tiers[0]?.unit)}
                          </span>
                          {o.derivedFrom ? <span className="node-flag" style={{ color: 'var(--accent)' }}>New terms</span> : null}
                          {disputed.has(o.id) ? (
                            <span className="node-flag">
                              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                                <path d="M5 1 9.5 9h-9z" stroke="currentColor" fill="none" strokeWidth="1.2" />
                              </svg>
                              Claim disputed
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        <svg className="map-svg" width={size.w} height={size.h} aria-hidden="true">
          {flows.map(({ from, to, key }) => {
            const x1 = from.x + from.w;
            const y1 = from.y + from.h / 2;
            const x2 = to.x;
            const y2 = to.y + to.h / 2;
            const mx = (x1 + x2) / 2;
            return (
              <motion.path
                key={key}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                stroke="var(--ink-3)"
                strokeWidth={1}
                fill="none"
                strokeDasharray="2 3"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 0.8 }}
                transition={{ duration: 0.9 }}
              />
            );
          })}
          {hub
            ? memberBoxes.map((b, i) => {
                const leftSide = b.x + b.w / 2 < hub.x;
                const x1 = leftSide ? b.x + b.w : b.x;
                const y1 = b.y + b.h / 2;
                const mx = (x1 + hub.x) / 2;
                const d = `M${x1},${y1} C${mx},${y1} ${mx},${hub.y} ${hub.x},${hub.y}`;
                return (
                  <g key={i}>
                    <motion.path d={d} stroke="var(--accent-soft)" strokeWidth={9} fill="none" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, delay: 0.15 * i }} />
                    <motion.path d={d} stroke="var(--accent)" strokeWidth={1.6} fill="none" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, delay: 0.15 * i }} />
                  </g>
                );
              })
            : null}
          {hub ? (
            <motion.g initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.7, duration: 0.4 }} style={{ transformOrigin: `${hub.x}px ${hub.y}px` }}>
              <circle cx={hub.x} cy={hub.y} r={11} fill="var(--accent-soft)" />
              <circle cx={hub.x} cy={hub.y} r={5.5} fill="var(--accent)" />
            </motion.g>
          ) : null}
        </svg>
      </div>
    </div>
    </>
  );
}
