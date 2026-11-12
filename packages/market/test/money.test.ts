import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { add, allocate, canonical, cmp, fmt, hashTerms, money, mul, parseKr, scale, sek, sha256Hex, sub, sumMoney } from '@framvera/contracts';

describe('money', () => {
  it('adds, subtracts and multiplies exactly in minor units', () => {
    expect(add(sek(0.1), sek(0.2))).toEqual(money('SEK', 30));
    expect(sub(sek(55_000), sek(54_300.5))).toEqual(money('SEK', 69_950));
    expect(mul(sek(17), 500)).toEqual(sek(8_500));
    expect(sumMoney([sek(5_400), sek(19_000), sek(10_700), sek(10_800), sek(6_200)], 'SEK')).toEqual(sek(52_100));
    expect(cmp(sek(1), sek(2))).toBe(-1);
  });

  it('rejects mixed currencies and fractional minor units', () => {
    expect(() => add(sek(1), money('USD', 100))).toThrow(/Currency mismatch/);
    expect(() => money('SEK', 1.5)).toThrow();
    expect(() => mul(sek(1), 2.5)).toThrow();
  });

  it('formats Swedish kronor the way the product shows them', () => {
    expect(fmt(sek(54_300))).toBe('54 300 kr');
    expect(fmt(sek(55_000))).toBe('55 000 kr');
    expect(fmt(sek(1_234.5))).toBe('1 234,50 kr');
    expect(fmt(sek(-1_200))).toBe('-1 200 kr');
    expect(fmt(sek(0))).toBe('0 kr');
    expect(fmt(sek(1_000_000))).toBe('1 000 000 kr');
    expect(fmt(money('USD', 123_450))).toBe('$1,234.50');
    expect(fmt(money('EUR', 5))).toBe('€0.05');
  });

  it('parses common ways of writing a budget', () => {
    expect(parseKr('55 000 kr')).toEqual(sek(55_000));
    expect(parseKr('55,000 SEK')).toEqual(sek(55_000));
    expect(parseKr('55000')).toEqual(sek(55_000));
    expect(parseKr('55k')).toEqual(sek(55_000));
    expect(parseKr('54 300,50 kr')).toEqual(sek(54_300.5));
    expect(parseKr('about fifty')).toBeNull();
  });

  it('scales with half-away-from-zero rounding', () => {
    expect(scale(money('SEK', 5), 1, 2)).toEqual(money('SEK', 3));
    expect(scale(money('SEK', -5), 1, 2)).toEqual(money('SEK', -3));
    expect(scale(sek(1_000), 3, 4)).toEqual(sek(750));
  });

  it('allocates splits that always sum to the whole', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }), (minor, weights) => {
        fc.pre(weights.some((w) => w > 0));
        const parts = allocate(money('SEK', minor), weights);
        expect(parts.reduce((s, p) => s + p.minor, 0)).toBe(minor);
        parts.forEach((p, i) => {
          if (weights[i] === 0) expect(p.minor).toBe(0);
        });
      }),
    );
  });
});

describe('canonical terms and hashing', () => {
  it('matches the reference sha256 for known and random inputs', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
        expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
      }),
    );
  });

  it('is independent of key order and drops undefined members', () => {
    expect(canonical({ b: 1, a: { d: [1, 'x'], c: null } })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
    expect(hashTerms({ a: 1, b: 2, c: undefined })).toBe(hashTerms({ b: 2, a: 1 }));
    expect(hashTerms({ a: 1 })).not.toBe(hashTerms({ a: 2 }));
    expect(() => canonical({ x: Number.NaN })).toThrow();
  });
});
