import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../helpers/fixtures.ts';
import { Landing } from '../../src/pages/Landing.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <Landing /> }])} />);
}

describe('Landing', () => {
  it('shows a synced testnet badge and only the create link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'test', watcher: 'ok' })));
    mount();
    expect(await screen.findByText('Testnet · synced')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a tab' })).toHaveAttribute('href', '/new');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('shows syncing when the watcher is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'test', watcher: 'stale' })));
    mount();
    expect(await screen.findByText('Testnet · syncing…')).toBeInTheDocument();
  });
});
