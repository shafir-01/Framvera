import { describe, expect, it } from 'vitest';
import type { Plan, World } from '@framvera/contracts';
import { applyCoalition, priceAt, solve, verifyPlan } from '../src/index.ts';
import { kitsIntent, kitsWorld, sek } from './fixtures.ts';

const HOUR = 3_600_000;
const shift = (iso: string, h: number) => new Date(Date.parse(iso) + h * HOUR).toISOString();

describe('verifyPlan', async () => {
  const world = kitsWorld();
  const intent = kitsIntent();
  const base = (await solve(world, intent)).plan!;
  const copy = (): Plan => structuredClone(base);
  const idx = (offer: string) => base.allocations.findIndex((a) => a.offer === offer);

  it('accepts the solver plan', () => {
    const v = verifyPlan(base, world, intent);
    expect(v.ok).toBe(true);
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });

  const injections: [string, string, (p: Plan, w: World) => void][] = [
    ['demand', 'demand', (p) => { p.allocations[idx('o-courier')]!.qty = 400; p.allocations[idx('o-courier')]!.cost.minor = 400 * 300 + 150000; }],
    ['capacity', 'capacity', (p) => { const a = p.allocations[idx('o-asm-kista')]!; a.qty = 320; a.cost.minor = 320 * 2500 + 200000; }],
    ['minimum order', 'min-qty', (p) => { const a = p.allocations[idx('o-asm-kista')]!; a.qty = 200; a.cost.minor = 200 * 2500 + 200000; }],
    ['window start', 'window', (p) => { const a = p.allocations[idx('o-asm-kista')]!; a.start = shift(a.start, -2); a.finish = shift(a.finish, -2); }],
    ['window end', 'window', (p) => { const a = p.allocations[idx('o-asm-kista')]!; a.start = shift(a.start, 60); a.finish = shift(a.finish, 60); }],
    ['duration', 'duration', (p) => { const a = p.allocations[idx('o-asm-solna')]!; a.finish = shift(a.finish, -1); }],
    ['precedence', 'precedence', (p) => { const a = p.allocations[idx('o-courier')]!; a.start = shift(a.start, -3); a.finish = shift(a.finish, -3); }],
    ['ready time', 'deadline', (p) => { p.readyAt = shift(p.readyAt, -5); }],
    ['unit price', 'money', (p) => { p.allocations[0]!.cost.minor -= 1; p.total.minor -= 1; }],
    ['total', 'money', (p) => { p.total.minor += 1; }],
    ['currency', 'money', (p) => { p.allocations[0]!.cost.currency = 'EUR'; }],
    ['fractional money', 'money', (p) => { p.allocations[0]!.cost.minor += 0.5; p.total.minor += 0.5; }],
    ['double booking', 'exclusive', (p) => { p.allocations.push(structuredClone(p.allocations[idx('o-box')]!)); }],
    ['unknown offer', 'offers', (p) => { p.allocations[0]!.offer = 'o-missing'; }],
    ['wrong supplier', 'offers', (p) => { p.allocations[0]!.actor = 'a-box'; }],
    ['fractional quantity', 'offers', (p) => { p.allocations[0]!.qty = 999.5; }],
    ['inactive supplier', 'offers', (_p, w) => { w.actors = w.actors.map((a) => (a.id === 'a-print' ? { ...a, active: false } : a)); }],
    ['expired offer', 'validity', (_p, w) => { w.offers = w.offers.map((o) => (o.id === 'o-print-a' ? { ...o, validUntil: '2026-11-15T00:00:00.000Z' } : o)); }],
    ['world version', 'identity', (p) => { p.worldVersion = 99; }],
  ];

  for (const [label, check, inject] of injections) {
    it(`catches ${label}`, () => {
      const p = copy();
      const w = structuredClone(world);
      inject(p, w);
      const v = verifyPlan(p, w, intent);
      expect(v.ok).toBe(false);
      expect(v.checks.find((c) => c.id === check)?.ok, JSON.stringify(v.checks.filter((c) => !c.ok))).toBe(false);
    });
  }

  it('catches a deadline miss', () => {
    const v = verifyPlan(base, world, { ...intent, deadline: shift(base.readyAt, -1) });
    expect(v.checks.find((c) => c.id === 'deadline')!.ok).toBe(false);
  });

  it('catches spending beyond the spending authority', () => {
    const v = verifyPlan(base, world, { ...intent, authority: { ...intent.authority, maxSpend: sek(30000) } });
    expect(v.checks.find((c) => c.id === 'budget')!.ok).toBe(false);
  });

  it('catches a budget overrun', () => {
    const v = verifyPlan(base, world, { ...intent, budget: sek(30000) });
    expect(v.checks.find((c) => c.id === 'budget')!.ok).toBe(false);
  });

  it('rejects a supplier booked both alone and inside a joint offer', () => {
    const w = structuredClone(world);
    const id = 'joint:shared:o-asm-kista>o-asm-solna';
    const joint = applyCoalition(w, id);
    const p = copy();
    p.worldVersion = joint.version;
    const kista = p.allocations[idx('o-asm-kista')]!;
    const derived = joint.offers.find((o) => o.id === id)!;
    p.allocations.push({ ...kista, offer: id, actor: derived.actor, qty: derived.minQty, cost: { ...kista.cost, minor: priceAt(derived, derived.minQty) } });
    p.total.minor += priceAt(derived, derived.minQty);
    const v = verifyPlan(p, joint, intent);
    expect(v.checks.find((c) => c.id === 'exclusive')!.ok).toBe(false);
  });

  it('rejects a joint offer when a member supplier has left', () => {
    const w = structuredClone(world);
    const id = 'joint:shared:o-asm-kista>o-asm-solna';
    const joint = applyCoalition(w, id);
    joint.actors = joint.actors.map((a) => (a.id === 'a-solna' ? { ...a, active: false } : a));
    const derived = joint.offers.find((o) => o.id === id)!;
    const p = copy();
    p.worldVersion = joint.version;
    p.allocations = p.allocations.filter((a) => a.stage !== 'assemble');
    p.allocations.push({ offer: id, actor: derived.actor, stage: 'assemble', qty: 500, start: derived.window.start, finish: derived.window.end, cost: { currency: 'SEK', minor: priceAt(derived, 500) } });
    const v = verifyPlan(p, joint, intent);
    expect(v.checks.find((c) => c.id === 'offers')!.ok).toBe(false);
  });
});
