// Invariant: pure; per-participant badge from payments per spec §13.4. Integer zatoshi only.
import type { Payment, StatusFacts } from '../api/types';

export const PAID_CONFIRMATIONS = 3;

export type Badge = 'unknown' | 'waiting' | 'seen' | 'paid' | 'paid_transparent' | 'partial' | 'overpaid';

export const BADGE_LABEL: Record<Badge, string> = {
  unknown: 'Status unknown',
  waiting: 'Waiting for payment',
  seen: 'Payment seen, confirming…',
  paid: 'Paid',
  paid_transparent: 'Paid · from a transparent address',
  partial: 'Partially paid',
  overpaid: 'Paid · overpaid',
};

export interface StatusResult {
  badge: Badge;
  paidZat: number;
  pendingZat: number;
  remainingZat: number;
}

export function computeStatus(
  p: { payments: Payment[]; status_facts: StatusFacts | null },
  shareZat: number,
): StatusResult {
  let paidZat = 0;
  let pendingZat = 0;
  for (const x of p.payments) {
    if (x.mined_height !== null && x.confirmations >= PAID_CONFIRMATIONS) paidZat += x.value_zat;
    else pendingZat += x.value_zat;
  }
  const remainingZat = Math.max(0, shareZat - paidZat);
  let badge: Badge;
  if (p.status_facts === null) badge = 'unknown';
  else if (paidZat > shareZat) badge = 'overpaid';
  else if (paidZat >= shareZat && paidZat > 0) badge = p.status_facts.transparent_source ? 'paid_transparent' : 'paid';
  else if (paidZat > 0) badge = 'partial';
  else if (pendingZat > 0) badge = 'seen';
  else badge = 'waiting';
  return { badge, paidZat, pendingZat, remainingZat };
}
