import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ErrorScreen } from '../components/ErrorScreen.tsx';
import { sessionFromFragment, type Session } from '../tab/keys.ts';
import { sessionStore } from '../tab/session.ts';
import { useWasmState } from '../wasm.ts';
import { Admin } from './Admin.tsx';
import { Group } from './Group.tsx';
import { Incomplete } from './Incomplete.tsx';
import { Participant } from './Participant.tsx';

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
    .catch(() => null) // any derivation failure reads as an unusable link
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
    resolveSession(tabId).then(
      (session) => alive && setResolved({ tabId, session }),
      () => alive && setResolved({ tabId, session: null }),
    );
    return () => {
      alive = false;
    };
  }, [tabId, secure]);

  if (!secure) return <ErrorScreen title="Open this page over HTTPS" />;
  if (wasm === 'failed') return <ErrorScreen title="Reload the page" />;
  if (wasm === 'loading') return <p className="p-6">Loading crypto module…</p>;
  if (!resolved || resolved.tabId !== tabId) return null;
  if (!resolved.session) return <Incomplete />;
  if (resolved.session.role === 'participant') return <Participant session={resolved.session} />;
  if (resolved.session.role === 'group') return <Group session={resolved.session} />;
  return <Admin session={resolved.session} />;
}
