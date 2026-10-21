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

/**
 * A fragment in the address bar always wins over the stored session: a link pasted into this
 * same tab (a same-document fragment navigation) switches to that link's role. A fragment that
 * does not parse is still removed; it keeps the current session (or, with none, reads as an
 * incomplete link), so a mistyped paste never logs the user out.
 */
function resolveSession(tabId: string): Promise<Session | null> {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === '') return inflight.get(tabId) ?? Promise.resolve(sessionStore.get(tabId) ?? null);

  // The fragment must leave the address bar whether or not it parses.
  window.history.replaceState(null, '', window.location.pathname);
  const p = sessionFromFragment(tabId, hash, window.location.origin)
    .then((s) => {
      sessionStore.set(s); // zeroes the session it replaces
      return s;
    })
    .catch(() => sessionStore.get(tabId) ?? null) // any derivation failure reads as an unusable link
    .finally(() => {
      if (inflight.get(tabId) === p) inflight.delete(tabId);
    });
  inflight.set(tabId, p);
  return p;
}

type Resolved = { tabId: string; session: Session | null; /** Changes with the session: remounts the page. */ gen: number };

export function TabEntry() {
  const { tabId = '' } = useParams();
  const wasm = useWasmState();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [pastes, setPastes] = useState(0);
  const secure = window.isSecureContext;

  useEffect(() => {
    const onHashChange = () => setPastes((n) => n + 1);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!secure) return;
    let alive = true;
    const show = (session: Session | null) =>
      alive &&
      setResolved((prev) =>
        prev && prev.tabId === tabId && prev.session === session ? prev : { tabId, session, gen: (prev?.gen ?? 0) + 1 },
      );
    resolveSession(tabId).then(show, () => show(null));
    return () => {
      alive = false;
    };
  }, [tabId, secure, pastes]);

  if (!secure) return <ErrorScreen title="Open this page over HTTPS" />;
  if (wasm === 'failed') return <ErrorScreen title="Reload the page" />;
  if (wasm === 'loading') return <p className="p-6">Loading crypto module…</p>;
  if (!resolved || resolved.tabId !== tabId) return null;
  if (!resolved.session) return <Incomplete />;
  const { session, gen } = resolved;
  if (session.role === 'participant') return <Participant key={gen} session={session} />;
  if (session.role === 'group') return <Group key={gen} session={session} />;
  return <Admin key={gen} session={session} />;
}
