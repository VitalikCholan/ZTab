import { useState } from 'react';
import { Amount } from '../components/Amount.tsx';
import { ErrorScreen } from '../components/ErrorScreen.tsx';
import { PayPanel } from '../components/PayPanel.tsx';
import { StaleBanner } from '../components/StaleBanner.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { centsToUsdString, zatToCents } from '../domain/money.ts';
import { computeStatus, type StatusResult } from '../domain/status.ts';
import { usePayBoost } from '../hooks/usePayBoost.ts';
import { useTab } from '../hooks/useTab.ts';
import { isTouchPhone } from '../platform.ts';
import { type ParticipantBlob } from '../tab/blobs.ts';
import type { Session } from '../tab/keys.ts';
import { PoweredByZcash } from '../components/PoweredByZcash.tsx';

function sentence(r: StatusResult, b: ParticipantBlob): string | null {
  const fiat = (zat: number) => zatToCents(zat, b.rate_usd_per_zec);
  if (r.badge === 'partial') {
    const paid = fiat(r.paidZat);
    return `Paid ${centsToUsdString(paid)} of ${centsToUsdString(b.share_cents)} · ${centsToUsdString(Math.max(0, b.share_cents - paid))} left`;
  }
  if (r.badge === 'overpaid') return `Paid · ${centsToUsdString(fiat(r.paidZat - b.share_zat))} over, thank you`;
  return null;
}

export function Participant({ session }: { session: Session }) {
  const [intervalMs, boost] = usePayBoost();
  const { view, blob, error, stale } = useTab(session, intervalMs);
  const [phone] = useState(isTouchPhone);

  if (error?.status === 404) return <ErrorScreen title="This tab does not exist or the link is wrong." />;
  if (error?.status === 429) return <ErrorScreen title="Too many requests from your network, wait a minute." />;
  if (error) return <ErrorScreen title="Something went wrong">{error.message}</ErrorScreen>;
  if (!view || !blob) return <p className="p-6">Loading…</p>;
  const b = blob as ParticipantBlob;
  const row =
    view.participants.find((p) => p.index === b.index) ??
    (view.participant_index === b.index ? view.participants[0] : undefined);

  const footer =
    b.mode === 'group'
      ? 'Payments are shielded. Everyone with the group link sees this status.'
      : 'Payments are shielded. Only you and the organizer see this page.';

  let body;
  if (!row) {
    body = <StatusBadge badge="unknown" />;
  } else if (b.address !== row.address) {
    body = (
      <div role="alert" className="rounded bg-red-100 p-4 text-red-900">
        <p className="font-bold">Address mismatch, do not pay</p>
      </div>
    );
  } else {
    const r = computeStatus(row, b.share_zat);
    const line = sentence(r, b);
    body = (
      <>
        <div className="flex flex-col gap-2">
          <StatusBadge badge={r.badge} />
          {line && <p>{line}</p>}
        </div>
        {(r.badge === 'waiting' || r.badge === 'partial') && (
          <PayPanel
            address={b.address}
            zat={r.remainingZat}
            message={`${b.title} — ${b.name}'s share`}
            mode={phone ? 'phone' : 'desktop'}
            onPayClicked={boost}
          />
        )}
      </>
    );
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 p-6 font-sans">
      {(stale || view.stale) && <StaleBanner />}
      <h1 className="text-2xl font-bold">{b.title}</h1>
      <p>Hi, {b.name}</p>
      <Amount cents={b.share_cents} zat={b.share_zat} />
      {body}
      <p className="text-sm text-neutral-600">{footer}</p>
      <PoweredByZcash />
    </main>
  );
}
