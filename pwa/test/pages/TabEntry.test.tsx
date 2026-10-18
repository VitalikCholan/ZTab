import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { importBlobKey, sealBlob, toBase64Url } from '@ztab/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hex, hkdfFixture, json } from '../helpers/fixtures.ts';
import { toBase64 } from '../../src/tab/blobs.ts';

const wasm = vi.hoisted(() => ({ state: 'ready' as 'loading' | 'ready' | 'failed' }));
vi.mock('../../src/wasm.ts', () => ({
  wasmState: () => wasm.state,
  useWasmState: () => wasm.state,
  ensureWasm: async () => {},
}));

const { tabId } = hkdfFixture;
const keyBytes = hex(hkdfFixture.participantKeyHex['1']);
const PATH = `/t/${tabId}`;
const BLOB = {
  v: 1, title: 'Dinner', index: 1, name: 'Bob', share_cents: 2500, share_zat: 62111801,
  address: 'utest1b', rate_usd_per_zec: 40.25, mode: 'individual',
};

let blobB64: string;
let secure: PropertyDescriptor | undefined;

function view() {
  return {
    tab_id: tabId, mode: 'individual', participants_count: 2, state: 'open', stale: false,
    role: 'participant', participant_index: 1, blob: blobB64, participants: [],
  };
}

async function mount() {
  const { TabEntry } = await import('../../src/pages/TabEntry.tsx');
  const router = createMemoryRouter([{ path: '/t/:tabId', element: <TabEntry /> }], { initialEntries: [PATH] });
  return render(<RouterProvider router={router} />);
}

beforeEach(async () => {
  vi.resetModules();
  wasm.state = 'ready';
  document.title = 'ZTab';
  blobB64 = toBase64(await sealBlob(await importBlobKey(keyBytes), BLOB));
  vi.stubGlobal('fetch', vi.fn(async () => json(200, view())));
  window.history.replaceState(null, '', `${PATH}#p=1.${toBase64Url(keyBytes)}`);
  secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (secure) Object.defineProperty(window, 'isSecureContext', secure);
  else delete (window as { isSecureContext?: boolean }).isSecureContext;
});

describe('TabEntry', () => {
  it('stores the session from the fragment and clears the hash', async () => {
    await mount();
    expect(await screen.findByText(/participant/i)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    const { sessionStore } = await import('../../src/tab/session.ts');
    expect(sessionStore.get(tabId)?.role).toBe('participant');
  });

  it('reload after fragment removal keeps the key in memory', async () => {
    const first = await mount();
    await screen.findByText(/participant/i);
    first.unmount();
    expect(window.location.hash).toBe('');
    await mount();
    expect(await screen.findByText(/participant/i)).toBeInTheDocument();
    expect(screen.queryByText('This link is incomplete')).toBeNull();
  });

  it('a fresh module without a hash renders Incomplete', async () => {
    const first = await mount();
    await screen.findByText(/participant/i);
    first.unmount();
    vi.resetModules();
    await mount();
    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
  });

  it('a #x= fragment renders Incomplete and is removed', async () => {
    window.history.replaceState(null, '', `${PATH}#x=abc`);
    await mount();
    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(PATH);
  });

  it('no secure context renders the HTTPS screen', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    await mount();
    expect(await screen.findByText('Open this page over HTTPS')).toBeInTheDocument();
  });

  it('wasm loading and failed states', async () => {
    wasm.state = 'loading';
    const r = await mount();
    expect(await screen.findByText('Loading crypto module…')).toBeInTheDocument();
    r.unmount();
    wasm.state = 'failed';
    await mount();
    expect(await screen.findByText('Reload the page')).toBeInTheDocument();
  });

  it('404 renders the missing-tab screen, 429 the rate-limit screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: { code: 'not_found', message: 'x' } })));
    const r = await mount();
    expect(await screen.findByText('This tab does not exist or the link is wrong.')).toBeInTheDocument();
    r.unmount();
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { code: 'rate_limited', message: 'x' } })));
    window.history.replaceState(null, '', `${PATH}#p=1.${toBase64Url(keyBytes)}`);
    vi.resetModules();
    await mount();
    expect(await screen.findByText('Too many requests from your network, wait a minute.')).toBeInTheDocument();
  });

  it('a network failure keeps the view and shows the stale banner', async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, view())).mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', f);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mount();
      await screen.findByText(/participant/i);
      await vi.advanceTimersByTimeAsync(11000);
      await waitFor(() =>
        expect(screen.getByText('Live data is delayed; showing the last known status.')).toBeInTheDocument(),
      );
      expect(screen.getByText(/participant/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('any key derivation failure renders Incomplete and removes the hash', async () => {
    vi.doMock('../../src/tab/keys.ts', async (orig) => ({
      ...(await orig<typeof import('../../src/tab/keys.ts')>()),
      sessionFromFragment: async () => {
        throw new Error('boom');
      },
    }));
    try {
      await mount();
      expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
      expect(window.location.hash).toBe('');
    } finally {
      vi.doUnmock('../../src/tab/keys.ts');
    }
  });

  it('never changes document.title', async () => {
    await mount();
    await screen.findByText(/participant/i);
    expect(document.title).toBe('ZTab');
  });

  describe('polling after errors', () => {
    const e404 = () => json(404, { error: { code: 'not_found', message: 'x' } });
    const e429 = () => json(429, { error: { code: 'rate_limited', message: 'x' } });

    it('404 stops polling; 429 backs off to 60 s', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const f404 = vi.fn(async () => e404());
        vi.stubGlobal('fetch', f404);
        const r = await mount();
        await screen.findByText('This tab does not exist or the link is wrong.');
        await vi.advanceTimersByTimeAsync(60000);
        expect(f404).toHaveBeenCalledTimes(1);
        r.unmount();

        vi.resetModules();
        window.history.replaceState(null, '', `${PATH}#p=1.${toBase64Url(keyBytes)}`);
        const f429 = vi.fn(async () => e429());
        vi.stubGlobal('fetch', f429);
        await mount();
        await screen.findByText('Too many requests from your network, wait a minute.');
        await vi.advanceTimersByTimeAsync(50000);
        expect(f429).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(11000);
        expect(f429).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('useTab refresh', () => {
  it('refresh after a 404 issues a new fetch', async () => {
    const f = vi.fn(async () => json(404, { error: { code: 'not_found', message: 'x' } }));
    vi.stubGlobal('fetch', f);
    const { useTab } = await import('../../src/hooks/useTab.ts');
    const { sessionFromFragment } = await import('../../src/tab/keys.ts');
    const session = await sessionFromFragment(tabId, `p=1.${toBase64Url(keyBytes)}`, window.location.origin);
    const { renderHook, act } = await import('@testing-library/react');
    const { result } = renderHook(() => useTab(session, 10000));
    await waitFor(() => expect(result.current.error?.status).toBe(404));
    expect(f).toHaveBeenCalledTimes(1);
    await act(async () => result.current.refresh());
    expect(f).toHaveBeenCalledTimes(2);
  });
});
