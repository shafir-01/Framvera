import { describe, expect, it } from 'vitest';
import { buildBundle, redact } from './bundle.ts';
import { buildTrace, derivedConcessions, paypalDivergence } from './chain.ts';
import { fixtureDossier, fixtureEvents } from './dev/fixture.ts';

const d = fixtureDossier();
const events = fixtureEvents();
const keys = (nodes: { key: string }[]) => nodes.map((n) => n.key);

describe('backward chain from a PayPal record', () => {
  it('reaches the objective through every link, in order', () => {
    const t = buildTrace(d, events);
    expect(t.entity).toMatchObject({ kind: 'payment', id: 'pi_1' });
    expect(keys(t.backward)).toEqual(['paypal', 'payment', 'obligations', 'agreement', 'acceptances', 'changes', 'solver', 'objective']);
  });

  it('resolves an order id, a capture id or a refund id to the same payment', () => {
    const p = d.payments[0]!;
    for (const id of [p.paypal.orderId!, p.paypal.captureId!, p.operationKey]) expect(buildTrace(d, events, id).entity?.id).toBe(p.id);
  });

  it('shows PayPal ids, the verbatim status and the fetch time', () => {
    const n = buildTrace(d, events).backward[0]!;
    expect(n.source).toBe('paypal-sandbox');
    expect(n.ids.map((i) => i.value)).toContain('FIXTURE-CAPTURE');
    expect(n.facts.find((f) => f.label === 'PayPal status')?.value).toBe('COMPLETED');
    expect(n.title).toMatch(/Sandbox/);
  });

  it('names the accepted changes the plan relies on and nothing else', () => {
    const t = buildTrace(d, events);
    expect(derivedConcessions(d, d.plans[0]).sort()).toEqual(['cn_arsta_joint', 'cn_kista_window']);
    expect(t.headline?.changes.map((c) => c.id).sort()).toEqual(['cn_arsta_joint', 'cn_kista_window']);
    const changes = t.backward.find((n) => n.key === 'changes')!;
    expect(changes.items[0]!.facts?.some((f) => f.label === 'Propose')).toBe(true);
    expect(changes.items[0]!.facts?.some((f) => f.estimate)).toBe(true);
  });

  it('labels each acceptance with its basis and checks the signed hash', () => {
    const acc = buildTrace(d, events).backward.find((n) => n.key === 'acceptances')!;
    expect(acc.items.map((i) => i.source)).toContain('buyer');
    expect(acc.items.map((i) => i.source)).toContain('supplier-policy');
    expect(acc.items.every((i) => i.facts?.find((f) => f.label === 'Signed the agreement hash')?.value === 'Yes')).toBe(true);
    const bad = { ...d, agreement: { ...d.agreement!, acceptances: [{ ...d.agreement!.acceptances[1]!, termsHash: 'deadbeef' }] } };
    const t = buildTrace(bad, events).backward.find((n) => n.key === 'acceptances')!;
    expect(t.items[0]!.facts?.find((f) => f.label === 'Signed the agreement hash')?.tone).toBe('bad');
  });

  it('shows the solver report before and after, with status and objective', () => {
    const s = buildTrace(d, events).backward.find((n) => n.key === 'solver')!;
    expect(s.items.map((i) => i.title)).toEqual(['Before the accepted changes', 'After the accepted changes', 'Independent re-check']);
    expect(s.items[0]!.meta).toBe('infeasible');
    expect(s.items[1]!.facts?.find((f) => f.label === 'Objective')?.value).toMatch(/cost/i);
  });

  it('flags a ledger and PayPal disagreement', () => {
    const p = { ...d.payments[0]!, paypal: { ...d.payments[0]!.paypal, status: 'PENDING' } };
    expect(paypalDivergence(p)).toMatch(/PENDING/);
    expect(paypalDivergence(d.payments[0]!)).toBeUndefined();
    const t = buildTrace({ ...d, payments: [p] }, events).backward[0]!;
    expect(t.facts.find((f) => f.label === 'Reconcile')?.tone).toBe('bad');
  });

  it('says plainly when nothing has gone to PayPal', () => {
    const p = { ...d.payments[0]!, state: 'PAYMENT_PROPOSED' as const, paypal: { env: 'sandbox' as const, refunds: [], debugIds: [] } };
    const n = buildTrace({ ...d, payments: [p] }, events).backward[0]!;
    expect(n.title).toBe('Nothing sent to PayPal yet');
    expect(n.facts.find((f) => f.label === 'Fetched from PayPal')?.value).toMatch(/Not fetched/);
  });

  it('reports an unknown entity as not found', () => {
    expect(buildTrace(d, events, 'nope').notFound).toBe(true);
  });
});

describe('forward chain from a failure', () => {
  it('follows a withdrawn supplier to obligations and payments', () => {
    const t = buildTrace(d, events, 'dr_1');
    expect(t.entity?.kind).toBe('disruption');
    expect(keys(t.forward)).toEqual(['disruption:dr_1', 'offers', 'obligations', 'payments', 'recovery']);
    expect(t.forward[2]!.items.map((i) => i.facts?.[0]?.value)).toContain('ob_3');
    expect(t.forward[3]!.items[0]!.follow).toBe('pi_1');
  });

  it('follows a contradicted claim to the offer, obligation and payment that rest on it', () => {
    const t = buildTrace(d, events, 'cl_kista_capacity');
    expect(t.forward[0]!.tone).toBe('broken');
    expect(t.forward.find((n) => n.key === 'obligations')!.items.map((i) => i.facts?.[0]?.value)).toEqual(['ob_2']);
    expect(t.forward.find((n) => n.key === 'payments')!.items).toHaveLength(1);
  });

  it('lists failed or contradicted entities as starting points', () => {
    const groups = buildTrace(d, events).candidates.map((c) => `${c.group}:${c.id}`);
    expect(groups).toContain('Failed or contradicted:dr_1');
    expect(groups).toContain('Failed or contradicted:cl_kista_capacity');
    expect(groups).toContain('Payments:pi_1');
  });

  it('says so when no committed obligation depends on the failure', () => {
    const t = buildTrace(d, events, 'a_soder');
    expect(t.forward.at(-1)!.title).not.toMatch(/No committed/);
    const none = buildTrace({ ...d, agreement: null }, events, 'a_soder');
    expect(none.forward.at(-1)!.title).toBe('Nothing is committed yet');
  });
});

describe('audit bundle', () => {
  const t = buildTrace(d, events);
  const ledger = events.filter((e) => e.type === 'payment.state');

  it('contains the whole chain and its ledger events', () => {
    const b = buildBundle(d, t, events, ledger, '2026-11-12T14:00:00.000Z');
    expect(b.format).toBe('framvera.audit-bundle');
    expect(b.chain.map((c) => c.node.key)).toEqual(keys(t.backward));
    expect(b.events.length).toBeGreaterThan(5);
    expect(b.environment.payments).toBe('PayPal Sandbox');
  });

  it('redacts credentials, links, debug ids, contact details and supplier free text', () => {
    const dirty = {
      ...d,
      payments: [{ ...d.payments[0]!, paypal: { ...d.payments[0]!.paypal, approveUrl: 'https://sandbox.paypal.com/x', debugIds: ['abc123'] } }],
    };
    const dirtyEvents = [...events, { ...events[0]!, id: 'ev_x', seq: 999, data: { access_token: 'A21secret', note: 'Bearer abc.def-ghi ping a.b@example.com', approvalToken: 'tok' } }];
    const b = buildBundle(dirty, t, dirtyEvents, [dirtyEvents.at(-1)!]);
    const text = JSON.stringify(b);
    for (const leak of ['sandbox.paypal.com/x', 'abc123', 'A21secret', 'abc.def-ghi', 'a.b@example.com', '"tok"', 'SYSTEM NOTE']) expect(text).not.toContain(leak);
    expect(text).toContain('FIXTURE-CAPTURE');
  });

  it('keeps numbers and booleans while masking sensitive strings', () => {
    expect(redact({ token: 'x', count: 3, approval: true })).toEqual({ token: '[redacted]', count: 3, approval: true });
  });
});
