import { useState, type ReactNode } from 'react';
import type { TabView } from '../api/types.ts';
import { centsToUsdString, zatToCents } from '../domain/money.ts';
import { computeStatus, type Badge, type StatusResult } from '../domain/status.ts';
import { isTouchPhone } from '../platform.ts';
import type { BlobParticipant, GroupBlob } from '../tab/blobs.ts';
import { Amount } from './Amount.tsx';
import { PayPanel } from './PayPanel.tsx';
import { StatusBadge } from './StatusBadge.tsx';

export interface RowStatus {
  participant: BlobParticipant;
  /** null: the API row is missing or pays a different address than the blob says. */
  status: StatusResult | null;
  /** The API row's address differs from the encrypted blob's: never offer to pay it. */
  mismatch: boolean;
}

const PAID: ReadonlySet<Badge> = new Set(['paid', 'paid_transparent', 'overpaid']);

/** Per-participant status from the blob (truth for names, shares, addresses) and the API view. */
export function rowStatuses(blob: GroupBlob, view: TabView, verified = true): RowStatus[] {
  return blob.participants.map((participant) => {
    if (!verified) return { participant, status: null, mismatch: true };
    const row = view.participants.find((p) => p.index === participant.index);
    if (!row) return { participant, status: null, mismatch: false };
    if (row.address !== participant.address) return { participant, status: null, mismatch: true };
    return { participant, status: computeStatus(row, participant.share_zat), mismatch: false };
  });
}

/** Sum of confirmed payments in zatoshi. */
export const collectedZat = (rows: RowStatus[]) => rows.reduce((a, r) => a + (r.status?.paidZat ?? 0), 0);

// Literal class names so Tailwind's scanner generates them (CSP forbids style=).
const WIDTH_STEPS = [
  'w-[0%]', 'w-[5%]', 'w-[10%]', 'w-[15%]', 'w-[20%]', 'w-[25%]', 'w-[30%]', 'w-[35%]', 'w-[40%]', 'w-[45%]',
  'w-[50%]', 'w-[55%]', 'w-[60%]', 'w-[65%]', 'w-[70%]', 'w-[75%]', 'w-[80%]', 'w-[85%]', 'w-[90%]', 'w-[95%]',
  'w-[100%]',
] as const;

/** Width class in 5 % steps, rounded down; any collected amount shows at least one step. */
function widthClass(collectedCents: number, totalCents: number): string {
  if (totalCents <= 0 || collectedCents <= 0) return WIDTH_STEPS[0];
  const step = Math.floor((Math.min(collectedCents, totalCents) * 20) / totalCents);
  return WIDTH_STEPS[Math.max(1, step)]!;
}

export function ParticipantList({
  blob,
  view,
  onPay,
  share,
  verified = true,
}: {
  blob: GroupBlob;
  view: TabView;
  /** Called when someone starts paying (opens the wallet or copies the details). */
  onPay: () => void;
  /** Extra per-row control (the admin's Share link). */
  share?: (p: BlobParticipant) => ReactNode;
  /** False: the blob does not match the link; every row is a mismatch. */
  verified?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [phone] = useState(isTouchPhone);
  const rows = rowStatuses(blob, view, verified);
  const collectedCents = rows.reduce((a, r) => a + zatToCents(r.status?.paidZat ?? 0, blob.rate_usd_per_zec), 0);
  const paid = rows.filter((r) => r.status && PAID.has(r.status.badge)).length;

  return (
    <section className="flex flex-col gap-4">
      <p className="font-medium">
        {`${centsToUsdString(collectedCents)} of ${centsToUsdString(blob.total_cents)} collected · ${paid} of ${rows.length} paid`}
      </p>
      <div
        role="progressbar"
        aria-label="Collected"
        aria-valuemin={0}
        aria-valuemax={blob.total_cents}
        aria-valuenow={Math.min(collectedCents, blob.total_cents)}
        className="h-2 overflow-hidden rounded-full bg-surface"
      >
        <div
          className={`h-full rounded-full bg-gradient-to-r from-accent to-accent-deep motion-safe:transition-all ${widthClass(collectedCents, blob.total_cents)}`}
        />
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map(({ participant: p, status, mismatch }) => {
          const payable = status !== null && (status.badge === 'waiting' || status.badge === 'partial');
          return (
            <li key={p.index} className="card flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words font-medium">{p.name}</span>
                {mismatch ? (
                  <span role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1 text-sm font-bold text-danger">
                    Address mismatch, do not pay
                  </span>
                ) : (
                  <StatusBadge badge={status?.badge ?? 'unknown'} />
                )}
              </div>
              <Amount cents={p.share_cents} zat={p.share_zat} />
              <div className="flex flex-wrap items-center gap-2">
                {payable && (
                  <button
                    type="button"
                    aria-label={`Pay for ${p.name}`}
                    aria-expanded={open === p.index}
                    onClick={() => setOpen(open === p.index ? null : p.index)}
                    className="btn-secondary"
                  >
                    Pay
                  </button>
                )}
                {share?.(p)}
              </div>
              {payable && open === p.index && (
                <PayPanel
                  address={p.address}
                  zat={status.remainingZat}
                  message={`${blob.title} — ${p.name}'s share`}
                  mode={phone ? 'phone' : 'desktop'}
                  onPayClicked={onPay}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
