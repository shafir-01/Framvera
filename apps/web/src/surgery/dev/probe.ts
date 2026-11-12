import { flagshipWorld } from '@framvera/market';
import { explainInBrowser, feasibleInBrowser, solveAndVerifyInBrowser } from '../solver.ts';

export async function probe(el: HTMLElement) {
  const { world, intent } = flagshipWorld();
  const t0 = performance.now();
  const out: Record<string, unknown> = {};
  out.feasible = await feasibleInBrowser(world, intent);
  out.firstMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const s = await solveAndVerifyInBrowser(world, intent, { explain: false });
  out.solve = { status: s.report.status, solver: s.report.solver, total: s.report.plan?.total, readyAt: s.report.plan?.readyAt, verified: s.verification?.ok, wallMs: Math.round(performance.now() - t1) };
  if (s.report.status === 'infeasible') {
    const t2 = performance.now();
    const core = await explainInBrowser(world, intent);
    out.core = { ids: core.constraints.map((c) => c.id), proven: core.proven, minimal: core.minimal, wallMs: Math.round(performance.now() - t2) };
  }
  el.dataset.done = '1';
  el.textContent = JSON.stringify(out);
}
