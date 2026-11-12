import { loadEngine } from '../src/engine.ts';
process.env.VITEST = '1';
const e: any = await loadEngine();
const { world, intent, truth } = e.createMarket({ template: 'flagship', seed: null, family: 'flagship' });
const r = await e.negotiate(world, intent, truth, { explain: false });
const a = e.sign(e.commit(r.plan, r.intent, r.decisions, { world: r.world }), r.world, truth).agreement;
const d = { ...truth.shocks[0] };
const dd = e.disrupt(a, r.world, d, {});
const show = (w: any) => w.offers.filter((o: any) => o.stage === 'deliver').map((o: any) => `${o.id} cap=${o.capacity} ${o.window.start.slice(5,16)}-${o.window.end.slice(5,16)} neg=${o.negotiable} ref=${o.provenance?.ref ?? ''} act=${w.actors.find((x: any) => x.id === o.actor)?.active}`);
console.log('before', show(r.world));
console.log('after', show(dd.world));
const iv = await e.findInterventions(dd.world, r.intent, { k: 5 });
console.log('interventions', iv.length, JSON.stringify(iv.map((i: any) => [i.unlocks, i.concessions.map((c: any) => [c.target, c.to])])).slice(0, 800));
const s = await e.solve(dd.world, r.intent);
console.log('solve', s.status, s.plan?.total, s.core?.summary);
console.log('manifest', JSON.stringify(truth.recovery?.valid?.certificate).slice(0, 600));
const cert = truth.recovery?.valid?.certificate;
console.log('cert', JSON.stringify(cert.concessions.map((c: any) => [c.id, c.target, c.to])), JSON.stringify(cert.coalitions));
const joints = cert.concessions.filter((c: any) => c.target.field === 'joint');
try {
  const ap = e.applyConcessions(dd.world, r.intent, joints);
  const s2 = await e.solve(ap.world, ap.intent);
  console.log('apply joints', s2.status, s2.plan?.total, s2.plan?.allocations?.map((x: any) => x.offer));
} catch (err: any) { console.log('apply err', err.message); }
const j2 = joints.map((c: any) => ({ ...c, from: 'separate', to: 'joint:shared:o-roslagen>o-malardalen' }));
try {
  const ap = e.applyConcessions(dd.world, r.intent, j2);
  console.log('joint offers', ap.world.offers.filter((o: any) => o.stage === 'deliver').map((o: any) => `${o.id} ${o.capacity} ${o.window.start.slice(5,16)}-${o.window.end.slice(5,16)}`));
  const s2 = await e.solve(ap.world, ap.intent);
  console.log('apply joints solver-format', s2.status, s2.plan?.total, s2.core?.summary);
  const rec3 = await e.recover(a, ap.world, r.intent, d, {});
  console.log('recover3', rec3.feasible, rec3.kept, rec3.amended, rec3.added?.map((x: any) => x.offer), rec3.extraCost, JSON.stringify(rec3.rejected).slice(0, 400));
} catch (err: any) { console.log('apply err', err.message); }
const co = e.synthesizeCoalitions(dd.world, r.intent);
console.log('coalitions on disrupted world', JSON.stringify(co.map((c: any) => [c.members, c.inputs.map((i: any) => i.offer), c.output])));
const iv0 = await e.findInterventions(world, intent, { k: 5 });
console.log('interventions on original world', iv0.length);
