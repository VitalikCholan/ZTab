import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabView } from '../../src/api/types.ts';
import { buildPaymentUri } from '../../src/domain/zip321.ts';
import type { Session } from '../../src/tab/keys.ts';

const useTab = vi.fn();
const phone = vi.fn(() => true);
vi.mock('../../src/hooks/useTab.ts', () => ({ useTab: (...a: unknown[]) => useTab(...a) }));
vi.mock('../../src/platform.ts', () => ({ isTouchPhone: () => phone() }));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

import { Participant } from '../../src/pages/Participant.tsx';

const ADDR = 'utest1addr';
const SHARE_ZAT = 3121099; // $12.50 at 400.5
const blob = (over: Record<string, unknown> = {}) => ({
  v: 1, title: 'Dinner', index: 0, name: 'Bob', share_cents: 1250, share_zat: SHARE_ZAT,
  address: ADDR, rate_usd_per_zec: 400.5, mode: 'individual', ...over,
});
const session = { tabId: 't', role: 'participant', index: 0 } as unknown as Session;
const pay = (zat: number, confirmations = 5) => ({
  txid: 'x', value_zat: zat, mined_height: confirmations > 0 ? 10 : null, confirmations,
  transparent_source: false, first_seen_at: '2026-01-01T00:00:00Z',
});
const facts = (transparent = false) => ({ confirmed_zat: 0, mempool_zat: 0, best_confirmations: 0, transparent_source: transparent });

function setup(opts: { payments?: ReturnType<typeof pay>[]; facts?: ReturnType<typeof facts> | null; stale?: boolean; blob?: Record<string, unknown>; address?: string; verified?: boolean } = {}) {
  const view = {
    participant_index: 0, stale: opts.stale ?? false,
    participants: [{ index: 0, address: opts.address ?? ADDR, payments: opts.payments ?? [], status_facts: opts.facts === undefined ? facts() : opts.facts }],
  } as unknown as TabView;
  useTab.mockReturnValue({ view, blob: blob(opts.blob), verified: opts.verified ?? true, error: null, stale: opts.stale ?? false, refresh: vi.fn() });
  return render(<Participant session={session} />);
}

beforeEach(() => { useTab.mockReset(); phone.mockReturnValue(true); });
afterEach(cleanup);

describe('Participant', () => {
  it('header', () => {
    setup();
    expect(screen.getByText('Dinner')).toBeInTheDocument();
    expect(screen.getByText('Hi, Bob')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText("≈ 0.03121099 ZEC")).toBeInTheDocument();
  });

  it('waiting: badge and pay link for the full share', () => {
    setup();
    expect(screen.getByText('Waiting for payment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pay with your wallet' })).toHaveAttribute('href', buildPaymentUri(ADDR, SHARE_ZAT, 'ZTab share'));
  });

  it('pay link message is neutral', () => {
    setup();
    const href = screen.getByRole('link', { name: 'Pay with your wallet' }).getAttribute('href')!;
    expect(href).toContain('message=ZTab%20share');
    expect(href).not.toContain('Dinner');
    expect(href).not.toContain('Bob');
  });

  it('seen', () => {
    setup({ payments: [pay(SHARE_ZAT, 0)] });
    expect(screen.getByText('Payment seen, confirming…')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
  });

  it('paid and paid_transparent: badge only, no pay', () => {
    setup({ payments: [pay(SHARE_ZAT)] });
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
    cleanup();
    setup({ payments: [pay(SHARE_ZAT)], facts: facts(true) });
    expect(screen.getByText('Paid · from a transparent address')).toBeInTheDocument();
  });

  it('partial: sentence and pay link for remaining zat', () => {
    const paid = 1997400; // ~ $8.00
    setup({ payments: [pay(paid)] });
    expect(screen.getByText('Partially paid')).toBeInTheDocument();
    expect(screen.getByText('Paid $8.00 of $12.50 · $4.50 left')).toBeInTheDocument();
    const href = screen.getByRole('link', { name: 'Pay with your wallet' }).getAttribute('href')!;
    expect(href).toBe(buildPaymentUri(ADDR, SHARE_ZAT - paid, 'ZTab share'));
    expect(href).toContain('amount=0.01123699');
  });

  it('overpaid', () => {
    setup({ payments: [pay(SHARE_ZAT + 499500)] }); // $2.00 over
    expect(screen.getByText('Paid · overpaid')).toBeInTheDocument();
    expect(screen.getByText('Paid · $2.00 over, thank you')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
  });

  it('unknown shows stale banner when stale', () => {
    setup({ facts: null, stale: true });
    expect(screen.getByText('Status unknown')).toBeInTheDocument();
    expect(screen.getByText(/Live data is delayed/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
  });

  it('desktop shows QR and copy buttons', () => {
    phone.mockReturnValue(false);
    setup();
    expect(screen.getByRole('img', { name: 'QR code for payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy amount' })).toBeInTheDocument();
  });

  it('address mismatch hides the pay panel', () => {
    setup({ address: 'utest1other' });
    expect(screen.getByText('Address mismatch, do not pay')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('participant page with wrong commitment shows mismatch and no Pay', () => {
    setup({ verified: false, address: 'utest1evil', blob: { address: 'utest1evil' } });
    expect(screen.getByText('Address mismatch, do not pay')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('unverified page shows only the alert, not the forged content', () => {
    setup({ verified: false, blob: { title: 'FORGEDTITLE', name: 'Mallory', address: ADDR } });
    expect(screen.getAllByText('Address mismatch, do not pay')).toHaveLength(1);
    expect(screen.queryByText('FORGEDTITLE')).toBeNull();
    expect(screen.queryByText(/Mallory/)).toBeNull();
    expect(screen.queryByText('$12.50')).toBeNull();
  });

  it('clicking Pay switches polling to 5000', async () => {
    setup();
    expect(useTab).toHaveBeenLastCalledWith(session, 10_000);
    const a = screen.getByRole('link', { name: 'Pay with your wallet' });
    a.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(a);
    expect(useTab).toHaveBeenLastCalledWith(session, 5_000);
  });

  it('footer per mode', () => {
    setup();
    expect(screen.getByText("Payments are shielded. Only this link and the organizer's link open this page.")).toBeInTheDocument();
    cleanup();
    setup({ blob: { mode: 'group' } });
    expect(screen.getByText('Payments are shielded. Everyone with the group link sees this status.')).toBeInTheDocument();
  });
});
