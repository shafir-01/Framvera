import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { amend, commitAgreement, accept, moveObligation, supersede } from '../src/agreement.ts';
import { Ledger, record } from '../src/ledger.ts';
import { committed, payment } from './fixture.ts';

const M = 'm1';

describe('Ledger', () => {
  it('appends with per-market sequence numbers and idempotent ids', () => {
    const l = new Ledger();
    const a = l.append({ id: 'e1', market: M, type: 'world.created', data: { w: 1 }, at: '2026-11-16T00:00:00.000Z' });
    const b = l.append({ id: 'e2', market: M, type: 'intent.compiled', data: {}, causes: ['e1'] });
    const other = l.append({ id: 'x1', market: 'm2', type: 'world.created', data: {} });
    expect([a.seq, b.seq, other.seq]).toEqual([1, 2, 1]);
    expect(l.append({ id: 'e1', market: M, type: 'world.created', data: { w: 1 }, at: 'ignored' })).toEqual(a);
    expect(() => l.append({ id: 'e1', market: M, type: 'world.created', data: { w: 2 } })).toThrow(/different content/);
    expect(() => l.append({ id: 'e3', market: M, type: 'solve.completed', data: {}, causes: ['nope'] })).toThrow(/not in the ledger/);
    expect(l.events(M).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(l.verifyChain(M)).toMatchObject({ ok: true, seq: 2 });
  });

  it('refuses updates and deletes at the storage level', () => {
    const l = new Ledger();
    l.append({ id: 'e1', market: M, type: 'world.created', data: {} });
    const db = (l as unknown as { db: { exec(s: string): void } }).db;
    expect(() => db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(l.events(M)).toHaveLength(1);
  });

  it('uses WAL on a file database and survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'framvera-ledger-'));
    const path = join(dir, 'ledger.db');
    const l = new Ledger(path);
    expect(l.journal).toBe('wal');
    const { agreement } = committed();
    record.agreement(l, M, agreement);
    l.snapshot(M);
    l.close();
    const again = new Ledger(path);
    expect(again.state(M).agreements[agreement.id]!.state).toBe('COMMITTED');
    expect(again.verifyChain(M).ok).toBe(true);
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replays agreement and payment state at any sequence number', () => {
    const l = new Ledger();
    const { agreement } = committed();
    const e1 = record.agreement(l, M, agreement);
    const pay = payment(agreement, 'sP1', 'PAYMENT_PROPOSED');
    const e2 = record.payment(l, M, pay, [e1.id]);
    l.snapshot(M);
    const created = { ...pay, state: 'ORDER_CREATED' as const, paypal: { ...pay.paypal, orderId: 'O-1' } };
    record.payment(l, M, created, [e2.id]);
    const ob = moveObligation(agreement.obligations[0]!, 'AT_RISK');
    record.obligation(l, M, ob, [e1.id], 'supplier withdrew');
    expect(l.stateAt(M, 1).payments).toEqual({});
    expect(l.stateAt(M, 2).payments[pay.id]!.state).toBe('PAYMENT_PROPOSED');
    expect(l.stateAt(M, 3).payments[pay.id]!.state).toBe('ORDER_CREATED');
    expect(l.stateAt(M, 3).obligations[ob.id]!.state).toBe('ACTIVE');
    expect(l.stateAt(M).obligations[ob.id]!.state).toBe('AT_RISK');
    expect(l.stateAt(M).reservations).toEqual({ oP1: 500, oA1: 500, oD1: 500 });
    expect(l.stateAt(M, 4)).toEqual(l.state(M));
  });

  it('keeps original terms immutable and allows amendments only as new versions', () => {
    const l = new Ledger();
    const { agreement } = committed();
    record.agreement(l, M, agreement);
    const tampered = { ...agreement, termsHash: 'f'.repeat(64) };
    expect(() => record.agreement(l, M, { ...tampered, state: 'FULFILLING' })).toThrow(/immutable/);
    const ob = agreement.obligations[0]!;
    expect(() => record.obligation(l, M, { ...ob, qty: 1, state: 'AT_RISK' })).toThrow(/immutable/);
    let v2 = amend(agreement, { keep: agreement.obligations.slice(1).map((o) => o.id), replace: [{ replaces: ob.id, obligation: { ...ob, qty: 450 } }], add: [] });
    for (const p of v2.parties) v2 = accept(v2, { actor: p, message: `a2-${p}`, termsHash: v2.termsHash, basis: p === 'buyer' ? 'buyer' : 'seller-terminal' });
    v2 = commitAgreement(v2);
    record.agreement(l, M, v2);
    record.agreement(l, M, supersede(agreement, v2));
    const s = l.state(M);
    expect(s.history[agreement.id]!.map((a) => [a.version, a.state])).toEqual([
      [1, 'AMENDED'],
      [2, 'COMMITTED'],
    ]);
    expect(s.history[agreement.id]![0]!.termsHash).toBe(agreement.termsHash);
    expect(() => record.agreement(l, M, { ...v2, version: 4 })).toThrow(/does not follow/);
  });

  it('rejects a second capture and refunds above the capture at storage level', () => {
    const l = new Ledger();
    const { agreement } = committed();
    const pay = payment(agreement, 'sP1', 'CAPTURE_COMPLETED');
    record.payment(l, M, pay);
    expect(() => record.payment(l, M, { ...pay, paypal: { ...pay.paypal, captureId: 'CAP2' } })).toThrow(/already has capture/);
    const over = { ...pay, state: 'REFUND_COMPLETED' as const, paypal: { ...pay.paypal, refunds: [{ id: 'R1', amount: { currency: 'SEK' as const, minor: pay.charged.minor + 1 }, status: 'COMPLETED' }] } };
    expect(() => record.payment(l, M, over)).toThrow(/exceed/);
  });

  it('branches never write to the ledger', () => {
    const l = new Ledger();
    const { agreement } = committed();
    record.agreement(l, M, agreement);
    const before = l.events(M);
    const b = l.branch(M);
    const ob = moveObligation(agreement.obligations[0]!, 'BREACHED');
    record.obligation(b, M, ob);
    expect(b.state().obligations[ob.id]!.state).toBe('BREACHED');
    expect(b.events()).toHaveLength(2);
    expect(l.events(M)).toEqual(before);
    expect(l.state(M).obligations[ob.id]!.state).toBe('ACTIVE');
  });
});

describe('ledger timeline of a disruption and recovery', () => {
  it('replays commit, disruption and the committed recovery step by step', async () => {
    const { recover, commitRecovery } = await import('../src/recover.ts');
    const { disrupt } = await import('../src/disrupt.ts');
    const { world, intent, T } = await import('./fixture.ts');
    const l = new Ledger();
    const { agreement } = committed();
    const c = record.agreement(l, M, agreement);
    const d = { id: 'd1', kind: 'withdraw' as const, actor: 'sP1', detail: 'Söder Print withdraws', at: T('16T06:00') };
    const impact = disrupt(agreement, world(), d);
    const evs = record.impact(l, M, d, impact, [c.id]);
    expect(l.state(M).obligations[agreement.obligations[0]!.id]!.state).toBe('BREACHED');
    expect(l.state(M).obligations[agreement.obligations[1]!.id]!.state).toBe('AT_RISK');
    const r = await recover(agreement, world(), intent(), d, { solver: null });
    record.recovery(l, M, r, false, [evs[0]!.id]);
    const next = r.amendment!;
    const signs = next.parties.map((p) => ({ actor: p, message: `r-${p}`, termsHash: next.termsHash, basis: p === 'buyer' ? ('buyer' as const) : ('seller-terminal' as const) }));
    const done = commitRecovery(agreement, r, signs, { current: l.state(M).obligations });
    record.recoveryCommit(l, M, r, done, [evs[0]!.id]);
    const end = l.state(M);
    expect(end.agreements[agreement.id]!.version).toBe(2);
    expect(end.history[agreement.id]!.map((a) => a.state)).toEqual(['AMENDED', 'COMMITTED']);
    expect(end.obligations[agreement.obligations[1]!.id]!.state).toBe('ACTIVE');
    expect(end.reservations).toEqual({ oA1: 500, oD1: 500, oP2: 500 });
    expect(end.recoveries).toHaveLength(1);
    expect(end.recoveries[0]!.committed).toBe(true);
    expect('world' in end.recoveries[0]!.recovery).toBe(false);
    expect(l.stateAt(M, 1).reservations).toEqual({ oP1: 500, oA1: 500, oD1: 500 });
    expect(l.verifyChain(M).ok).toBe(true);
  });
});
