import { ErrorScreen } from '../components/ErrorScreen.tsx';
import { ParticipantList } from '../components/ParticipantList.tsx';
import { StaleBanner } from '../components/StaleBanner.tsx';
import { usePayBoost } from '../hooks/usePayBoost.ts';
import { useTab } from '../hooks/useTab.ts';
import type { GroupBlob } from '../tab/blobs.ts';
import type { Session } from '../tab/keys.ts';
import { PoweredByZcash } from '../components/PoweredByZcash.tsx';

export function Group({ session }: { session: Session }) {
  const [intervalMs, boost] = usePayBoost();
  const { view, blob, verified, error, stale } = useTab(session, intervalMs);

  if (error?.status === 404) return <ErrorScreen title="This tab does not exist or the link is wrong." />;
  if (error?.status === 429) return <ErrorScreen title="Too many requests from your network, wait a minute." />;
  if (error) return <ErrorScreen title="Something went wrong">{error.message}</ErrorScreen>;
  if (!view || !blob) return <p className="p-6 text-muted">Loading…</p>;
  const b = blob as GroupBlob;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6 font-sans">
      {(stale || view.stale) && <StaleBanner />}
      <h1 className="text-2xl font-bold text-fg">{b.title}</h1>
      <ParticipantList blob={b} view={view} onPay={boost} verified={verified} />
      <p className="text-sm text-muted">Payments are shielded. Everyone with the group link sees this status.</p>
      <PoweredByZcash />
    </main>
  );
}
