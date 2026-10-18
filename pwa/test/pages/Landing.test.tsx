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
  it('shows a synced testnet badge and the links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'test', watcher: 'ok' })));
    mount();
    expect(await screen.findByText('Testnet · synced')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a tab' })).toHaveAttribute('href', '/new');
    const gh = screen.getByRole('link', { name: 'GitHub' });
    expect(gh).toHaveAttribute('href', 'https://github.com/VitalikCholan/ZTab');
    expect(gh).toHaveAttribute('rel', 'noopener noreferrer');
    expect(gh).toHaveAttribute('target', '_blank');
  });

  it('shows syncing when the watcher is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { network: 'test', watcher: 'stale' })));
    mount();
    expect(await screen.findByText('Testnet · syncing…')).toBeInTheDocument();
  });
});
