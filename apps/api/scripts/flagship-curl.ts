/**
 * Drives the flagship through a running Framvera server with curl and writes a redacted trace.
 * Usage: npx tsx --env-file-if-exists=.env apps/api/scripts/flagship-curl.ts [baseUrl] [out.json]
 * Order approval uses the PayPal sandbox test buyer (test harness) when its login is configured.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { assertNoSecrets, redactTrace } from '@framvera/paypal';

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = (process.argv[2] ?? 'http://localhost:8791').replace(/\/$/, '');
const out = process.argv[3] ?? 'evidence/api-flagship.json';
const steps: any[] = [];
const t0 = Date.now();

function curl(step: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const args = ['-s', '-S', '-m', '600', '-X', method, '-w', '\n%{http_code}', `${base}${path}`];
  if (body !== undefined) args.push('-H', 'content-type: application/json', '--data-binary', '@-');
  const started = Date.now();
  const raw = execFileSync('curl', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const nl = raw.lastIndexOf('\n');
  const status = Number(raw.slice(nl + 1));
  let json: any = null;
  try {
    json = JSON.parse(raw.slice(0, nl));
  } catch {
    json = null;
  }
  const shown = body && typeof body === 'object' ? JSON.stringify({ ...(body as object), ...('approvalToken' in (body as object) ? { approvalToken: '[redacted]' } : {}) }) : '';
  const command = `curl -s -X ${method} ${base}${path}${shown ? ` -H 'content-type: application/json' -d '${shown}'` : ''}`;
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${status} ${step}`);
  return { status, json, command, ms: Date.now() - started };
}

function record(step: string, r: { status: number; command: string; ms: number }, summary: unknown) {
  steps.push({ step, command: r.command, status: r.status, ms: r.ms, result: summary });
}

const money = (m: any) => (m ? `${(m.minor / 100).toFixed(2)} ${m.currency}` : null);
const pay = (p: any) => ({
  id: p.id, state: p.state, payee: p.payee, amount: money(p.amount), obligations: p.obligations, operationKey: p.operationKey,
  paypal: redactTrace({ env: p.paypal?.env, orderId: p.paypal?.orderId, status: p.paypal?.status, orderStatus: p.paypal?.orderStatus, captureId: p.paypal?.captureId, captureStatus: p.paypal?.captureStatus, captured: money(p.paypal?.captured), lastFetchedAt: p.paypal?.lastFetchedAt, debugIds: p.paypal?.debugIds, approveHost: p.paypal?.approveUrl ? new URL(p.paypal.approveUrl).host : undefined }),
});
const fail = (step: string, r: any) => {
  record(step, r, r.json);
  throw new Error(`${step} answered ${r.status}: ${JSON.stringify(r.json)?.slice(0, 300)}`);
};

let market = '';
try {
  const st = curl('status', 'GET', '/api/status');
  record('status', st, { build: st.json.build, paypal: { ...st.json.paypal, clientId: st.json.paypal?.clientId ? '[public client id present]' : null }, services: st.json.services });

  const m = curl('create market', 'POST', '/api/markets', { template: 'flagship' });
  if (m.status !== 201) fail('create market', m);
  market = m.json.id;
  record('create market', m, { market, template: m.json.template, world: m.json.world.name, actors: m.json.world.actors.length, offers: m.json.world.offers.length, intent: { text: m.json.intent.text, quantity: m.json.intent.quantity, budget: money(m.json.intent.budget), deadline: m.json.intent.deadline, authority: m.json.intent.authority } });

  const an = curl('analyze', 'POST', `/api/markets/${market}/analyze`);
  record('analyze', an, { status: an.json.status, solver: an.json.solver, core: an.json.core && { summary: an.json.core.summary, minimal: an.json.core.minimal, proven: an.json.core.proven, method: an.json.core.method, constraints: an.json.core.constraints.map((c: any) => c.text) } });

  const inv = curl('invent', 'POST', `/api/markets/${market}/invent`);
  record('invent', inv, {
    interventions: inv.json.interventions.map((i: any) => ({ id: i.id, unlocks: i.unlocks, method: i.method, minimality: i.minimality, totalAfter: money(i.totalAfter), concessions: i.concessions.map((c: any) => ({ id: c.id, target: c.target, from: c.from, to: c.to, rationale: c.rationale })) })),
    coalitions: inv.json.coalitions.length, findings: inv.json.findings.map((f: any) => ({ claim: f.claim, verdict: f.verdict, kind: f.kind, text: f.text })),
  });

  const neg = curl('negotiate', 'POST', `/api/markets/${market}/negotiate`);
  if (neg.status !== 200) fail('negotiate', neg);
  record('negotiate', neg, {
    outcome: neg.json.outcome, queriesUsed: neg.json.queriesUsed, queryBudget: neg.json.queryBudget,
    messages: neg.json.messages.map((x: any) => ({ id: x.id, type: x.type, from: x.from, to: x.to, termsHash: x.termsHash })),
    decisions: neg.json.decisions.map((d: any) => ({ message: d.message, accept: d.accept, basis: d.basis, reason: d.reason, counter: d.counter ? { to: d.counter.to } : undefined })),
    accepted: neg.json.accepted.map((c: any) => ({ id: c.id, target: c.target, from: c.from, to: c.to })), unlockedBy: neg.json.unlockedBy, planId: neg.json.planId, total: money(neg.json.report?.plan?.total), verification: neg.json.verification?.ok,
  });
  const planId = neg.json.planId;

  const ver = curl('verify', 'POST', `/api/plans/${planId}/verify`, { market });
  record('verify', ver, { ok: ver.json.ok, checks: ver.json.checks.map((c: any) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}: ${c.text}`) });

  const com = curl('commit', 'POST', `/api/agreements/${planId}/commit`, { market });
  if (com.status !== 201) fail('commit', com);
  const agreement = com.json;
  record('commit', com, { id: agreement.id, state: agreement.state, version: agreement.version, termsHash: agreement.termsHash, acceptances: agreement.acceptances.map((a: any) => ({ actor: a.actor, basis: a.basis, signs: a.termsHash === agreement.termsHash })), obligations: agreement.obligations.map((o: any) => ({ id: o.id, actor: o.actor, offer: o.offer, qty: o.qty, start: o.start, due: o.due, amount: money(o.amount), state: o.state })) });

  const opts = curl('options discover', 'POST', `/api/markets/${market}/options/discover`);
  let bought: string[] = [];
  if (opts.status === 200) {
    record('options discover', opts, { risks: opts.json.risks?.map((r: any) => ({ obligation: r.obligation, pFail: r.pFail, label: r.label })), options: opts.json.options?.map((o: any) => ({ id: o.id, status: o.status, supplier: o.terms.supplier, offer: o.terms.offer, covers: o.terms.covers, qty: o.terms.qty, fee: money(o.terms.fee), strikeUnit: money(o.terms.strikeUnit), basis: o.basis, check: o.check?.ok })), declined: opts.json.declined?.map((d: any) => ({ actor: d.actor, reason: d.reason })) });
    const val = curl('options value', 'POST', `/api/markets/${market}/options/value`, { scenarios: 500 });
    record('options value', val, val.status === 200 ? { label: val.json.label, scenarios: val.json.scenarios, buy: val.json.buy, fees: money(val.json.fees), baselineExpectedLoss: money(val.json.baseline?.expected), withOptionsExpectedLoss: money(val.json.withOptions?.expected), options: val.json.options?.map((o: any) => ({ option: o.option, fee: money(o.fee), avoided: money(o.avoided), buy: o.buy, reason: o.reason })) } : val.json);
    const buy = curl('options buy', 'POST', `/api/markets/${market}/options/buy`, {});
    bought = buy.json?.purchased ?? [];
    record('options buy', buy, { purchased: bought });
  } else record('options discover', opts, opts.json);

  const payee = agreement.obligations[0].actor;
  const owed = agreement.obligations.filter((o: any) => o.actor === payee).reduce((a: number, o: any) => a + o.amount.minor, 0);
  const amount = { currency: agreement.obligations[0].amount.currency, minor: owed };
  const ap = curl('buyer approves payment', 'POST', `/api/agreements/${agreement.id}/approve-payment`, { market, payee, termsHash: agreement.termsHash, amount });
  if (ap.status !== 200) fail('buyer approves payment', ap);
  record('buyer approves payment (grants payment authority for this agreement version only)', ap, { payee, amount: money(ap.json.amount), obligations: ap.json.obligations, expiresAt: ap.json.expiresAt, approvalToken: '[redacted]' });

  const noToken = curl('order without approval', 'POST', '/api/payments/orders', { market, agreementId: agreement.id });
  record('order without approval (refused)', noToken, noToken.json);

  const ord = curl('create PayPal order', 'POST', '/api/payments/orders', { approvalToken: ap.json.approvalToken, market });
  if (ord.status !== 201) fail('create PayPal order', ord);
  const pi = ord.json;
  record('create PayPal order', ord, pay(pi));

  const early = curl('capture before buyer approval', 'POST', `/api/payments/${pi.id}/capture`);
  record('capture before buyer approval (refused)', early, early.json);

  let approved = false;
  if (process.env.PAYPAL_SANDBOX_BUYER_EMAIL && pi.paypal?.approveUrl) {
    const { approveWithSandboxBuyer } = await import('@framvera/paypal/sandbox-buyer');
    const started = Date.now();
    const a = await approveWithSandboxBuyer(pi.paypal.approveUrl);
    approved = a.completed;
    steps.push({ step: 'sandbox test buyer approves on PayPal checkout (test harness, headless browser)', status: a.completed ? 'completed' : 'failed', ms: Date.now() - started, result: { steps: a.steps, finalHost: a.finalHost } });
    console.log(`        sandbox buyer approval: ${a.completed}`);
  }

  const f1 = curl('independent fetch', 'GET', `/api/payments/${pi.id}`);
  record('independent fetch after approval', f1, pay(f1.json));

  if (approved) {
    const cap = curl('capture', 'POST', `/api/payments/${pi.id}/capture`);
    record('capture', cap, cap.status === 200 ? pay(cap.json) : cap.json);
    const f2 = curl('independent fetch', 'GET', `/api/payments/${pi.id}`);
    record('independent fetch after capture', f2, pay(f2.json));
  }

  const courier = agreement.obligations.find((o: any) => o.actor === 'a-lindqvist') ?? agreement.obligations.at(-1);
  const dis = curl('disrupt', 'POST', `/api/markets/${market}/disrupt`, { kind: 'withdraw', actor: courier.actor, offer: courier.offer, detail: 'Lindqvists Transport loses its Friday driver and withdraws from the shared van route.', at: '2026-11-18T12:00:00.000Z' });
  record('disrupt', dis, { disruption: dis.json.disruption, affected: dis.json.affected?.map((o: any) => o.id), atRisk: dis.json.atRisk?.map((o: any) => o.id), endangeredPayments: dis.json.endangeredPayments });

  if (opts.status === 200) {
    const ex = curl('exercise standby option', 'POST', `/api/markets/${market}/options/exercise`);
    record('exercise standby option', ex, ex.status === 200 ? { exercised: ex.json.exercised, absorbed: ex.json.absorbed, reason: ex.json.reason, attempts: ex.json.attempts, amendment: ex.json.amendment ? { version: ex.json.amendment.version, state: ex.json.amendment.state } : null } : ex.json);
  }

  const rec = curl('recover', 'POST', `/api/markets/${market}/recover`);
  record('recover', rec, rec.status === 200 ? {
    feasible: rec.json.feasible, kept: rec.json.kept, amended: rec.json.amended, cancelled: rec.json.cancelled, added: rec.json.added?.map((a: any) => ({ offer: a.offer, actor: a.actor, qty: a.qty, cost: money(a.cost) })),
    extraCost: money(rec.json.extraCost), slipHours: rec.json.slipHours, objective: rec.json.objective,
    rejected: rec.json.rejected?.map((r: any) => ({ description: r.description, reason: r.reason, extraCost: money(r.extraCost), slipHours: r.slipHours })),
    core: rec.json.core ? { summary: rec.json.core.summary, constraints: rec.json.core.constraints?.map((c: any) => c.text) } : null, negotiated: rec.json.negotiated ?? null,
  } : rec.json);

  if (rec.json?.feasible && rec.json?.amendment) {
    const rc = curl('commit recovery', 'POST', `/api/markets/${market}/recover/commit`, { termsHash: rec.json.amendment.termsHash });
    record('commit recovery', rc, rc.status === 200 ? { version: rc.json.agreement.version, state: rc.json.agreement.state, termsHash: rc.json.agreement.termsHash, obligations: rc.json.agreement.obligations.map((o: any) => ({ id: o.id, actor: o.actor, state: o.state, replaces: o.replaces })) } : rc.json);
  }

  const ev = curl('events', 'GET', `/api/markets/${market}/events?format=json`);
  const evs = ev.json.events as any[];
  const counts: Record<string, number> = {};
  for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
  record('events', ev, { total: evs.length, byType: counts, withCauses: evs.filter((e) => e.causes.length).length, sources: [...new Set(evs.map((e) => e.source))] });
  const tr = curl('trace payment', 'GET', `/api/markets/${market}/trace/${pi.id}`);
  record('trace payment', tr, tr.json?.events?.map((e: any) => ({ seq: e.seq, type: e.type, source: e.source, causes: e.causes.length, what: e.data?.type ?? e.data?.state ?? e.data?.status ?? '' })));
} catch (e) {
  steps.push({ step: 'halted', error: (e as Error).message.slice(0, 400) });
  console.error('halted:', (e as Error).message.slice(0, 300));
}

const text = JSON.stringify({ generatedAt: new Date().toISOString(), base: base.replace(/\/\/[^/]*@/, '//'), market, paypal: 'sandbox', steps }, null, 2);
assertNoSecrets(text);
writeFileSync(out, text);
console.log(`wrote ${out} (${steps.length} steps)`);
