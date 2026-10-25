// Invariant: pure; decides whether the admin may withdraw now, from API balance facts only.
import type { Balance } from '../api/types';

export const SWEEP_CONFIRMATIONS = 10;

export type WithdrawGate =
  | { kind: 'ready' }
  | { kind: 'nothing' }
  | { kind: 'wait'; minutes: number }
  | { kind: 'sweeping' }
  | { kind: 'unknown' };

export function withdrawGate(
  balance: Balance | undefined,
  blockIntervalSeconds: number,
  tabState: string,
): WithdrawGate {
  if (tabState === 'sweeping') return { kind: 'sweeping' };
  if (balance === undefined) return { kind: 'unknown' };
  const min = balance.min_unspent_confirmations;
  // Current watchers report what the next sweep would send (deep notes only, after fee). Older ones
  // sweep everything or nothing, so there spendable funds alone are not enough.
  const ready =
    balance.sweepable_zat !== undefined
      ? balance.sweepable_zat > 0
      : balance.spendable_zat > 0 && (min === null || min >= SWEEP_CONFIRMATIONS);
  if (ready) return { kind: 'ready' };
  if (balance.spendable_zat > 0 || balance.pending_zat > 0) {
    const left = SWEEP_CONFIRMATIONS - (min ?? 0);
    return { kind: 'wait', minutes: Math.max(1, Math.ceil((left * blockIntervalSeconds) / 60)) };
  }
  return { kind: 'nothing' };
}
