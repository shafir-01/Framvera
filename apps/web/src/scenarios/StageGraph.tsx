import type { Stage } from '@framvera/contracts';
import { layoutStages } from './graph.ts';

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function StageGraph({ stages, label, tone = 'plain' }: { stages: Stage[]; label: string; tone?: 'plain' | 'new' | 'stop' }) {
  const L = layoutStages(stages, { width: 320 });
  const chars = Math.max(5, Math.floor(L.nodeW / 6.4));
  return (
    <svg className="sc-graph" data-tone={tone} viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label={label}>
      {L.edges.map((e) => (
        <path key={`${e.from}-${e.to}`} className="sc-edge" d={e.d} />
      ))}
      {L.nodes.map((n) => (
        <g key={n.stage.id} transform={`translate(${n.x} ${n.y})`}>
          <title>{`${n.stage.name}, ${n.stage.unit}`}</title>
          <rect className="sc-node" width={L.nodeW} height={L.nodeH} rx="7" />
          <text className="sc-node-text" x={L.nodeW / 2} y={L.nodeH / 2 + 3.5} textAnchor="middle">
            {clip(n.stage.name, chars)}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Drawn before any supplier is known: the chain exists but its shape does not. */
export function UnknownGraph({ label }: { label: string }) {
  const xs = [4, 92, 180, 268];
  return (
    <svg className="sc-graph" data-tone="unknown" viewBox="0 0 320 50" role="img" aria-label={label}>
      {xs.slice(1).map((x, i) => (
        <path key={x} className="sc-edge sc-dashed" d={`M${(xs[i] ?? 0) + 48} 25 H${x}`} />
      ))}
      {xs.map((x) => (
        <g key={x} transform={`translate(${x} 10)`}>
          <rect className="sc-node sc-dashed" width="48" height="30" rx="7" />
          <text className="sc-node-text" x="24" y="19.5" textAnchor="middle">
            ?
          </text>
        </g>
      ))}
    </svg>
  );
}
