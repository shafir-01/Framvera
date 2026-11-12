import { toMarket } from '../src/observatory/types.ts';
import { describe, expect, it } from 'vitest';
import { devProps } from '../src/observatory/dev/fixture.ts';
import { buildClaimRows, buildCoalitionRows, buildOfferRows, buildPaymentRows, buildQuestionRows, groupOfferRows, indexMarket, offerDetail, priceAt } from '../src/observatory/model.ts';

const now = Date.parse('2026-11-12T12:00:00Z');
const ix = indexMarket(toMarket({ ...devProps, api: {} as never }));
const rows = buildOfferRows(ix, now);
const byId = (id: string) => rows.find((r) => r.rowId === id)!;

describe('offers', () => {
  it('keeps only the latest version of each offer', () => {
    expect(rows.filter((r) => r.offer.id === 'o_kista')).toHaveLength(1);
    expect(byId('o_kista').offer.version).toBe(2);
  });
  it('derives status from concessions, plan and claims', () => {
    expect(byId('o_kista').statuses).toEqual(['derived', 'in-plan']);
    expect(byId('o_soder').statuses).toEqual(['in-plan']);
    expect(byId('o_budgetkit').statuses).toEqual(['published', 'challenged']);
    expect(byId('o_hammarby').statuses).toEqual(['published']);
  });
  it('marks only directly named offers as blocking', () => {
    expect(byId('o_kista').blocking).toBe(true);
    expect(byId('o_solna').blocking).toBe(true);
    expect(byId('o_bromma').blocking).toBe(false);
  });
  it('reports capacity against the evidence tier of its claim', () => {
    expect(byId('o_budgetkit').capacityTier).toBe('simulation-only');
    expect(byId('o_hammarby').capacityTier).toBeUndefined();
  });
  it('groups by stage with a needed quantity and collapses', () => {
    const g = groupOfferRows(ix, rows, new Set());
    expect(g.filter((r) => r.kind === 'group')).toHaveLength(4);
    const print = g.find((r) => r.kind === 'group' && r.stage.id === 'print');
    expect(print && print.kind === 'group' && print.needed).toBe(500);
    expect(groupOfferRows(ix, rows, new Set(['print'])).length).toBe(g.length - 3);
  });
  it('picks the tier price for a quantity', () => {
    const o = byId('o_soder').offer;
    expect(priceAt(o.tiers, 100).minor).toBe(1250);
    expect(priceAt(o.tiers, 600).minor).toBe(1100);
  });
});

describe('provenance', () => {
  const d = offerDetail(ix, byId('o_kista').offer, now);
  const section = (h: string) => d.sections.find((s) => s.heading.startsWith(h))!;
  it('traces constraint, concession, obligation and PayPal record', () => {
    expect(section('Constraints').items.some((i) => i.badge === 'Blocking')).toBe(true);
    expect(section('Concessions').items[0]?.badge).toBe('Accepted');
    expect(section('Obligations').items).toHaveLength(1);
    const pay = section('PayPal').items[0]!;
    expect(pay.badge).toBe('Sandbox');
    expect(pay.link?.id).toBe('pay_kista');
  });
});

describe('other tabs', () => {
  it('joins decisions to questions and ranks by value of information', () => {
    const q = buildQuestionRows(ix);
    expect(q.map((r) => r.rowId)).toEqual(['m_kista', 'm_solna', 'm_bromma']);
    expect(q.map((r) => r.outcome)).toEqual(['Accepted', 'Countered', 'Awaiting answer']);
    expect(q[1]!.counter).toContain('450');
  });
  it('flags a coalition whose split fails individual rationality', () => {
    const c = buildCoalitionRows(ix);
    expect(c).toHaveLength(1);
    expect(c[0]!.rational).toBe('no');
    expect(c[0]!.state).toBe('In plan');
  });
  it('takes claim verdicts from challenge events', () => {
    const c = buildClaimRows(ix, now);
    expect(c.find((r) => r.rowId === 'c_budgetkit')!.verdict).toBe('contradicted');
    expect(c.find((r) => r.rowId === 'c_arsta')!.verdict).toBe('expired');
    expect(c.find((r) => r.rowId === 'c_solna')!.verdict).toBe('unchecked');
  });
  it('lists only API payments', () => {
    const p = buildPaymentRows(ix);
    expect(p.map((r) => r.fetched)).toEqual([true, false]);
  });
});
