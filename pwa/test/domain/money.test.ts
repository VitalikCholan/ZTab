import { describe, expect, it } from 'vitest';
import {
  centsToUsdString, centsToZat, parseUsdInput, sharesMatchTotal, splitEqually, zatToZecString,
} from '../../src/domain/money';

describe('money', () => {
  it('centsToZat', () => {
    expect(centsToZat(1250, 400.5)).toBe(3121099); // brief says 312109, a dropped digit: 12.50 / 400.5 = 0.03121099 ZEC
  });
  it('zatToZecString', () => {
    expect(zatToZecString(312109)).toBe('0.00312109');
    expect(zatToZecString(100000000)).toBe('1');
    expect(zatToZecString(0)).toBe('0');
    expect(zatToZecString(100000)).toBe('0.001');
    expect(zatToZecString(250000001)).toBe('2.50000001');
  });
  it('centsToUsdString', () => {
    expect(centsToUsdString(1250)).toBe('$12.50');
    expect(centsToUsdString(5)).toBe('$0.05');
    expect(() => centsToUsdString(-1)).toThrow();
  });
  it('splitEqually', () => {
    expect(splitEqually(5000, 3)).toEqual([1668, 1666, 1666]);
    expect(splitEqually(5000, 2)).toEqual([2500, 2500]);
    expect(splitEqually(100, 3)).toEqual([34, 33, 33]);
    expect(() => splitEqually(100, 0)).toThrow(RangeError);
    expect(() => splitEqually(100, 1.5)).toThrow(RangeError);
  });
  it('sharesMatchTotal', () => {
    expect(sharesMatchTotal([1250, 1250], 2501)).toBe(false);
    expect(sharesMatchTotal([1250, 1250], 2500)).toBe(true);
  });
  it('parseUsdInput', () => {
    expect(parseUsdInput('12')).toBe(1200);
    expect(parseUsdInput('12.5')).toBe(1250);
    expect(parseUsdInput(' 12.50 ')).toBe(1250);
    expect(parseUsdInput('0.07')).toBe(7);
    for (const bad of ['12.345', '-1', '', '  ', '$12', 'abc', 'NaN', '1e3', '.5', '12.'])
      expect(parseUsdInput(bad), bad).toBeNull();
  });
});

describe('zatToCents', () => {
  it('converts with the fixed rate', async () => {
    const { zatToCents } = await import('../../src/domain/money');
    expect(zatToCents(3121099, 400.5)).toBe(1250);
    expect(zatToCents(0, 400.5)).toBe(0);
  });
});
