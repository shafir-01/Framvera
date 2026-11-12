import { describe, expect, it } from 'vitest';
import { accept, acceptMessage, amend, cancelAgreement, commit, commitAgreement, missingAcceptances, proposeAgreement, reservations, sign, termsHashOf } from '../src/agreement.ts';
import { basePlan, committed, intent, world } from './fixture.ts';

describe('agreement state machine', () => {
  it('drafts deterministic terms', () => {
    const a = proposeAgreement(basePlan(), intent());
    const b = proposeAgreement(basePlan(), intent());
    expect(a.termsHash).toBe(b.termsHash);
    expect(a.termsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.parties).toEqual(['buyer', 'sP1', 'sA1', 'sD1']);
    expect(a.state).toBe('PROPOSED');
  });

  it('only parties may accept, only the exact terms hash, only on their own basis', () => {
    const a = proposeAgreement(basePlan(), intent());
    expect(() => accept(a, { actor: 'sP2', message: 'm', termsHash: a.termsHash, basis: 'synthetic-policy' })).toThrow(/not a party/);
    expect(() => accept(a, { actor: 'sP1', message: 'm', termsHash: 'beef', basis: 'synthetic-policy' })).toThrow(/different terms/);
    expect(() => accept(a, { actor: 'sP1', message: 'm', termsHash: a.termsHash, basis: 'buyer' })).toThrow(/basis/);
    expect(() => accept(a, { actor: 'buyer', message: 'm', termsHash: a.termsHash, basis: 'seller-terminal' })).toThrow(/basis/);
    expect(() => accept(a, { message: 'x', accept: true, basis: 'synthetic-policy', reason: 'ok' })).toThrow(/not acceptance/);
    const once = accept(a, acceptMessage(a, 'sP1', 'prop-1', '2026-11-16T00:00:00.000Z') as never);
    expect(() => accept(once, { ...acceptMessage(a, 'sP1', 'prop-1', '2026-11-16T00:00:00.000Z'), basis: 'synthetic-policy' })).not.toThrow();
    expect(() => accept(once, { actor: 'sP1', message: 'other', termsHash: a.termsHash, basis: 'synthetic-policy' })).toThrow(/already accepted/);
  });

  it('commits only when every party accepted', () => {
    const plan = basePlan();
    const a = proposeAgreement(plan, intent());
    const partial = commit(plan, intent(), [{ ...acceptMessage(a, 'buyer', 'b', a.createdAt), basis: 'buyer' }]);
    expect(partial.state).toBe('PROPOSED');
    expect(missingAcceptances(partial)).toEqual(['sP1', 'sA1', 'sD1']);
    expect(() => commitAgreement(partial)).toThrow(/Waiting for acceptance/);
    const decisionsOnly = commit(plan, intent(), [{ message: 'q1', accept: true, basis: 'synthetic-policy', reason: 'fits' }]);
    expect(decisionsOnly.state).toBe('PROPOSED');
    const { agreement } = committed();
    expect(agreement.state).toBe('COMMITTED');
    expect(agreement.obligations.every((o) => o.state === 'ACTIVE')).toBe(true);
  });

  it('refuses plans over budget, over authority or over capacity', () => {
    const plan = basePlan();
    expect(() => commit(plan, intent({ budget: { currency: 'SEK', minor: 100 } }))).toThrow(/budget/);
    const noReserve = intent();
    noReserve.authority = { ...noReserve.authority, mayReserve: false };
    expect(() => commit(plan, noReserve)).toThrow(/reserving/);
    expect(() => commit(plan, intent(), [], { world: world(), reserved: { oP1: 200 } })).toThrow(/capacity/);
  });

  it('amendments are new versions that need fresh consent; originals stay frozen', () => {
    const { agreement } = committed();
    Object.freeze(agreement);
    agreement.obligations.forEach((o) => Object.freeze(o));
    const ob = agreement.obligations[0]!;
    const v2 = amend(agreement, { keep: [agreement.obligations[1]!.id, agreement.obligations[2]!.id], replace: [{ replaces: ob.id, obligation: { ...ob, qty: 450 } }], add: [] });
    expect(v2.version).toBe(2);
    expect(v2.state).toBe('PROPOSED');
    expect(v2.acceptances).toEqual([]);
    expect(v2.termsHash).not.toBe(agreement.termsHash);
    expect(v2.obligations.find((o) => o.replaces === ob.id)!.qty).toBe(450);
    expect(termsHashOf(agreement)).toBe(agreement.termsHash);
    expect(() => amend(proposeAgreement(basePlan(), intent()), { keep: [], replace: [], add: [] })).toThrow(/committed/);
  });

  it('cancelling a committed agreement needs every party', () => {
    const { agreement } = committed();
    expect(() => cancelAgreement(agreement, ['buyer'])).toThrow(/consent/);
    const c = cancelAgreement(agreement, agreement.parties);
    expect(c.state).toBe('CANCELLED');
    expect(c.obligations.every((o) => o.state === 'CANCELLED')).toBe(true);
    expect(reservations([c]).size).toBe(0);
    expect(reservations([agreement]).get('oP1')).toBe(500);
  });
});

describe('sign', () => {
  it('synthetic suppliers sign terms their published offers already cover', () => {
    const a = proposeAgreement(basePlan(), intent());
    const r = sign(a, world(), undefined, { at: '2026-11-16T00:00:00.000Z' });
    expect(r.declined).toEqual([]);
    expect(r.accepts.map((m) => m.from)).toEqual(['buyer', 'sP1', 'sA1', 'sD1']);
    expect(r.accepts.every((m) => m.termsHash === a.termsHash)).toBe(true);
    expect(r.agreement.state).toBe('COMMITTED');
  });

  it('leaves terminal sellers and off-offer terms unsigned', () => {
    const w = world();
    w.offers = w.offers.map((o) => (o.id === 'oA1' ? { ...o, provenance: { ...o.provenance, source: 'seller-terminal' as const } } : o));
    const plan = basePlan();
    plan.allocations[2] = { ...plan.allocations[2]!, cost: { currency: 'SEK', minor: 1 } };
    const r = sign(proposeAgreement(plan, intent()), w);
    expect(r.agreement.state).toBe('PROPOSED');
    expect(r.declined).toEqual([
      { actor: 'sA1', reason: 'waiting for the seller to accept' },
      { actor: 'sD1', reason: 'below the published price' },
    ]);
  });
});
