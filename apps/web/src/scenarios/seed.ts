import type { Family } from './types.ts';

const FAMILIES: Family[] = ['feasible', 'salvageable', 'impossible'];

function mix(n: number): number {
  let x = (Math.floor(n) ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** A seed always maps to the same family. The family is revealed only after the market is solved. */
export function familyForSeed(seed: number): Family {
  return FAMILIES[mix(seed) % 3] ?? 'feasible';
}

export function parseSeed(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  return Number(t);
}

export function randomSeed(rand: () => number = Math.random): number {
  return 1 + Math.floor(rand() * 899_999_998);
}

/** Fixed seeds so a card always opens the same market. */
export const TEMPLATE_SEEDS = {
  exhibition: { seed: 4107, family: 'salvageable' as Family },
  circular: { seed: 7319, family: 'salvageable' as Family },
};
