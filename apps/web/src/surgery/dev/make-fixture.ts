import { writeFileSync } from 'node:fs';
import { explainInfeasible, findInterventions, solve } from '@framvera/solver';
import { flagshipWorld } from '@framvera/market';

const { world, intent } = flagshipWorld();
const t0 = performance.now();
const report = await solve(world, intent, { explain: false });
console.log('solve', report.status, Math.round(performance.now() - t0), 'ms');
const t1 = performance.now();
const core = await explainInfeasible(world, intent);
console.log('core', core.constraints.length, Math.round(performance.now() - t1), 'ms');
const t2 = performance.now();
const interventions = await findInterventions(world, intent);
console.log('interventions', interventions.length, Math.round(performance.now() - t2), 'ms');
for (const i of interventions) console.log(' ', i.method, i.totalAfter?.minor, i.concessions.map((c) => `${c.target.kind === 'offer' ? c.target.offer : 'intent'}:${c.target.field} ${c.from} -> ${c.to}`).join(' | '));
writeFileSync(new URL('./flagship.json', import.meta.url), JSON.stringify({ world, intent, core, interventions }));
