import { useState } from 'react';
import { useStore } from '../store.tsx';
import { Forge } from '../mounts.tsx';

export function Explore() {
  const { s, world } = useStore();
  const [open, setOpen] = useState(false);
  const w = s.negotiation?.world ?? world ?? s.market?.world;
  if (!s.market || !s.intent || !w || !Forge.available || !s.analysis) return null;
  return (
    <section className="act" id="explore" aria-labelledby="explore-h">
      <div className="obs-head" style={{ marginTop: 0 }}>
        <div>
          <div className="act-num" style={{ marginBottom: 10 }}>
            Explore
          </div>
          <h2 className="h3" id="explore-h" style={{ fontSize: 17, marginBottom: 4 }}>
            Build a coalition by hand
          </h2>
          <div className="fine">Pick suppliers for a stage; see if they can cover it and how payment splits.</div>
        </div>
        <button className="btn btn-quiet btn-small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Open'}
        </button>
      </div>
      {open ? <Forge world={w} intent={s.intent} loading="Opening the coalition builder" /> : null}
    </section>
  );
}
