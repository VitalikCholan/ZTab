import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../src/api/client.ts';
import type { Balance, TabView } from '../../src/api/types.ts';
import { config } from '../../src/config.ts';
import type { Session } from '../../src/tab/keys.ts';

const useTab = vi.fn();
vi.mock('../../src/hooks/useTab.ts', () => ({ useTab: (...a: unknown[]) => useTab(...a) }));
vi.mock('../../src/platform.ts', () => ({ isTouchPhone: () => true }));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
const w = vi.hoisted(() => ({ prepareWithdraw: vi.fn(), signAndBroadcast: vi.fn() }));
vi.mock('../../src/tab/withdraw.ts', () => w);
const apiMock = vi.hoisted(() => ({ sweepStatus: vi.fn(), status: vi.fn() }));
vi.mock('../../src/api/instance.ts', () => ({ api: apiMock }));
const keys = vi.hoisted(() => ({ adminLinks: vi.fn() }));
vi.mock('../../src/tab/keys.ts', () => keys);

import { Admin } from '../../src/pages/Admin.tsx';

const SHARE_ZAT = 31250000; // $12.50 at $40/ZEC
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];
const addr = (i: number) => `utest1addr${i}`;
const WITHDRAW = 'utest1ar2v4yu756pkxhpacqe0kut2zkjske7y2pe6dea6ezfg7qs3c8e4e5uflja4e4l5869c5j0q6g5gvvl8620uxy9nr26475939uegwc4d';
const TXID = '747c4880d80f95bb18e001fb2866ae60cf5559f9fc83a411dc782ec52bda77f5';
const ADMIN_URL = 'https://ztab.example/t/t#a=MASTERSECRET';
const P_URLS = NAMES.map((_, i) => `https://ztab.example/t/t#p=${i}.k${i}`);
const G_URL = 'https://ztab.example/t/t#g=gk';

const blobFor = (mode: 'group' | 'individual') => ({
  v: 1, title: 'Dinner', currency: 'USD', total_cents: 5000, rate_usd_per_zec: 40, rate_at: '2026-10-18T00:00:00Z',
  mode, created_at: '2026-10-18T00:00:00Z', withdraw_address: WITHDRAW,
  participants: NAMES.map((name, index) => ({ index, name, share_cents: 1250, share_zat: SHARE_ZAT, address: addr(index) })),
});
const pay = (zat: number) => ({ txid: 'x', value_zat: zat, mined_height: 10, confirmations: 5, transparent_source: false, first_seen_at: '2026-01-01T00:00:00Z' });
const facts = { confirmed_zat: 0, mempool_zat: 0, best_confirmations: 0, transparent_source: false };
const master = new Uint8Array(32).fill(7);
const session = { tabId: 't', role: 'admin', master, token: new Uint8Array(32), fullUrl: ADMIN_URL } as unknown as Session;

const READY: Balance = { spendable_zat: 3 * SHARE_ZAT, pending_zat: 0, swept_zat: 50000000, min_unspent_confirmations: 12 };
const PREPARED = {
  pczt: new Uint8Array(1),
  inspected: { outputs: [{ address: 'utest1orchardonly', zat: 1990000 }], feeZat: 10000, totalInZat: 2000000, txid: TXID },
  serverSummary: { inputs_zat: 2000000, output_zat: 1990000, fee_zat: 10000, expiry_height: 1_000_000, txid: TXID },
  recipient: WITHDRAW,
  ok: true,
};

let refresh: ReturnType<typeof vi.fn>;
function setup(o: { balance?: Balance | null; state?: string; stale?: boolean; mode?: 'group' | 'individual' } = {}) {
  const view = {
    state: o.state ?? 'open', stale: false, role: 'admin',
    balance: o.balance === null ? undefined : (o.balance ?? READY),
    participants: [SHARE_ZAT, SHARE_ZAT, SHARE_ZAT, 0].map((z, index) => ({ index, address: addr(index), payments: z ? [pay(z)] : [], status_facts: facts })),
  } as unknown as TabView;
  refresh = vi.fn();
  useTab.mockReturnValue({ view, blob: blobFor(o.mode ?? 'individual'), error: null, stale: o.stale ?? false, refresh });
  return render(<Admin session={session} />);
}

const withdrawButton = () => screen.getByRole('button', { name: /withdraw|available in|nothing to withdraw|preparing/i });

beforeEach(() => {
  useTab.mockReset();
  w.prepareWithdraw.mockReset();
  w.signAndBroadcast.mockReset();
  apiMock.sweepStatus.mockReset();
  apiMock.status.mockReset().mockResolvedValue({ block_interval_seconds: 75 });
  keys.adminLinks.mockReset().mockImplementation(async (_m: Uint8Array, _t: string, mode: string) =>
    ({ adminUrl: ADMIN_URL, participantUrls: mode === 'group' ? [G_URL] : P_URLS }));
  config.explorerTxUrl = null;
});
afterEach(cleanup);

describe('Admin withdraw button per gate', () => {
  it('ready', async () => {
    setup();
    await waitFor(() => expect(withdrawButton()).toHaveTextContent('Withdraw to my wallet'));
    expect(withdrawButton()).toBeEnabled();
  });

  it('nothing', () => {
    setup({ balance: { spendable_zat: 0, pending_zat: 0, swept_zat: 0, min_unspent_confirmations: null } });
    expect(withdrawButton()).toHaveTextContent('Nothing to withdraw yet');
    expect(withdrawButton()).toBeDisabled();
  });

  it('wait 3 (block interval from /status)', async () => {
    apiMock.status.mockResolvedValue({ block_interval_seconds: 75 });
    setup({ balance: { spendable_zat: 0, pending_zat: 5, swept_zat: 0, min_unspent_confirmations: 8 } });
    await waitFor(() => expect(withdrawButton()).toHaveTextContent('Available in ~3 min'));
    expect(withdrawButton()).toBeDisabled();
    expect(apiMock.status).toHaveBeenCalledTimes(1);
  });

  it('wait falls back to 75 s blocks when /status fails', async () => {
    apiMock.status.mockRejectedValue(new ApiRequestError(0, 'network', 'x'));
    setup({ balance: { spendable_zat: 0, pending_zat: 5, swept_zat: 0, min_unspent_confirmations: 8 } });
    expect(withdrawButton()).toHaveTextContent('Available in ~3 min');
    await waitFor(() => expect(apiMock.status).toHaveBeenCalled());
    expect(withdrawButton()).toHaveTextContent('Available in ~3 min');
  });

  it('sweeping', () => {
    setup({ state: 'sweeping' });
    expect(withdrawButton()).toHaveTextContent('Withdrawing…');
    expect(withdrawButton()).toBeDisabled();
  });

  it('unknown: no balance, or stale data', () => {
    setup({ balance: null });
    expect(withdrawButton()).toHaveTextContent('Withdraw to my wallet');
    expect(withdrawButton()).toBeDisabled();
    cleanup();
    setup({ stale: true });
    expect(withdrawButton()).toHaveTextContent('Withdraw to my wallet');
    expect(withdrawButton()).toBeDisabled();
  });
});

describe('Admin page', () => {
  it('shows the group list, balance card and admin link', async () => {
    setup();
    expect(screen.getByText('$37.50 of $50.00 collected · 3 of 4 paid')).toBeInTheDocument();
    expect(screen.getByText('Collected 0.9375 ZEC · Withdrawn 0.5 ZEC')).toBeInTheDocument();
    expect(screen.getByLabelText('Admin link')).toHaveValue(ADMIN_URL);
    expect(screen.getByText('Save this link now. It is the only key to the money. We cannot recover it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy admin link' })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Share link for Alice' });
  });

  it('per-row Share link with the Links-screen text', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { share, canShare: () => true }));
    try {
      setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Share link for Bob' }));
      expect(share).toHaveBeenCalledWith({
        title: 'Dinner',
        text: `Bob, your share of “Dinner” is $12.50 (≈ 0.3125 ZEC): ${P_URLS[1]}`,
        url: P_URLS[1],
      });
      expect(keys.adminLinks).toHaveBeenCalledWith(master, 't', 'individual', 4, window.location.origin);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('group mode: one Share link for everyone', async () => {
    setup({ mode: 'group' });
    expect(await screen.findByRole('button', { name: 'Share link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share link for/ })).toBeNull();
  });

  it('happy path: Preparing…, dialog, Withdrawing… txid, Withdrawn at 3 confirmations, refresh', async () => {
    config.explorerTxUrl = 'https://explorer.example/tx/{txid}';
    let resolve!: (p: typeof PREPARED) => void;
    w.prepareWithdraw.mockReturnValue(new Promise((r) => (resolve = r)));
    w.signAndBroadcast.mockResolvedValue({ txid: TXID });
    apiMock.sweepStatus
      .mockResolvedValueOnce({ state: 'sweeping', txid: TXID, mined_height: null, confirmations: 0, history: [] })
      .mockResolvedValue({ state: 'closed', txid: TXID, mined_height: 10, confirmations: 3, history: [] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Withdraw to my wallet' }));
      expect(withdrawButton()).toHaveTextContent('Preparing…');
      expect(withdrawButton()).toBeDisabled();
      expect(w.prepareWithdraw).toHaveBeenCalledWith(apiMock, session, WITHDRAW);
      await act(async () => resolve(PREPARED));
      expect(screen.getByRole('dialog')).toHaveTextContent('Send 0.0199 ZEC to utest1ar2v…gwc4d (your address) · fee 0.0001 ZEC');

      await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(await screen.findByText(/Withdrawing… txid 747c4880…/)).toBeInTheDocument();
      expect(w.signAndBroadcast).toHaveBeenCalledWith(apiMock, session, PREPARED, expect.any(Function));
      const link = screen.getByRole('link', { name: /explorer/i });
      expect(link).toHaveAttribute('href', `https://explorer.example/tx/${TXID}`);
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('target', '_blank');
      expect(apiMock.sweepStatus).toHaveBeenCalledWith('t', session.token);

      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(await screen.findByText('Withdrawn 0.0199 ZEC')).toBeInTheDocument();
      expect(refresh).toHaveBeenCalled();
      expect(document.body.textContent).not.toMatch(/\bclose\b/i);

      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(withdrawButton()).toHaveTextContent('Withdraw to my wallet');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the spend seed comes from the master', async () => {
    w.prepareWithdraw.mockResolvedValue(PREPARED);
    let seed: Uint8Array | undefined;
    w.signAndBroadcast.mockImplementation(async (_a, _s, _p, get: () => Promise<Uint8Array>) => {
      seed = await get();
      return { txid: TXID };
    });
    apiMock.sweepStatus.mockResolvedValue({ state: 'sweeping', txid: TXID, mined_height: null, confirmations: 0, history: [] });
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw to my wallet' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await screen.findByText(/Withdrawing… txid/);
    const { hkdf32, INFO } = await import('@ztab/crypto');
    expect(seed).toEqual(await hkdf32(master, 't', INFO.spend));
  });

  it.each([
    [new ApiRequestError(503, 'watcher_unavailable', 'upstream'), 'The network service is unavailable, try again in a minute.'],
    [new ApiRequestError(409, 'watcher_rejected', 'Nothing spendable yet: 2 notes are below 10 confirmations'), 'Nothing spendable yet: 2 notes are below 10 confirmations'],
    [new ApiRequestError(429, 'rate_limited', 'x'), 'Too many requests from your network, wait a minute.'],
  ])('prepare error %#', async (err, text) => {
    w.prepareWithdraw.mockRejectedValue(err);
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw to my wallet' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(withdrawButton()).toBeEnabled();
  });

  it('never says close', async () => {
    w.prepareWithdraw.mockResolvedValue(PREPARED);
    const r = setup();
    await screen.findByRole('button', { name: 'Share link for Alice' });
    expect(r.container.textContent).not.toMatch(/\bclose\b/i);
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw to my wallet' }));
    await screen.findByRole('dialog');
    expect(document.body.textContent).not.toMatch(/\bclose\b/i);
    for (const el of document.body.querySelectorAll('[aria-label],[title]')) {
      expect(`${el.getAttribute('aria-label')} ${el.getAttribute('title')}`).not.toMatch(/\bclose\b/i);
    }
  });
});
