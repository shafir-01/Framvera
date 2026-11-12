import { loadEngine } from '../src/engine.ts';
process.env.VITEST = '1';
const e: any = await loadEngine();
const { world, intent, truth } = e.createMarket({ template: 'flagship', seed: null, family: 'flagship' });
const r = await e.negotiate(world, intent, truth, { explain: false });
const a = e.sign(e.commit(r.plan, r.intent, r.decisions, { world: r.world }), r.world, truth).agreement;
console.log('agreement', a.state, a.obligations.map((o: any) => `${o.id} ${o.actor} ${o.offer} ${o.qty} ${o.start}->${o.due}`));
const d = { ...truth.shocks[0] };
const dd = e.disrupt(a, r.world, d, {});
console.log('affected', dd.affected.map((o: any) => o.id), 'atRisk', dd.atRisk.map((o: any) => o.id));
const rec = await e.recover(a, dd.world, r.intent, d, {});
console.log('feasible', rec.feasible, rec.core?.summary, JSON.stringify(rec.concessionsNeeded)?.slice(0, 800));
console.log(JSON.stringify(rec.candidates, null, 0).slice(0, 2500));
console.log(JSON.stringify(rec.rejected).slice(0, 800));
if (!rec.feasible) {
  const t0 = Date.now();
  const n = await e.negotiate(dd.world, r.intent, truth, { explain: false });
  console.log('renegotiate', ((Date.now() - t0) / 1000).toFixed(1), n.outcome, JSON.stringify(n.accepted.map((c: any) => [c.id, c.target, c.to])));
  if (n.world) {
    const rec2 = await e.recover(a, n.world, r.intent, d, {});
    console.log('recover2', rec2.feasible, rec2.kept, rec2.amended, rec2.cancelled, rec2.added?.map((x: any) => x.offer), rec2.extraCost, JSON.stringify(rec2.rejected).slice(0, 600));
  }
}
