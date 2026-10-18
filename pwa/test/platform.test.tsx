import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTouchPhone } from '../src/platform';

function env(coarse: boolean, width: number | null) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false }));
  if (width !== null) vi.stubGlobal('innerWidth', width);
}
afterEach(() => vi.unstubAllGlobals());

describe('isTouchPhone', () => {
  it('true for coarse pointer at 390px', () => {
    env(true, 390);
    expect(isTouchPhone()).toBe(true);
  });
  it('false for a fine pointer', () => {
    env(false, 390);
    expect(isTouchPhone()).toBe(false);
  });
  it('false at 1024px', () => {
    env(true, 1024);
    expect(isTouchPhone()).toBe(false);
  });
  it('false without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isTouchPhone()).toBe(false);
  });
});
