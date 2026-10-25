import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabView } from '../../src/api/types.ts';
import type { GroupBlob } from '../../src/tab/blobs.ts';

vi.mock('../../src/platform.ts', () => ({ isTouchPhone: () => true }));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

import { ParticipantList, rowStatuses } from '../../src/components/ParticipantList.tsx';

const SHARE_ZAT = 31250000; // $12.50 at $40/ZEC
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];
const addr = (i: number) => `utest1addr${i}`;
const blob: GroupBlob = {
  v: 1, title: 'Dinner', currency: 'USD', total_cents: 5000, rate_usd_per_zec: 40, rate_at: '2026-10-18T00:00:00Z',
  mode: 'group', created_at: '2026-10-18T00:00:00Z',
  participants: NAMES.map((name, index) => ({ index, name, share_cents: 1250, share_zat: SHARE_ZAT, address: addr(index) })),
};
const pay = (zat: number) => ({ txid: 'x', value_zat: zat, mined_height: 10, confirmations: 5, transparent_source: false, first_seen_at: '2026-01-01T00:00:00Z' });
const facts = { confirmed_zat: 0, mempool_zat: 0, best_confirmations: 0, transparent_source: false };

function setup(paid: number[], b: GroupBlob = blob) {
  const view = {
    state: 'open', stale: false, role: 'group',
    participants: paid.map((z, index) => ({ index, address: addr(index), payments: z ? [pay(z)] : [], status_facts: facts })),
  } as unknown as TabView;
  return render(<ParticipantList blob={b} view={view} onPay={() => undefined} />);
}

afterEach(cleanup);

describe('rowStatuses', () => {
  it('rowStatuses marks every row mismatch when unverified', () => {
    const view = {
      state: 'open', stale: false, role: 'group',
      participants: [0, 1, 2, 3].map((index) => ({ index, address: addr(index), payments: [], status_facts: facts })),
    } as unknown as TabView;
    const rows = rowStatuses(blob, view, false);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === null && r.mismatch)).toBe(true);
    expect(rowStatuses(blob, view).some((r) => r.mismatch)).toBe(false);
  });
});

describe('ParticipantList progress bar', () => {
  it('reports collected of total', () => {
    setup([SHARE_ZAT, SHARE_ZAT, 0, 0]);
    const bar = screen.getByRole('progressbar', { name: 'Collected' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '5000');
    expect(bar).toHaveAttribute('aria-valuenow', '2500');
    expect(bar.firstElementChild?.classList.contains('w-[50%]')).toBe(true);
    expect(screen.getByText('$25.00 of $50.00 collected · 2 of 4 paid')).toBeInTheDocument();
  });

  it('clamps when overpaid', () => {
    setup([SHARE_ZAT * 2, SHARE_ZAT, SHARE_ZAT, SHARE_ZAT]);
    const bar = screen.getByRole('progressbar', { name: 'Collected' });
    expect(bar).toHaveAttribute('aria-valuenow', '5000');
    expect(bar.firstElementChild?.classList.contains('w-[100%]')).toBe(true);
  });

  it('is empty when nothing is paid', () => {
    setup([0, 0, 0, 0]);
    const bar = screen.getByRole('progressbar', { name: 'Collected' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar.firstElementChild?.classList.contains('w-[0%]')).toBe(true);
  });

  it('shows at least the first step for a tiny payment', () => {
    setup([2500000, 0, 0, 0]);
    const bar = screen.getByRole('progressbar', { name: 'Collected' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar.firstElementChild?.classList.contains('w-[5%]')).toBe(true);
  });

  it('guards a zero total', () => {
    setup([0, 0, 0, 0], { ...blob, total_cents: 0 });
    const bar = screen.getByRole('progressbar', { name: 'Collected' });
    expect(bar).toHaveAttribute('aria-valuemax', '0');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar.firstElementChild?.classList.contains('w-[0%]')).toBe(true);
  });
});
