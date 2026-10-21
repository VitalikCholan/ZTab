import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { CopyButton } from '../components/CopyButton.tsx';
import { ShareButton } from '../components/ShareButton.tsx';
import { centsToUsdString, centsToZat, zatToZecString } from '../domain/money.ts';
import { sessionFromFragment } from '../tab/keys.ts';
import { sessionStore } from '../tab/session.ts';
import type { CreatedTab } from '../tab/create.ts';
import { pendingCreated, type CreatedSummary } from '../tab/pending-created.ts';

export interface LinksState {
  created: CreatedTab;
  summary: CreatedSummary;
}

const FLAG = 'ztab.adminWarningSeen';

export function Links() {
  // Router state carries only the tab id (history.state is persisted); the links come from memory.
  const tabId = (useLocation().state as { tabId?: string } | null)?.tabId;
  const data = tabId ? pendingCreated.peek(tabId) : undefined;
  if (!data) return <Navigate to="/new" replace />;
  return <LinksScreen {...data} />;
}

function LinksScreen({ created, summary }: LinksState) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  const handedOver = useRef(false);

  // Zero the master when the admin leaves. Deferred a tick so StrictMode's simulated unmount
  // (which remounts at once) does not wipe a live screen.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current || handedOver.current) {
          created.master.fill(0);
          pendingCreated.discard(created.tabId);
        }
      }, 0);
    };
  }, [created]);

  const done = () => {
    setCopied(true);
    try {
      localStorage.setItem(FLAG, '1');
    } catch {
      // Storage may be blocked; the flag is a convenience only.
    }
  };

  const openAdmin = async () => {
    setOpening(true);
    const fragment = created.adminUrl.split('#')[1] ?? '';
    const session = await sessionFromFragment(created.tabId, fragment, window.location.origin);
    sessionStore.set(session);
    handedOver.current = true;
    created.master.fill(0);
    navigate(`/t/${created.tabId}`);
  };

  const { title } = summary;
  const textFor = (index: number, name: string, url: string) => {
    if (index < 0) return `Your share of “${title}”: ${url}`;
    const p = summary.participants[index];
    const zec = zatToZecString(centsToZat(p.shareCents, summary.usdPerZec));
    return `${name}, your share of “${title}” is ${centsToUsdString(p.shareCents)} (≈ ${zec} ZEC): ${url}`;
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 py-6 font-sans">
      <h1 className="text-2xl font-bold">Tab created</h1>
      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Your admin link</h2>
        <p className="font-medium text-red-700">Save this link now. It is the only key to the money. We cannot recover it.</p>
        <input
          readOnly
          aria-label="Admin link"
          value={created.adminUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="rounded border border-neutral-400 p-3 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={created.adminUrl} onDone={done} />
          <ShareButton
            title={title}
            text={`ZTab admin link for “${title}” — keep it private: ${created.adminUrl}`}
            url={created.adminUrl}
            label="Share admin link"
            onDone={done}
          />
        </div>
        {!revealed && (
          <button
            type="button"
            disabled={!copied}
            onClick={() => setRevealed(true)}
            className="rounded bg-neutral-900 px-4 py-3 font-medium text-white disabled:opacity-40"
          >
            Continue
          </button>
        )}
      </section>
      {revealed && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">Participant links</h2>
            {created.participantLinks.map((l) => (
              <div key={l.index} className="flex items-center justify-between gap-2 rounded border border-neutral-300 p-3">
                <span className="min-w-0 break-words">
                  {l.index < 0
                    ? l.name
                    : `${l.name} · ${centsToUsdString(summary.participants[l.index].shareCents)}`}
                </span>
                <ShareButton title={title} text={textFor(l.index, l.name, l.url)} url={l.url} label={`Share ${l.name}`} failText="Copy failed" />
              </div>
            ))}
          </section>
          <button
            type="button"
            disabled={opening}
            onClick={() => void openAdmin()}
            className="rounded bg-neutral-900 px-4 py-3 font-medium text-white disabled:opacity-40"
          >
            Open admin page
          </button>
        </>
      )}
    </main>
  );
}
