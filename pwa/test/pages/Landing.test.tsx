import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../helpers/fixtures.ts';
import { Landing } from '../../src/pages/Landing.tsx';
import { config } from '../../src/config.ts';

afterEach(() => {
  config.network = 'test';
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <Landing /> }])} />);
}

describe('Landing', () => {
  it('shows a synced testnet badge, the create link and the faucet link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'test', watcher: 'ok' })));
    mount();
    expect(await screen.findByText('Testnet · synced')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a tab' })).toHaveAttribute('href', '/new');
    const faucet = screen.getByRole('link', { name: 'Get free testnet ZEC (TAZ)' });
    expect(faucet).toHaveAttribute('href', 'https://fauzec.com');
    expect(faucet).toHaveAttribute('rel', 'noopener noreferrer');
    expect(faucet).toHaveAttribute('target', '_blank');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('has no faucet link on mainnet', async () => {
    config.network = 'main';
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'main', watcher: 'ok' })));
    mount();
    expect(await screen.findByText('Mainnet · synced')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /testnet ZEC/ })).toBeNull();
  });

  it('shows syncing when the watcher is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'test', watcher: 'stale' })));
    mount();
    expect(await screen.findByText('Testnet · syncing…')).toBeInTheDocument();
  });
});
