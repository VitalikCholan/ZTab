import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { toBase64Url } from '@ztab/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Links, type LinksState } from '../../src/pages/Links.tsx';
import { sessionStore } from '../../src/tab/session.ts';

const TAB_ID = '11111111-2222-4333-8444-555555555555';
const master = () => new Uint8Array(32).fill(7);
const ORIGIN = window.location.origin;

function state(mode: 'group' | 'individual'): LinksState {
  return {
    created: {
      tabId: TAB_ID,
      adminUrl: `${ORIGIN}/t/${TAB_ID}#a=${toBase64Url(master())}`,
      participantLinks:
        mode === 'group'
          ? [{ index: -1, name: 'Everyone', url: `${ORIGIN}/t/${TAB_ID}#g=KEY` }]
          : [{ index: 0, name: 'Bob', url: `${ORIGIN}/t/${TAB_ID}#p=0.KEY` }],
      master: master(),
    },
    summary: { title: 'Dinner', usdPerZec: 400.5, participants: [{ name: 'Bob', shareCents: 1250 }] },
  };
}

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search + l.hash}</div>;
}

function mount(s?: LinksState) {
  const router = createMemoryRouter(
    [
      { path: '/new/links', element: <Links /> },
      { path: '/new', element: <Where /> },
      { path: '/t/:tabId', element: <Where /> },
    ],
    { initialEntries: [{ pathname: '/new/links', state: s }] },
  );
  return render(<RouterProvider router={router} />);
}

let writeText: ReturnType<typeof vi.fn>;
function setup() {
  const u = userEvent.setup(); // installs its own clipboard stub: override after
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return u;
}
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  sessionStore.clear(TAB_ID);
});

describe('Links', () => {
  it('redirects to /new without state', async () => {
    mount();
    expect(await screen.findByTestId('where')).toHaveTextContent('/new');
  });

  it('Continue is disabled until Copy is clicked, then reveals participant links', async () => {
    const u = setup();
    mount(state('individual'));
    expect(screen.getByText('Save this link now. It is the only key to the money. We cannot recover it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.queryByText('Participant links')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(state('individual').created.adminUrl);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(localStorage.getItem('ztab.adminWarningSeen')).toBe('1');
    expect(localStorage).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Participant links')).toBeInTheDocument();
  });

  it('Share falls back to the clipboard with the exact text, individual row', async () => {
    const u = setup();
    mount(state('individual'));
    await u.click(screen.getByRole('button', { name: 'Share admin link' }));
    expect(writeText).toHaveBeenLastCalledWith(
      `ZTab admin link for “Dinner” — keep it private: ${state('individual').created.adminUrl}`,
    );
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Bob · $12.50')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Share Bob' }));
    expect(writeText).toHaveBeenLastCalledWith(
      `Bob, your share of “Dinner” is $12.50 (≈ 0.0312 ZEC): ${ORIGIN}/t/${TAB_ID}#p=0.KEY`,
    );
  });

  it('uses navigator.share when available; group row text', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const u = setup();
    mount(state('group'));
    await u.click(screen.getByRole('button', { name: 'Copy' }));
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Everyone')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Share Everyone' }));
    expect(share).toHaveBeenCalledWith({
      title: 'Dinner',
      text: `Your share of “Dinner”: ${ORIGIN}/t/${TAB_ID}#g=KEY`,
      url: `${ORIGIN}/t/${TAB_ID}#g=KEY`,
    });
  });

  it('Open admin page stores a session and navigates without a fragment', async () => {
    const u = setup();
    const s = state('individual');
    mount(s);
    await u.click(screen.getByRole('button', { name: 'Copy' }));
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    await u.click(screen.getByRole('button', { name: 'Open admin page' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/t/${TAB_ID}`));
    expect(screen.getByTestId('where').textContent).not.toContain('#');
    expect(sessionStore.get(TAB_ID)?.role).toBe('admin');
    expect(Array.from(s.created.master).every((b) => b === 0)).toBe(true);
  });
});
