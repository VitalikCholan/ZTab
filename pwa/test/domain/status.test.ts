import { describe, expect, it } from 'vitest';
import type { Payment, StatusFacts } from '../../src/api/types';
import { BADGE_LABEL, computeStatus } from '../../src/domain/status';

const pay = (value_zat: number, confirmations: number, mined = confirmations > 0): Payment => ({
  txid: `t${value_zat}${confirmations}`,
  value_zat,
  mined_height: mined ? 100 : null,
  confirmations,
  transparent_source: false,
  first_seen_at: '2026-10-18T00:00:00Z',
});
const facts = (transparent_source = false): StatusFacts => ({
  confirmed_zat: 0, mempool_zat: 0, best_confirmations: 0, transparent_source,
});
const SHARE = 1_250_000;

describe('computeStatus', () => {
  it('unknown when facts are null, even with payments', () => {
    const r = computeStatus({ payments: [pay(SHARE, 5)], status_facts: null }, SHARE);
    expect(r.badge).toBe('unknown');
  });
  it('waiting with no payments', () => {
    expect(computeStatus({ payments: [], status_facts: facts() }, SHARE))
      .toEqual({ badge: 'waiting', paidZat: 0, pendingZat: 0, remainingZat: SHARE });
  });
  it('seen for mempool payment', () => {
    const r = computeStatus({ payments: [pay(SHARE, 0, false)], status_facts: facts() }, SHARE);
    expect(r).toMatchObject({ badge: 'seen', paidZat: 0, pendingZat: SHARE });
  });
  it('2 confirmations is seen, 3 is paid', () => {
    expect(computeStatus({ payments: [pay(SHARE, 2)], status_facts: facts() }, SHARE).badge).toBe('seen');
    expect(computeStatus({ payments: [pay(SHARE, 3)], status_facts: facts() }, SHARE))
      .toMatchObject({ badge: 'paid', remainingZat: 0 });
  });
  it('partial', () => {
    expect(computeStatus({ payments: [pay(500_000, 6)], status_facts: facts() }, SHARE))
      .toEqual({ badge: 'partial', paidZat: 500_000, pendingZat: 0, remainingZat: 750_000 });
  });
  it('top-up with 1 confirmation stays partial', () => {
    const r = computeStatus({ payments: [pay(800_000, 5), pay(450_000, 1)], status_facts: facts() }, SHARE);
    expect(r).toEqual({ badge: 'partial', paidZat: 800_000, pendingZat: 450_000, remainingZat: 450_000 });
  });
  it('overpaid', () => {
    expect(computeStatus({ payments: [pay(SHARE + 1, 9)], status_facts: facts() }, SHARE))
      .toMatchObject({ badge: 'overpaid', remainingZat: 0 });
  });
  it('paid_transparent replaces paid only', () => {
    expect(computeStatus({ payments: [pay(SHARE, 9)], status_facts: facts(true) }, SHARE).badge)
      .toBe('paid_transparent');
    expect(computeStatus({ payments: [pay(SHARE + 1, 9)], status_facts: facts(true) }, SHARE).badge)
      .toBe('overpaid');
    expect(computeStatus({ payments: [pay(SHARE, 1)], status_facts: facts(true) }, SHARE).badge)
      .toBe('seen');
  });
  it('labels', () => {
    expect(BADGE_LABEL.paid_transparent).toBe('Paid · from a transparent address');
    expect(BADGE_LABEL.seen).toBe('Payment seen, confirming…');
  });
});
