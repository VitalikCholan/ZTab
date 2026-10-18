import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabView } from '../../src/api/types.ts';
import { buildPaymentUri } from '../../src/domain/zip321.ts';
import type { Session } from '../../src/tab/keys.ts';

const useTab = vi.fn();
vi.mock('../../src/hooks/useTab.ts', () => ({ useTab: (...a: unknown[]) => useTab(...a) }));
vi.mock('../../src/platform.ts', () => ({ isTouchPhone: () => true }));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

import { Group } from '../../src/pages/Group.tsx';

const SHARE_ZAT = 31250000; // $12.50 at $40/ZEC
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];
const addr = (i: number) => `utest1addr${i}`;
const blob = {
  v: 1, title: 'Dinner', currency: 'USD', total_cents: 5000, rate_usd_per_zec: 40, rate_at: '2026-10-18T00:00:00Z',
  mode: 'group', created_at: '2026-10-18T00:00:00Z',
  participants: NAMES.map((name, index) => ({ index, name, share_cents: 1250, share_zat: SHARE_ZAT, address: addr(index) })),
};
const pay = (zat: number) => ({ txid: 'x', value_zat: zat, mined_height: 10, confirmations: 5, transparent_source: false, first_seen_at: '2026-01-01T00:00:00Z' });
const facts = { confirmed_zat: 0, mempool_zat: 0, best_confirmations: 0, transparent_source: false };
const session = { tabId: 't', role: 'group' } as unknown as Session;

function setup(paid: number[] = [SHARE_ZAT, SHARE_ZAT, SHARE_ZAT, 0]) {
  const view = {
    state: 'open', stale: false, role: 'group',
    balance: { spendable_zat: 3 * SHARE_ZAT, pending_zat: 0, swept_zat: 0, min_unspent_confirmations: 12 },
    participants: paid.map((z, index) => ({ index, address: addr(index), payments: z ? [pay(z)] : [], status_facts: facts })),
  } as unknown as TabView;
  useTab.mockReturnValue({ view, blob, error: null, stale: false, refresh: vi.fn() });
  return render(<Group session={session} />);
}

beforeEach(() => useTab.mockReset());
afterEach(cleanup);

describe('Group', () => {
  it('summary line, badges and footer', () => {
    setup();
    expect(screen.getByText('Dinner')).toBeInTheDocument();
    expect(screen.getByText('$37.50 of $50.00 collected · 3 of 4 paid')).toBeInTheDocument();
    expect(screen.getAllByText('Paid')).toHaveLength(3);
    expect(screen.getByText('Waiting for payment')).toBeInTheDocument();
    expect(screen.getByText('Payments are shielded. Everyone with the group link sees this status.')).toBeInTheDocument();
  });

  it('has no withdraw UI and no Copy admin link', () => {
    setup();
    expect(screen.queryByRole('button', { name: /withdraw/i })).toBeNull();
    expect(screen.queryByText(/withdraw/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy admin link' })).toBeNull();
    expect(screen.queryByText(/admin link/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /share link/i })).toBeNull();
  });

  it('per-row Pay only for waiting/partial, opens the panel for that index', async () => {
    const part = 10000000;
    setup([SHARE_ZAT, SHARE_ZAT, part, 0]);
    expect(screen.queryByRole('button', { name: 'Pay for Alice' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Pay for Dave' }));
    const links = screen.getAllByRole('link', { name: 'Pay with your wallet' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', buildPaymentUri(addr(3), SHARE_ZAT, "Dinner — Dave's share"));

    await userEvent.click(screen.getByRole('button', { name: 'Pay for Carol' }));
    const href = screen.getByRole('link', { name: 'Pay with your wallet' }).getAttribute('href')!;
    expect(href).toBe(buildPaymentUri(addr(2), SHARE_ZAT - part, "Dinner — Carol's share"));
    expect(href).toContain(addr(2));
    expect(href).toContain('amount=0.2125');

    await userEvent.click(screen.getByRole('button', { name: 'Pay for Carol' }));
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
  });

  it('a missing row or unknown facts reads as unknown; a wrong address blocks paying', () => {
    const view = {
      state: 'open', stale: false, role: 'group',
      participants: [
        { index: 0, address: addr(0), payments: [], status_facts: null },
        { index: 1, address: 'utest1evil', payments: [], status_facts: facts },
        { index: 2, address: addr(2), payments: [], status_facts: facts },
      ],
    } as unknown as TabView;
    useTab.mockReturnValue({ view, blob, error: null, stale: false, refresh: vi.fn() });
    render(<Group session={session} />);
    expect(screen.getAllByText('Status unknown')).toHaveLength(2); // Alice (null facts), Dave (no row)
    expect(screen.getByText('Address mismatch, do not pay')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay for Bob' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay for Carol' })).toBeInTheDocument();
    expect(screen.getByText('$0.00 of $50.00 collected · 0 of 4 paid')).toBeInTheDocument();
  });

  it('never says close', () => {
    const r = setup();
    expect(r.container.textContent).not.toMatch(/\bclose\b/i);
  });
});
