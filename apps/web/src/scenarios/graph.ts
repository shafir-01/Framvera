import type { Intent, Money, Stage, World } from '@framvera/contracts';

export interface LaidNode {
  stage: Stage;
  depth: number;
  x: number;
  y: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  d: string;
}

export interface Layout {
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
}

export function stageDepths(stages: Stage[]): Map<string, number> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of byId.get(id)?.after ?? []) if (byId.has(p)) d = Math.max(d, walk(p) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const s of stages) walk(s.id);
  return depth;
}

export function layoutStages(stages: Stage[], opts: { width?: number; nodeH?: number } = {}): Layout {
  const nodeH = opts.nodeH ?? 30;
  const gapY = 12;
  const width = opts.width ?? 320;
  const depth = stageDepths(stages);
  const cols = Math.max(0, ...depth.values()) + 1;
  const columns: Stage[][] = Array.from({ length: cols }, () => []);
  for (const s of stages) columns[depth.get(s.id) ?? 0]?.push(s);
  const nodeW = Math.max(40, Math.min(96, Math.floor((width - 8) / cols - (cols > 1 ? 14 : 0))));
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const height = rows * nodeH + (rows - 1) * gapY + 8;
  const step = cols > 1 ? (width - nodeW - 8) / (cols - 1) : 0;
  const nodes: LaidNode[] = [];
  columns.forEach((col, di) => {
    const colH = col.length * nodeH + (col.length - 1) * gapY;
    const top = (height - colH) / 2;
    col.forEach((stage, row) => nodes.push({ stage, depth: di, x: 4 + di * step, y: top + row * (nodeH + gapY) }));
  });
  const at = new Map(nodes.map((n) => [n.stage.id, n]));
  const edges: LaidEdge[] = [];
  for (const n of nodes) {
    for (const p of n.stage.after) {
      const a = at.get(p);
      if (!a) continue;
      const x1 = a.x + nodeW;
      const y1 = a.y + nodeH / 2;
      const y2 = n.y + nodeH / 2;
      const mx = (x1 + n.x) / 2;
      edges.push({ from: p, to: n.stage.id, d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${n.x} ${y2}` });
    }
  }
  return { width, height, nodeW, nodeH, nodes, edges };
}

export function stageChain(stages: Stage[]): string[] {
  const depth = stageDepths(stages);
  return [...stages].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0)).map((s) => s.name);
}

export function supplierCount(world: World): number {
  return world.actors.filter((a) => a.active && (a.kind === 'supplier' || a.kind === 'logistics')).length;
}

export function finalUnit(stages: Stage[]): string {
  const used = new Set(stages.flatMap((s) => s.after));
  const last = [...stages].reverse().find((s) => !used.has(s.id)) ?? stages[stages.length - 1];
  return last?.unit ?? 'units';
}

export interface Brief {
  chain: string[];
  suppliers: number;
  objective: string;
}

export function briefOf(world: World, intent: Intent, fmtMoney: (m: Money) => string, fmtDay: (iso: string) => string): Brief {
  return {
    chain: stageChain(world.stages),
    suppliers: supplierCount(world),
    objective: `${intent.quantity.toLocaleString('en-GB')} ${finalUnit(world.stages)} by ${fmtDay(intent.deadline)}, within ${fmtMoney(intent.budget)}`,
  };
}
