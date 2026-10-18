import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../src/api/client.ts';

const m = vi.hoisted(() => ({ rate: vi.fn(), createTab: vi.fn() }));
vi.mock('../../src/wasm.ts', () => ({ wasmState: () => 'ready', useWasmState: () => 'ready', ensureWasm: async () => {} }));
vi.mock('../../src/api/instance.ts', () => ({ api: { rate: m.rate } }));
vi.mock('../../src/tab/create.ts', async (orig) => ({ ...(await orig<object>()), createTab: m.createTab }));
vi.mock('@ztab/crypto', async (orig) => ({
  ...(await orig<object>()),
  validateRecipient: (_n: string, a: string) => {
    if (!a.startsWith('utest1')) throw new Error('bad');
  },
}));

import { CreateNetworkError } from '../../src/tab/create.ts';
import { NewTab } from '../../src/pages/NewTab.tsx';

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function mount() {
  const router = createMemoryRouter(
    [
      { path: '/new', element: <NewTab /> },
      { path: '/new/links', element: <Where /> },
      { path: '/', element: <Where /> },
    ],
    { initialEntries: ['/new'] },
  );
  return render(<RouterProvider router={router} />);
}

const create = () => screen.getByRole('button', { name: 'Create tab' });
const ADDR = 'utest1abc';

async function fillValid(u: ReturnType<typeof userEvent.setup>, shares = ['25.00', '25.00']) {
  await u.type(screen.getByLabelText('Tab name'), 'Dinner');
  await u.type(screen.getByLabelText('Total, USD'), '50.00');
  while (screen.queryAllByLabelText(/^Name \d+$/).length < shares.length) {
    await u.click(screen.getByRole('button', { name: 'Add participant' }));
  }
  for (let i = 0; i < shares.length; i++) {
    await u.type(screen.getByLabelText(`Name ${i + 1}`), `P${i + 1}`);
    await u.type(screen.getByLabelText(`Share USD ${i + 1}`), shares[i]);
  }
  await u.click(screen.getByLabelText(/Group/));
  await u.type(screen.getByLabelText('Your Zcash address for withdrawal'), ADDR);
  await u.tab();
}

beforeEach(() => {
  m.rate.mockReset().mockResolvedValue({ usd_per_zec: 40, fetched_at: '2026-10-18T10:05:00.000Z', source: 'coingecko' });
  m.createTab.mockReset();
});
afterEach(cleanup);

describe('NewTab', () => {
  it('Create disabled until every condition holds', async () => {
    const u = userEvent.setup();
    mount();
    expect(await screen.findByText(/1 ZEC = \$40/)).toBeInTheDocument();
    expect(create()).toBeDisabled();
    await u.type(screen.getByLabelText('Tab name'), 'Dinner');
    await u.type(screen.getByLabelText('Total, USD'), '50.00');
    expect(screen.getByText('≈ 1.2500 ZEC')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Name 1'), 'Ann');
    await u.type(screen.getByLabelText('Share USD 1'), '50.00');
    expect(create()).toBeDisabled(); // no mode, no address
    await u.click(screen.getByLabelText(/Individual/));
    expect(create()).toBeDisabled();
    await u.type(screen.getByLabelText('Your Zcash address for withdrawal'), ADDR);
    await u.tab();
    expect(create()).toBeEnabled();
  });

  it('one-cent mismatch disables Create', async () => {
    const u = userEvent.setup();
    mount();
    await screen.findByText(/1 ZEC = /);
    await fillValid(u, ['25.00', '24.99']);
    expect(screen.getByText(/\$0\.01 left/)).toBeInTheDocument();
    expect(create()).toBeDisabled();
    await u.clear(screen.getByLabelText('Share USD 2'));
    await u.type(screen.getByLabelText('Share USD 2'), '25.00');
    expect(create()).toBeEnabled();
  });

  it('shows the over amount', async () => {
    const u = userEvent.setup();
    mount();
    await u.type(screen.getByLabelText('Total, USD'), '50.00');
    await u.type(screen.getByLabelText('Share USD 1'), '55.00');
    expect(screen.getByText('Assigned $55.00 of $50.00 · $5.00 over')).toBeInTheDocument();
  });

  it('Split equally fills 16.68, 16.66, 16.66', async () => {
    const u = userEvent.setup();
    mount();
    await u.type(screen.getByLabelText('Total, USD'), '50.00');
    await u.click(screen.getByRole('button', { name: 'Add participant' }));
    await u.click(screen.getByRole('button', { name: 'Add participant' }));
    await u.click(screen.getByRole('button', { name: 'Split equally' }));
    expect([1, 2, 3].map((i) => (screen.getByLabelText(`Share USD ${i}`) as HTMLInputElement).value)).toEqual([
      '16.68',
      '16.66',
      '16.66',
    ]);
  });

  it('manual rate when /rate is 503', async () => {
    m.rate.mockRejectedValue(new ApiRequestError(503, 'rate_unavailable', 'x'));
    m.createTab.mockReturnValue(new Promise(() => {}));
    const u = userEvent.setup();
    mount();
    expect(await screen.findByText('Enter the rate manually')).toBeInTheDocument();
    await fillValid(u);
    expect(create()).toBeDisabled();
    await u.type(screen.getByLabelText(/^Rate/), '400');
    expect(create()).toBeEnabled();
    await u.click(create());
    expect(m.createTab).toHaveBeenCalledTimes(1);
    const input = m.createTab.mock.calls[0][0];
    expect(input).toMatchObject({ usdPerZec: 400, totalCents: 5000, mode: 'group', withdrawAddress: ADDR });
    expect(typeof input.rateAt).toBe('string');
    expect(await screen.findByText('Creating…')).toBeInTheDocument();
    expect(screen.getByLabelText('Tab name')).toBeDisabled();
  });

  it('invalid address shows the hint and disables Create', async () => {
    const u = userEvent.setup();
    mount();
    await screen.findByText(/1 ZEC = /);
    await fillValid(u);
    expect(create()).toBeEnabled();
    const a = screen.getByLabelText('Your Zcash address for withdrawal');
    await u.clear(a);
    await u.type(a, 'zs1bad');
    await u.tab();
    expect(screen.getByText(/Use a unified address with an Orchard receiver/)).toBeInTheDocument();
    expect(create()).toBeDisabled();
  });

  it('rejects the 81st character of the title', async () => {
    const u = userEvent.setup();
    mount();
    await u.type(screen.getByLabelText('Tab name'), 'a'.repeat(81));
    expect((screen.getByLabelText('Tab name') as HTMLInputElement).value).toHaveLength(80);
  });

  it('add is disabled at 20 participants, remove at 1', async () => {
    const u = userEvent.setup();
    mount();
    expect(screen.getByRole('button', { name: 'Remove participant 1' })).toBeDisabled();
    for (let i = 1; i < 20; i++) await u.click(screen.getByRole('button', { name: 'Add participant' }));
    expect(screen.getByRole('button', { name: 'Add participant' })).toBeDisabled();
    expect(screen.getAllByLabelText(/^Name \d+$/)).toHaveLength(20);
  });

  it('navigates to the links screen with the created tab in state', async () => {
    m.createTab.mockResolvedValue({ tabId: 't', adminUrl: 'u', participantLinks: [], master: new Uint8Array(32) });
    const u = userEvent.setup();
    mount();
    await screen.findByText(/1 ZEC = /);
    await fillValid(u);
    await u.click(create());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/new/links'));
  });

  it('network error: Retry calls retry(), not createTab; leaving abandons', async () => {
    const retry = vi.fn().mockResolvedValue({ tabId: 't', adminUrl: 'u', participantLinks: [], master: new Uint8Array(32) });
    const abandon = vi.fn();
    m.createTab.mockRejectedValue(
      new CreateNetworkError(new ApiRequestError(0, 'network', 'offline'), 't', retry, abandon),
    );
    const u = userEvent.setup();
    mount();
    await screen.findByText(/1 ZEC = /);
    await fillValid(u);
    await u.click(create());
    await u.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(m.createTab).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/new/links'));
    expect(abandon).not.toHaveBeenCalled();
  });

  it('network error then leaving calls abandon()', async () => {
    const abandon = vi.fn();
    m.createTab.mockRejectedValue(
      new CreateNetworkError(new ApiRequestError(0, 'network', 'offline'), 't', vi.fn(), abandon),
    );
    const u = userEvent.setup();
    const view = mount();
    await screen.findByText(/1 ZEC = /);
    await fillValid(u);
    await u.click(create());
    await screen.findByRole('button', { name: 'Retry' });
    view.unmount();
    await waitFor(() => expect(abandon).toHaveBeenCalledTimes(1));
  });

  it('API error shows the code and Retry calls createTab again', async () => {
    m.createTab.mockRejectedValueOnce(new ApiRequestError(429, 'rate_limited', 'slow')).mockReturnValue(new Promise(() => {}));
    const u = userEvent.setup();
    mount();
    await screen.findByText(/1 ZEC = /);
    await fillValid(u);
    await u.click(create());
    expect(await screen.findByText(/rate_limited/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Retry' }));
    expect(m.createTab).toHaveBeenCalledTimes(2);
  });
});
