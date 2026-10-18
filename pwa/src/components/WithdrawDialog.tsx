import { CryptoError } from '@ztab/crypto';
import { useState } from 'react';
import { ApiRequestError } from '../api/client.ts';
import type { SweepStatus } from '../api/types.ts';
import { config } from '../config.ts';
import { zatToZecString } from '../domain/money.ts';
import { usePolling } from '../hooks/usePolling.ts';
import type { PreparedWithdraw } from '../tab/withdraw.ts';

const STATUS_POLL_MS = 10_000;
/** Spec: the sweep reads as done at 3 confirmations. */
const WITHDRAWN_CONFIRMATIONS = 3;

/** User-facing text for a failed sweep, broadcast or signing step. */
export function withdrawErrorText(e: unknown): string {
  if (e instanceof CryptoError) return `Signing failed: ${e.code}`;
  if (e instanceof ApiRequestError) {
    if (e.status === 429) return 'Too many requests from your network, wait a minute.';
    if (e.status === 503 || e.code === 'watcher_unavailable') return 'The network service is unavailable, try again in a minute.';
    if (e.status === 409) return e.message;
  }
  return 'Something went wrong, try again in a minute.';
}

export const shortAddress = (a: string) => (a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-5)}` : a);

function explorerUrl(txid: string): string | null {
  const t = config.explorerTxUrl;
  if (!t) return null;
  const id = encodeURIComponent(txid);
  return t.includes('{txid}') ? t.replaceAll('{txid}', id) : `${t}${id}`;
}

/** Confirmations of `txid` from the sweep status, whether it is the current sweep or in history. */
function confirmationsOf(s: SweepStatus, txid: string): number {
  if (s.txid === txid) return s.confirmations;
  return s.history.find((h) => h.txid === txid)?.confirmations ?? 0;
}

type Stage =
  | { kind: 'confirm' }
  | { kind: 'signing' }
  | { kind: 'broadcast'; txid: string }
  | { kind: 'withdrawn'; txid: string }
  | { kind: 'error'; text: string };

/**
 * confirm → signing → broadcast → withdrawn | error. Every number shown comes from the PCZT the
 * browser inspected; the server's own figure is shown apart, never instead.
 */
export function WithdrawDialog({
  prepared,
  onConfirm,
  sweepStatus,
  onWithdrawn,
  onClose,
}: {
  prepared: PreparedWithdraw;
  /** Signs and broadcasts; only called when `prepared.ok`. */
  onConfirm: () => Promise<{ txid: string }>;
  sweepStatus: () => Promise<SweepStatus>;
  onWithdrawn?: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'confirm' });
  const zat = prepared.inspected.outputs.reduce((a, o) => a + o.zat, 0);
  const zec = zatToZecString(zat);
  const txid = stage.kind === 'broadcast' ? stage.txid : null;

  usePolling(
    async () => {
      if (!txid) return;
      const s = await sweepStatus();
      if (confirmationsOf(s, txid) >= WITHDRAWN_CONFIRMATIONS) {
        setStage({ kind: 'withdrawn', txid });
        onWithdrawn?.();
      }
    },
    STATUS_POLL_MS,
    txid !== null,
  );

  const confirm = async () => {
    if (!prepared.ok || stage.kind !== 'confirm') return;
    setStage({ kind: 'signing' });
    try {
      const r = await onConfirm();
      setStage({ kind: 'broadcast', txid: r.txid });
    } catch (e) {
      setStage({ kind: 'error', text: withdrawErrorText(e) });
    }
  };

  let body;
  if (stage.kind === 'confirm' || stage.kind === 'signing') {
    body = (
      <>
        <p>
          Send <strong>{zec} ZEC</strong> to{' '}
          <span title={prepared.recipient} className="font-mono">
            {shortAddress(prepared.recipient)}
          </span>{' '}
          (your address) · fee {zatToZecString(prepared.inspected.feeZat)} ZEC
        </p>
        <details>
          <summary className="cursor-pointer text-sm">Full address</summary>
          <p className="break-all font-mono text-xs">{prepared.recipient}</p>
        </details>
        <p className="text-sm text-neutral-600">Server says: {zatToZecString(prepared.serverSummary.output_zat)} ZEC</p>
        {!prepared.ok && (
          <p role="alert" className="font-medium text-red-700">
            The server proposed a different payment. Nothing was signed.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!prepared.ok || stage.kind === 'signing'}
            onClick={() => void confirm()}
            className="rounded bg-neutral-900 px-4 py-3 font-medium text-white disabled:opacity-40"
          >
            Confirm
          </button>
          <button
            type="button"
            disabled={stage.kind === 'signing'}
            onClick={onClose}
            className="rounded border border-neutral-900 px-4 py-3 font-medium disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
        {stage.kind === 'signing' && <p role="status">Signing…</p>}
      </>
    );
  } else if (stage.kind === 'broadcast') {
    const href = explorerUrl(stage.txid);
    body = (
      <>
        <p role="status">{`Withdrawing… txid ${stage.txid.slice(0, 8)}…`}</p>
        {href && (
          <a href={href} rel="noopener noreferrer" target="_blank" className="underline">
            View in the explorer
          </a>
        )}
        <button type="button" onClick={onClose} className="self-start rounded border border-neutral-900 px-4 py-3 font-medium">
          Back to the tab
        </button>
      </>
    );
  } else {
    body = (
      <>
        {stage.kind === 'withdrawn' ? (
          <p role="status" className="font-medium text-green-800">{`Withdrawn ${zec} ZEC`}</p>
        ) : (
          <p role="alert" className="font-medium text-red-700">
            {stage.text}
          </p>
        )}
        <button type="button" onClick={onClose} className="self-start rounded bg-neutral-900 px-4 py-3 font-medium text-white">
          Done
        </button>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/40 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-title"
        className="flex w-full max-w-md flex-col gap-4 rounded-t-lg bg-white p-4 sm:rounded-lg"
      >
        <h2 id="withdraw-title" className="text-lg font-semibold">
          Withdraw to my wallet
        </h2>
        {body}
      </div>
    </div>
  );
}
