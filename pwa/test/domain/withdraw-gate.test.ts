import { describe, expect, it } from 'vitest';
import type { Balance } from '../../src/api/types';
import { withdrawGate } from '../../src/domain/withdraw-gate';

const bal = (spendable_zat: number, pending_zat: number, min: number | null): Balance => ({
  spendable_zat, pending_zat, swept_zat: 0, min_unspent_confirmations: min,
});

describe('withdrawGate', () => {
  it('wait with minutes', () => {
    expect(withdrawGate(bal(0, 5, 4), 25, 'open')).toEqual({ kind: 'wait', minutes: 3 });
    expect(withdrawGate(bal(0, 5, 9), 25, 'open')).toEqual({ kind: 'wait', minutes: 1 });
    expect(withdrawGate(bal(0, 5, null), 25, 'open')).toEqual({ kind: 'wait', minutes: 5 });
  });
  it('ready when spendable', () => {
    expect(withdrawGate(bal(10, 0, 10), 25, 'open')).toEqual({ kind: 'ready' });
    expect(withdrawGate(bal(10, 5, 2), 25, 'open')).toEqual({ kind: 'ready' });
  });
  it('nothing', () => {
    expect(withdrawGate(bal(0, 0, null), 25, 'open')).toEqual({ kind: 'nothing' });
  });
  it('unknown without balance', () => {
    expect(withdrawGate(undefined, 25, 'open')).toEqual({ kind: 'unknown' });
  });
  it('sweeping wins', () => {
    expect(withdrawGate(bal(10, 0, 10), 25, 'sweeping')).toEqual({ kind: 'sweeping' });
    expect(withdrawGate(undefined, 25, 'sweeping')).toEqual({ kind: 'sweeping' });
  });
});
