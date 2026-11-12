import type { Currency } from '@framvera/contracts';
import type { ExchangeMarket, SurplusLot, Want } from './exchange.ts';
import { rng } from './util.ts';

const FIRMS = [
  'Hammarby Wrap', 'Bromma Board', 'Älvsjö Pallets', 'Kista Laser', 'Solna Sleeves', 'Nacka Vans',
  'Täby Foam', 'Huddinge Racking', 'Lidingö Labels', 'Sundbyberg Print', 'Farsta Tape', 'Vällingby Crates',
];

const GOODS: { good: string; unit: string; qty: [number, number]; kr: [number, number] }[] = [
  { good: 'corrugated board', unit: 'sheets', qty: [400, 1200], kr: [2500, 6000] },
  { good: 'pallet space', unit: 'pallet-weeks', qty: [10, 40], kr: [1500, 4000] },
  { good: 'laser cutter time', unit: 'hours', qty: [6, 20], kr: [3000, 8000] },
  { good: 'printed sleeves', unit: 'sleeves', qty: [300, 900], kr: [2000, 5000] },
  { good: 'van days', unit: 'days', qty: [1, 4], kr: [2500, 7000] },
  { good: 'foam inserts', unit: 'inserts', qty: [200, 800], kr: [1800, 4500] },
  { good: 'shelf racking', unit: 'bays', qty: [4, 12], kr: [2000, 6000] },
  { good: 'label rolls', unit: 'rolls', qty: [20, 80], kr: [1200, 3500] },
];

/**
 * A seeded synthetic surplus market: firms holding idle stock or capacity and wanting other goods.
 * Declared values are drawn so that keeping a lot is worth less to its owner than the lot is to some
 * other firm, which is when circular exchange can create value.
 */
export function exchangeMarket(seed = 1, firms = 8, currency: Currency = 'SEK'): ExchangeMarket {
  const r = rng(seed);
  const between = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
  const n = Math.max(3, Math.min(FIRMS.length, firms));
  const participants = FIRMS.slice(0, n).map((name, i) => ({ id: `f${i + 1}`, name }));
  const lots: SurplusLot[] = [];
  const wants: Want[] = [];
  participants.forEach((p, i) => {
    const owned = [GOODS[i % GOODS.length]!, ...(r() < 0.5 ? [GOODS[(i + 3) % GOODS.length]!] : [])];
    owned.forEach((g, k) => {
      const kr = between(g.kr[0], g.kr[1]);
      lots.push({ id: `${p.id}-lot${k + 1}`, owner: p.id, good: g.good, qty: between(g.qty[0], g.qty[1]), unit: g.unit, reserve: { currency, minor: Math.round(kr * (0.35 + r() * 0.3)) * 100 } });
    });
    const desired = new Set<number>();
    while (desired.size < 2) {
      const j = between(0, GOODS.length - 1);
      if (!owned.includes(GOODS[j]!)) desired.add(j);
    }
    [...desired].forEach((j, k) => {
      const g = GOODS[j]!;
      wants.push({ id: `${p.id}-want${k + 1}`, participant: p.id, good: g.good, minQty: g.qty[0], value: { currency, minor: between(g.kr[0], g.kr[1]) * 100 } });
    });
  });
  return { id: `exchange-${seed}`, currency, participants, lots, wants };
}
