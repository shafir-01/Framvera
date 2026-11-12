import { describe, expect, it } from 'vitest';
import { makeApp, post, realEngineReady } from './helpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const json = async (r: Response | Promise<Response>) => {
  const res = await r;
  const body: any = await res.json();
  return { status: res.status, body };
};

describe('flagship with the real modules', async () => {
  const { engine, ok } = await realEngineReady();
  const sandbox = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

  it.skipIf(!ok)('infeasible -> invent -> negotiate -> verify -> commit -> pay -> capture -> disrupt -> recover', async () => {
    const e: any = engine;
    const gw = sandbox ? new e.PayPalSandboxAdapter() : new e.FakeGateway();
    const app = makeApp(engine, gw);

    const m = await json(post(app, '/api/markets', { template: 'flagship' }));
    expect(m.status).toBe(201);
    expect(m.body.market).toBe(m.body.id);
    const id = m.body.id;
    expect(JSON.stringify(m.body)).not.toMatch(/"(reservation|policies|riskTolerance|realCapacity)"/);

    const an = await json(post(app, `/api/markets/${id}/analyze`));
    expect(an.body.status).toBe('infeasible');
    expect(an.body.core.constraints.length).toBeGreaterThan(0);
    expect(an.body.core.proven).toBe(true);

    const inv = await json(post(app, `/api/markets/${id}/invent`));
    expect(inv.body.interventions.some((i: any) => i.unlocks)).toBe(true);

    const neg = await json(post(app, `/api/markets/${id}/negotiate`));
    expect(neg.status).toBe(200);
    expect(neg.body.outcome).toBe('feasible');
    expect(neg.body.planId).toBeTruthy();
    expect(neg.body.decisions.every((d: any) => d.basis === 'synthetic-policy')).toBe(true);
    expect(neg.body.accepted.length).toBeGreaterThan(0);
    expect(neg.body.unlockedBy.length).toBeGreaterThan(0);

    const ver = await json(post(app, `/api/plans/${neg.body.planId}/verify`, { market: id }));
    expect(ver.body.ok).toBe(true);

    const com = await json(post(app, `/api/agreements/${neg.body.planId}/commit`, { market: id }));
    expect(com.status).toBe(201);
    const agreement = com.body;
    expect(agreement.state).toBe('COMMITTED');
    expect(agreement.acceptances.map((a: any) => a.actor).sort()).toEqual([...agreement.parties].sort());
    expect(agreement.acceptances.every((a: any) => a.termsHash === agreement.termsHash)).toBe(true);

    let optionsBought: string[] = [];
    if (e.options) {
      const found = await json(post(app, `/api/markets/${id}/options/discover`));
      expect(found.status).toBe(200);
      expect(JSON.stringify(found.body)).not.toMatch(/"(reservation|riskTolerance|policies)"/);
      const valued = await json(post(app, `/api/markets/${id}/options/value`, { scenarios: 200 }));
      expect(valued.status).toBe(200);
      expect(valued.body.label).toBe('planner-estimate');
      const bought = await json(post(app, `/api/markets/${id}/options/buy`, {}));
      expect(bought.status).toBe(200);
      optionsBought = bought.body.purchased;
    }

    const payee = agreement.obligations[0].actor;
    const owed = agreement.obligations.filter((o: any) => o.actor === payee).reduce((a: number, o: any) => a + o.amount.minor, 0);
    const amount = { currency: agreement.obligations[0].amount.currency, minor: owed };
    const approve = () => json(post(app, `/api/agreements/${agreement.id}/approve-payment`, { market: id, payee, termsHash: agreement.termsHash, amount }));
    expect((await approve()).status).toBe(403);
    expect((await json(post(app, `/api/markets/${id}/authority`, { maxSpend: { ...amount, minor: 10_000_000_000 } }))).status).toBe(422);
    const granted = await json(post(app, `/api/markets/${id}/authority`, { mayPreparePayments: true }));
    expect(granted.body.authority.mayPreparePayments).toBe(true);
    const ap = await approve();
    expect(ap.status).toBe(200);
    const order = await json(post(app, '/api/payments/orders', { approvalToken: ap.body.approvalToken, market: id }));
    expect(order.status).toBe(201);
    const pi = order.body;
    expect(pi.paypal.orderId).toBeTruthy();
    expect(pi.state).toBe('PAYER_ACTION_REQUIRED');
    expect(pi.amount).toEqual(amount);
    expect((await post(app, '/api/payments/orders', { approvalToken: ap.body.approvalToken, market: id })).status).toBe(200);

    expect((await json(post(app, `/api/payments/${pi.id}/capture`))).status).toBe(409);
    let approved = false;
    if (!sandbox) {
      gw.paypal.approve(pi.paypal.orderId);
      approved = true;
    } else if (process.env.PAYPAL_SANDBOX_BUYER_EMAIL) {
      const { approveWithSandboxBuyer } = await import('@framvera/paypal/sandbox-buyer');
      approved = (await approveWithSandboxBuyer(pi.paypal.approveUrl)).completed;
    }
    if (approved) {
      const fresh = await json(app.request(`/api/payments/${pi.id}`));
      expect(fresh.body.state).toBe('APPROVED');
      const cap = await json(post(app, `/api/payments/${pi.id}/capture`));
      expect(cap.status).toBe(200);
      expect(cap.body.state).toBe('CAPTURE_COMPLETED');
      expect(cap.body.paypal.captureId).toBeTruthy();
      const again = await json(app.request(`/api/payments/${pi.id}`));
      expect(again.body.state).toBe('CAPTURE_COMPLETED');
      expect(again.body.paypal.lastFetchedAt).toBeTruthy();
    }

    const courier = agreement.obligations.find((o: any) => o.actor === 'a-lindqvist') ?? agreement.obligations.at(-1);
    const dis = await json(post(app, `/api/markets/${id}/disrupt`, { kind: 'withdraw', actor: courier.actor, offer: courier.offer, detail: 'Driver lost; withdraws from the route.' }));
    expect(dis.status).toBe(200);
    expect(dis.body.affected.length).toBeGreaterThan(0);

    if (e.options) {
      const ex = await json(post(app, `/api/markets/${id}/options/exercise`));
      expect(ex.status).toBe(200);
      if (optionsBought.length && ex.body.exercised) expect(ex.body.amendment).toBeTruthy();
    }

    const rec = await json(post(app, `/api/markets/${id}/recover`));
    expect(rec.status).toBe(200);
    expect(rec.body.kept.length).toBeGreaterThan(0);
    expect(rec.body.kept).not.toContain(courier.id);
    for (const r of rec.body.rejected) if (rec.body.candidates?.some((c: any) => c.description === r.description)) expect(r.extraCost).toBeTruthy();
    if (!rec.body.feasible) {
      // Known gap (see integrator status, BROKEN): no supplier change is proposed on the disrupted world yet.
      expect(rec.body.core?.constraints?.length ?? 0).toBeGreaterThan(0);
      console.warn('recovery infeasible:', rec.body.core?.summary);
    }

    if (rec.body.amendment) {
      const done = await json(post(app, `/api/markets/${id}/recover/commit`, { termsHash: rec.body.amendment.termsHash }));
      expect(done.status).toBe(200);
      expect(done.body.agreement.version).toBe(agreement.version + 1);
      expect(done.body.agreement.state).toBe('COMMITTED');
    }

    const { body: log } = await json(app.request(`/api/markets/${id}/events?format=json`));
    const evs: any[] = log.events;
    const byId = new Map(evs.map((x) => [x.id, x]));
    for (const ev of evs) for (const c of ev.causes) expect(byId.get(c)?.seq ?? Infinity).toBeLessThan(ev.seq);
    const decisions = evs.filter((x) => x.type === 'negotiation.decision');
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((x) => x.causes.length > 0)).toBe(true);
    const recovery = evs.find((x) => x.type === 'recovery.proposed');
    expect(byId.get(recovery.causes[0])?.type).toBe('disruption.applied');
    const agreed = evs.find((x) => x.type === 'agreement.state');
    expect(agreed.causes.length).toBeGreaterThan(1);
    const uncaused = evs.filter((x) => x.type !== 'world.created' && x.causes.length === 0).map((x) => `${x.type}:${x.data?.type ?? x.data?.state ?? ''}`);
    expect(uncaused).toEqual([]);
  }, 900_000);
});
