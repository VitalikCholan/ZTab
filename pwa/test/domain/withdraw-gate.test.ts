import { describe, expect, it } from 'vitest';
import type { Balance } from '../../src/api/types';
import { withdrawGate } from '../../src/domain/withdraw-gate';

const bal = (spendable_zat: number, pending_zat: number, min: number | null, sweepable_zat?: number): Balance => ({
  spendable_zat, pending_zat, swept_zat: 0, min_unspent_confirmations: min,
  ...(sweepable_zat === undefined ? {} : { sweepable_zat }),
});

describe('withdrawGate', () => {
  it('wait with minutes', () => {
    expect(withdrawGate(bal(0, 5, 4), 25, 'open')).toEqual({ kind: 'wait', minutes: 3 });
    expect(withdrawGate(bal(0, 5, 9), 25, 'open')).toEqual({ kind: 'wait', minutes: 1 });
    expect(withdrawGate(bal(0, 5, null), 25, 'open')).toEqual({ kind: 'wait', minutes: 5 });
  });
  it('ready when spendable', () => {
    expect(withdrawGate(bal(10, 0, 10), 25, 'open')).toEqual({ kind: 'ready' });
    expect(withdrawGate(bal(10, 5, 10), 25, 'open')).toEqual({ kind: 'ready' });
    expect(withdrawGate(bal(10, 0, null), 25, 'open')).toEqual({ kind: 'ready' });
  });
  it('falls back to the old rule without sweepable_zat', () => {
    expect(withdrawGate(bal(10, 5, 2), 25, 'open')).toEqual({ kind: 'wait', minutes: 4 });
    expect(withdrawGate(bal(10, 5, 9), 25, 'open')).toEqual({ kind: 'wait', minutes: 1 });
  });
  it('ready with young notes when sweepable is positive', () => {
    expect(withdrawGate(bal(10, 5, 2, 8), 25, 'open')).toEqual({ kind: 'ready' });
  });
  it('gate waits when sweepable is zero but spendable is not', () => {
    expect(withdrawGate(bal(10, 5, 2, 0), 25, 'open')).toEqual({ kind: 'wait', minutes: 4 });
    expect(withdrawGate(bal(10, 0, 10, 0), 25, 'open')).toEqual({ kind: 'wait', minutes: 1 });
  });
  it('nothing when sweepable is zero and nothing is spendable or pending', () => {
    expect(withdrawGate(bal(0, 0, null, 0), 25, 'open')).toEqual({ kind: 'nothing' });
  });
  it('ready again on a closed tab with new deep notes', () => {
    expect(withdrawGate(bal(10, 0, 10, 9), 25, 'closed')).toEqual({ kind: 'ready' });
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
