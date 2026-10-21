import { CryptoError, hkdf32, INFO } from '@ztab/crypto';
import { useEffect, useState } from 'react';
import { api } from '../api/instance.ts';
import { BalanceCard } from '../components/BalanceCard.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { ErrorScreen } from '../components/ErrorScreen.tsx';
import { collectedZat, ParticipantList, rowStatuses } from '../components/ParticipantList.tsx';
import { ShareButton } from '../components/ShareButton.tsx';
import { StaleBanner } from '../components/StaleBanner.tsx';
import { WithdrawDialog, withdrawErrorText } from '../components/WithdrawDialog.tsx';
import { centsToUsdString, zatToZecString } from '../domain/money.ts';
import { withdrawGate, type WithdrawGate } from '../domain/withdraw-gate.ts';
import { usePayBoost } from '../hooks/usePayBoost.ts';
import { useTab } from '../hooks/useTab.ts';
import type { AdminBlob } from '../tab/blobs.ts';
import { adminLinks, type Session } from '../tab/keys.ts';
import { prepareWithdraw, signAndBroadcast, type PreparedWithdraw } from '../tab/withdraw.ts';

const FALLBACK_BLOCK_SECONDS = 75;

const GATE_LABEL = (g: WithdrawGate): string => {
  if (g.kind === 'nothing') return 'Nothing to withdraw yet';
  if (g.kind === 'wait') return `Available in ~${g.minutes} min`;
  if (g.kind === 'sweeping') return 'Withdrawing…';
  return 'Withdraw to my wallet';
};

/** The block interval for the wait estimate, fetched once; the fallback stands if /status fails. */
function useBlockInterval(): number {
  const [seconds, setSeconds] = useState(FALLBACK_BLOCK_SECONDS);
  useEffect(() => {
    let alive = true;
    api.status().then(
      (s) => alive && s.block_interval_seconds > 0 && setSeconds(s.block_interval_seconds),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return seconds;
}

/** Participant (or group) links re-derived from the master. Only the URL strings are kept. */
function useParticipantUrls(session: Session, blob: AdminBlob | null): string[] | null {
  const [urls, setUrls] = useState<string[] | null>(null);
  const mode = blob?.mode;
  const n = blob?.participants.length;
  useEffect(() => {
    if (!session.master || !mode || !n) return;
    let alive = true;
    adminLinks(session.master, session.tabId, mode, n, window.location.origin).then(
      (l) => alive && setUrls(l.participantUrls),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [session, mode, n]);
  return urls;
}

export function Admin({ session }: { session: Session }) {
  const [intervalMs, boost] = usePayBoost();
  const { view, blob, error, stale, refresh } = useTab(session, intervalMs);
  const blockSeconds = useBlockInterval();
  const b = blob as AdminBlob | null;
  const urls = useParticipantUrls(session, b);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<PreparedWithdraw | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  if (error?.status === 404) return <ErrorScreen title="This tab does not exist or the link is wrong." />;
  if (error?.status === 429) return <ErrorScreen title="Too many requests from your network, wait a minute." />;
  if (error) return <ErrorScreen title="Something went wrong">{error.message}</ErrorScreen>;
  if (!view || !b) return <p className="p-6">Loading…</p>;

  const isStale = stale || view.stale;
  // Stale balance facts must not enable a withdrawal.
  const gate: WithdrawGate = isStale && view.state !== 'sweeping' ? { kind: 'unknown' } : withdrawGate(view.balance, blockSeconds, view.state);

  const startWithdraw = async () => {
    setPreparing(true);
    setPrepareError(null);
    try {
      setPrepared(await prepareWithdraw(api, session, b.withdraw_address));
    } catch (e) {
      setPrepareError(withdrawErrorText(e));
    } finally {
      setPreparing(false);
    }
  };

  const getSpendSeed = () => {
    if (!session.master) return Promise.reject(new CryptoError('internal', 'no admin key in memory'));
    return hkdf32(session.master, session.tabId, INFO.spend);
  };

  const shareText = (name: string, cents: number, zat: number, url: string) =>
    `${name}, your share of “${b.title}” is ${centsToUsdString(cents)} (≈ ${zatToZecString(zat)} ZEC): ${url}`;

  const footer =
    b.mode === 'group'
      ? 'Payments are shielded. Everyone with the group link sees this status.'
      : 'Payments are shielded. Each participant sees only their own status.';

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6 font-sans">
      {isStale && <StaleBanner />}
      <h1 className="text-2xl font-bold">{b.title}</h1>
      <BalanceCard collectedZat={collectedZat(rowStatuses(b, view))} sweptZat={view.balance?.swept_zat ?? 0} />
      <button
        type="button"
        disabled={gate.kind !== 'ready' || preparing || prepared !== null}
        onClick={() => void startWithdraw()}
        className="rounded bg-neutral-900 px-4 py-4 text-lg font-semibold text-white disabled:opacity-40"
      >
        {preparing ? 'Preparing…' : GATE_LABEL(gate)}
      </button>
      {prepareError && (
        <p role="alert" className="font-medium text-red-700">
          {prepareError}
        </p>
      )}
      {b.mode === 'group' && urls?.[0] && (
        <ShareButton title={b.title} text={`Your share of “${b.title}”: ${urls[0]}`} url={urls[0]} label="Share link" failText="Copy failed" />
      )}
      <ParticipantList
        blob={b}
        view={view}
        onPay={boost}
        share={
          b.mode === 'individual'
            ? (p) => {
                const url = urls?.[p.index];
                return url ? (
                  <ShareButton
                    title={b.title}
                    text={shareText(p.name, p.share_cents, p.share_zat, url)}
                    url={url}
                    label={`Share link for ${p.name}`}
                    failText="Copy failed"
                  />
                ) : null;
              }
            : undefined
        }
      />
      <p className="text-sm text-neutral-600">{footer}</p>
      <section className="flex flex-col gap-2 border-t border-neutral-300 pt-4">
        <h2 className="text-sm font-medium">Admin link</h2>
        <p className="text-sm font-medium text-red-700">Save this link now. It is the only key to the money. We cannot recover it.</p>
        <input
          readOnly
          aria-label="Admin link"
          value={session.fullUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="rounded border border-neutral-400 p-2 font-mono text-xs"
        />
        <div>
          <CopyButton text={session.fullUrl} label="Copy admin link" />
        </div>
      </section>
      {prepared && (
        <WithdrawDialog
          prepared={prepared}
          onConfirm={() => signAndBroadcast(api, session, prepared, getSpendSeed)}
          sweepStatus={() => api.sweepStatus(session.tabId, session.token)}
          onWithdrawn={refresh}
          onClose={() => setPrepared(null)}
        />
      )}
    </main>
  );
}
