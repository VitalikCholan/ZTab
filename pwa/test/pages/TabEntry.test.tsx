import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { blobCommit, encodeFragment, importBlobKey, sealBlob, toBase64Url } from '@ztab/crypto';
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
let P_HASH: string;
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
  P_HASH = encodeFragment({ kind: 'participant', index: 1, key: keyBytes, commit: await blobCommit(BLOB) });
  blobB64 = toBase64(await sealBlob(await importBlobKey(keyBytes), BLOB));
  vi.stubGlobal('fetch', vi.fn(async () => json(200, view())));
  window.history.replaceState(null, '', `${PATH}${P_HASH}`);
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
    expect(await screen.findByText('Hi, Bob')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    const { sessionStore } = await import('../../src/tab/session.ts');
    expect(sessionStore.get(tabId)?.role).toBe('participant');
  });

  it('reload after fragment removal keeps the key in memory', async () => {
    const first = await mount();
    await screen.findByText('Hi, Bob');
    first.unmount();
    expect(window.location.hash).toBe('');
    await mount();
    expect(await screen.findByText('Hi, Bob')).toBeInTheDocument();
    expect(screen.queryByText('This link is incomplete')).toBeNull();
  });

  it('a fresh module without a hash renders Incomplete', async () => {
    const first = await mount();
    await screen.findByText('Hi, Bob');
    first.unmount();
    vi.resetModules();
    await mount();
    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
  });

  it('old-format link without commitment shows the incomplete-link screen', async () => {
    window.history.replaceState(null, '', `${PATH}#p=1.${toBase64Url(keyBytes)}`);
    await mount();
    expect(await screen.findByText('This link is incomplete')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('a blob that does not match the link commitment shows the mismatch and no Pay', async () => {
    const forged = { ...BLOB, address: 'utest1evil' };
    blobB64 = toBase64(await sealBlob(await importBlobKey(keyBytes), forged));
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { ...view(), participants: [{ index: 1, address: 'utest1evil', payments: [], status_facts: null }] })));
    await mount();
    expect(await screen.findByText('Address mismatch, do not pay')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay with your wallet' })).toBeNull();
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
    window.history.replaceState(null, '', `${PATH}${P_HASH}`);
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
      await screen.findByText('Hi, Bob');
      await vi.advanceTimersByTimeAsync(11000);
      await waitFor(() =>
        expect(screen.getByText('Live data is delayed; showing the last known status.')).toBeInTheDocument(),
      );
      expect(screen.getByText('Hi, Bob')).toBeInTheDocument();
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
    await screen.findByText('Hi, Bob');
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
        window.history.replaceState(null, '', `${PATH}${P_HASH}`);
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

describe('a link pasted into the open tab (same-document fragment navigation)', () => {
  const ADMIN_HASH = `#a=${toBase64Url(hex(hkdfFixture.masterHex))}`;

  async function mountAdmin() {
    window.history.replaceState(null, '', `${PATH}${ADMIN_HASH}`);
    await mount();
    const { sessionStore } = await import('../../src/tab/session.ts');
    await waitFor(() => expect(sessionStore.get(tabId)?.role).toBe('admin'));
    expect(window.location.hash).toBe('');
    return { sessionStore, admin: sessionStore.get(tabId)! };
  }

  const paste = (hash: string) => {
    window.history.replaceState(null, '', `${PATH}${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  it('the new hash wins over the stored session, which is zeroed', async () => {
    const { sessionStore, admin } = await mountAdmin();
    const adminToken = admin.token;
    paste(P_HASH);
    expect(await screen.findByText('Hi, Bob')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(sessionStore.get(tabId)?.role).toBe('participant');
    expect(adminToken.every((b) => b === 0)).toBe(true);
    expect(admin.master!.every((b) => b === 0)).toBe(true);
  });

  it('a hash that does not parse is stripped and the current session stays', async () => {
    const { sessionStore, admin } = await mountAdmin();
    paste('#x=abc');
    await waitFor(() => expect(window.location.hash).toBe(''));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('This link is incomplete')).toBeNull();
    expect(sessionStore.get(tabId)).toBe(admin);
    expect(admin.token.some((b) => b !== 0)).toBe(true);
  });
});

describe('useTab refresh', () => {
  it('refresh after a 404 issues a new fetch', async () => {
    const f = vi.fn(async () => json(404, { error: { code: 'not_found', message: 'x' } }));
    vi.stubGlobal('fetch', f);
    const { useTab } = await import('../../src/hooks/useTab.ts');
    const { sessionFromFragment } = await import('../../src/tab/keys.ts');
    const session = await sessionFromFragment(tabId, P_HASH, window.location.origin);
    const { renderHook, act } = await import('@testing-library/react');
    const { result } = renderHook(() => useTab(session, 10000));
    await waitFor(() => expect(result.current.error?.status).toBe(404));
    expect(f).toHaveBeenCalledTimes(1);
    await act(async () => result.current.refresh());
    expect(f).toHaveBeenCalledTimes(2);
  });
});
