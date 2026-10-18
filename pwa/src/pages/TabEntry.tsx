import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { CryptoError } from '@ztab/crypto';
import { ErrorScreen } from '../components/ErrorScreen.tsx';
import { StaleBanner } from '../components/StaleBanner.tsx';
import { useTab } from '../hooks/useTab.ts';
import { sessionFromFragment, type Session } from '../tab/keys.ts';
import { sessionStore } from '../tab/session.ts';
import { useWasmState } from '../wasm.ts';
import { Incomplete } from './Incomplete.tsx';

const POLL_MS = 10_000;

// In-flight resolutions per tab: the hash is read (and removed) exactly once even if the
// effect runs twice (StrictMode) before the async key derivation finishes.
const inflight = new Map<string, Promise<Session | null>>();

function resolveSession(tabId: string): Promise<Session | null> {
  const stored = sessionStore.get(tabId);
  if (stored) return Promise.resolve(stored);
  const pending = inflight.get(tabId);
  if (pending) return pending;

  const hash = window.location.hash.replace(/^#/, '');
  // The fragment must leave the address bar whether or not it parses.
  window.history.replaceState(null, '', window.location.pathname);
  if (hash === '') return Promise.resolve(null);

  const p = sessionFromFragment(tabId, hash, window.location.origin)
    .then((s) => {
      sessionStore.set(s);
      return s;
    })
    .catch((e: unknown) => {
      if (e instanceof CryptoError) return null;
      throw e;
    })
    .finally(() => inflight.delete(tabId));
  inflight.set(tabId, p);
  return p;
}

type Resolved = { tabId: string; session: Session | null };

export function TabEntry() {
  const { tabId = '' } = useParams();
  const wasm = useWasmState();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const secure = window.isSecureContext;

  useEffect(() => {
    if (!secure) return;
    let alive = true;
    resolveSession(tabId).then((session) => alive && setResolved({ tabId, session }));
    return () => {
      alive = false;
    };
  }, [tabId, secure]);

  if (!secure) return <ErrorScreen title="Open this page over HTTPS" />;
  if (wasm === 'failed') return <ErrorScreen title="Reload the page" />;
  if (wasm === 'loading') return <p className="p-6">Loading crypto module…</p>;
  if (!resolved || resolved.tabId !== tabId) return null;
  if (!resolved.session) return <Incomplete />;
  return <TabRole session={resolved.session} />;
}

// Placeholder per role until Tasks 7-9 add the real pages.
function TabRole({ session }: { session: Session }) {
  const { view, error, stale } = useTab(session, POLL_MS);
  if (error?.status === 404) return <ErrorScreen title="This tab does not exist or the link is wrong." />;
  if (error?.status === 429) return <ErrorScreen title="Too many requests from your network, wait a minute." />;
  if (error) return <ErrorScreen title="Something went wrong">{error.message}</ErrorScreen>;
  return (
    <main className="mx-auto max-w-md p-6 font-sans">
      {stale && <StaleBanner />}
      <p>{session.role}</p>
      <p>{session.tabId}</p>
      {view === null && <p>Loading…</p>}
    </main>
  );
}
