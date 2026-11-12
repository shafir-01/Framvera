import { describe, expect, it } from 'vitest';
import { makeApp, post, stubEngine } from './helpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (h: number) => new Date(Date.UTC(2026, 10, 20, h)).toISOString();
const sek = (minor: number) => ({ currency: 'SEK', minor });

function engine() {
  const e: any = stubEngine();
  const world = (v = 1) => ({
    id: 'w1', version: v, seed: 1, name: 'Kits', currency: 'SEK', family: 'flagship', createdAt: iso(0), claims: [],
    stages: [{ id: 's', name: 'Print', unit: 'kits', after: [], perOutcome: 1 }],
    actors: [
      { id: 'a1', name: 'Print AB', kind: 'supplier', city: 'Solna', description: '', active: true },
      { id: 'a2', name: 'Pack AB', kind: 'supplier', city: 'Kista', description: '', active: true },
    ],
    offers: [
      { id: 'o1', version: 1, actor: 'a1', stage: 's', capacity: 600, minQty: 100, ratePerHour: 50, setupFee: sek(100000), tiers: [{ minQty: 0, unit: sek(6000) }], window: { start: iso(6), end: iso(16) }, handoffHours: 1, validUntil: iso(23), negotiable: ['unitPrice'], provenance: { source: 'synthetic-market', observedAt: iso(0) }, claims: [] },
      { id: 'o2', version: 1, actor: 'a2', stage: 's', capacity: 900, minQty: 50, ratePerHour: 80, setupFee: sek(0), tiers: [{ minQty: 0, unit: sek(5000) }], window: { start: iso(6), end: iso(18) }, handoffHours: 1, validUntil: iso(23), negotiable: ['unitPrice'], provenance: { source: 'synthetic-market', observedAt: iso(0) }, claims: [] },
    ],
  });
  const base = e.flagshipWorld();
  const truth = { policies: { a1: { reservation: { unitPrice: 5200 } }, a2: { reservation: { unitPrice: 4500 } } } };
  e.flagshipWorld = () => ({ world: world(), intent: base.intent, truth });
  e.generateWorld = e.flagshipWorld;
  e.negotiate = async (w: any, _i: any, _t: any, opts: any) => {
    const concession = { id: 'c1', target: { kind: 'offer', offer: 'o1', field: 'unitPrice' }, from: 6000, to: 5000, estimate: sek(500000), rationale: 'Unlocks the order.' };
    const msg = { type: 'Propose', id: `m-${w.version}`, from: 'framvera', to: 'a1', concession, expires: iso(23), at: iso(1) };
    const d = opts.terminal?.(msg) ?? { message: msg.id, accept: true, basis: 'synthetic-policy', reason: 'ok' };
    return {
      world: { ...w, version: w.version + 1 }, messages: [msg], decisions: [{ ...d, message: msg.id }],
      plan: { id: 'p1', worldVersion: 2, intent: 'i1', allocations: [], total: sek(5430000), readyAt: iso(17), objective: 'cost' },
    };
  };
  return e;
}

async function setup() {
  const app = makeApp(engine());
  const m: any = await (await post(app, '/api/markets', {})).json();
  const mint = async (actor: string) => (await (await post(app, `/api/markets/${m.id}/seats`, { actor })).json()) as any;
  const redeem = (actor: string, token: string) => post(app, `/api/markets/${m.id}/seller/${actor}/seat`, { token });
  const seat = async (actor: string) => {
    const t = await mint(actor);
    const r: any = await (await redeem(actor, t.token)).json();
    return r.session as string;
  };
  const view = async (actor: string, session: string) => (await (await post(app, `/api/markets/${m.id}/seller/${actor}/view`, { session })).json()) as any;
  const answer = (actor: string, session: string, data: any) => post(app, `/api/markets/${m.id}/seller/${actor}/answer`, { session, ...data });
  const events = async () => {
    const r = await app.request(`/api/markets/${m.id}/events`);
    const reader = r.body!.getReader();
    let text = '';
    const dec = new TextDecoder();
    for (;;) {
      const { value } = await reader.read();
      text += dec.decode(value);
      if (text.includes('event: ready')) break;
    }
    await reader.cancel();
    return text;
  };
  return { app, m, mint, redeem, seat, view, answer, events };
}

describe('seller terminal', () => {
  it('without a seat the synthetic policy answers as before', async () => {
    const { app, m } = await setup();
    const r: any = await (await post(app, `/api/markets/${m.id}/negotiate`)).json();
    expect(r.decisions[0].basis).toBe('synthetic-policy');
  });

  it('an unseated actor cannot answer', async () => {
    const { app, m, answer, seat, mint } = await setup();
    expect((await answer('a1', 'nope', { action: 'accept', termsHash: 'x' })).status).toBe(401);
    const t = await mint('a1');
    expect((await answer('a1', t.token, { action: 'accept', termsHash: 'x' })).status).toBe(401);
    const session = await seat('a1');
    await post(app, `/api/markets/${m.id}/seats/release`, { actor: 'a1' });
    expect((await answer('a1', session, { action: 'accept', termsHash: 'x' })).status).toBe(403);
  });

  it('a seat token for actor A cannot answer for B or redeem as B', async () => {
    const { answer, seat, redeem, mint, view } = await setup();
    const tokenA = await mint('a1');
    expect((await redeem('a2', tokenA.token)).status).toBe(403);
    const sessionA = await seat('a1');
    await seat('a2');
    expect((await answer('a2', sessionA, { action: 'accept', termsHash: 'x' })).status).toBe(403);
    expect((await view('a2', sessionA)).error.code).toBe('wrong_seat');
  });

  it('a seat link is single use', async () => {
    const { mint, redeem } = await setup();
    const t = await mint('a1');
    expect((await redeem('a1', t.token)).status).toBe(201);
    expect((await redeem('a1', t.token)).status).toBe(409);
  });

  it('the seller sees only their own offer, with the benefit statement and co-pilot', async () => {
    const { app, m, seat, view } = await setup();
    const session = await seat('a1');
    expect((await post(app, `/api/markets/${m.id}/negotiate`)).status).toBe(202);
    const v = await view('a1', session);
    expect(v.offers.map((o: any) => o.id)).toEqual(['o1']);
    expect(JSON.stringify(v)).not.toContain('Pack AB');
    expect(v.pending).toHaveLength(1);
    expect(v.pending[0].benefit).toContain('Unlocks the order');
    expect(v.pending[0].copilot.lines.some((l: any) => l.label.startsWith('Revenue'))).toBe(true);
    expect(v.pending[0].copilot.notes.join(' ')).toContain('below your own floor');
  });

  it('accept with a stale termsHash is refused; the current hash is accepted and delivered over SSE', async () => {
    const { app, m, seat, view, answer, events } = await setup();
    const session = await seat('a1');
    await post(app, `/api/markets/${m.id}/negotiate`);
    const p = (await view('a1', session)).pending[0];
    const stale = await answer('a1', session, { action: 'accept', termsHash: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error.code).toBe('terms_changed');
    const ok = await answer('a1', session, { action: 'accept', termsHash: p.termsHash });
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.decision.basis).toBe('seller-terminal');
    expect(body.resumed.planId).toBe('p1');
    expect((await answer('a1', session, { action: 'accept', termsHash: p.termsHash })).status).toBe(409);
    const sse = await events();
    expect(sse).toContain('event: negotiation.decision');
    expect(sse).toContain('answered by a person at the seller terminal');
    expect(sse).toContain('"source":"seller-terminal"');
  });

  it('a counter becomes a typed concession', async () => {
    const { app, m, seat, view, answer } = await setup();
    const session = await seat('a1');
    await post(app, `/api/markets/${m.id}/negotiate`);
    const p = (await view('a1', session)).pending[0];
    expect((await answer('a1', session, { action: 'counter', termsHash: p.termsHash, counter: { to: 'abc' } })).status).toBe(422);
    const c: any = await (await answer('a1', session, { action: 'counter', termsHash: p.termsHash, counter: { to: 5400 } })).json();
    expect(c.decision.counter.to).toBe(5400);
    expect(c.decision.accept).toBe(false);
  });

  it('withdraw triggers a real disruption', async () => {
    const { app, m, seat, answer, view, events } = await setup();
    const session = await seat('a1');
    expect((await post(app, `/api/markets/${m.id}/seller/a1/withdraw`, { session })).status).toBe(409);
    await post(app, `/api/markets/${m.id}/negotiate`);
    const p = (await view('a1', session)).pending[0];
    await answer('a1', session, { action: 'accept', termsHash: p.termsHash });
    await post(app, '/api/plans/p1/verify', { market: m.id });
    await post(app, '/api/agreements/p1/commit', { market: m.id });
    const w = await post(app, `/api/markets/${m.id}/seller/a1/withdraw`, { session, reason: 'Machine down' });
    expect(w.status).toBe(200);
    expect(((await w.json()) as any).disruption.kind).toBe('withdraw');
    expect((await post(app, `/api/markets/${m.id}/seller/a1/withdraw`, { session })).status).toBe(409);
    expect(await events()).toContain('event: disruption.applied');
  });
});
