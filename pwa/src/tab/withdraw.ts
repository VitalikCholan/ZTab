import {
  canonicalRecipient,
  deriveTabAccount,
  inspectPczt,
  signPczt,
  toBase64Url,
  type PcztSummary,
} from '@ztab/crypto';
import type { ApiClient } from '../api/client.ts';
import type { SweepOffer } from '../api/types.ts';
import { config } from '../config.ts';
import { fromBase64 } from './blobs.ts';
import type { Session } from './keys.ts';

export type WithdrawMismatch = 'recipient' | 'amount' | 'fee';

export interface PreparedWithdraw {
  pczt: Uint8Array;
  /** The only source for the confirmation screen. */
  inspected: PcztSummary;
  serverSummary: SweepOffer['summary'];
  recipient: string;
  ok: boolean;
  reason?: WithdrawMismatch;
}

/**
 * Local fee ceiling. The server summary comes from the same untrusted watcher as the PCZT, so
 * `feeZat === fee_zat` only proves the server agrees with itself; this bounds what it can take.
 */
export const MAX_FEE_ZAT = 500_000;

const sumOutputs = (s: PcztSummary) => s.outputs.reduce((a, o) => a + o.zat, 0);

/**
 * Pure verdict on a sweep PCZT. `inspectPczt` prints each output as an Orchard-only UA, so the
 * recipient (a wallet UA, possibly with Sapling/transparent receivers) is canonicalised first.
 */
export function checkWithdraw(
  inspected: PcztSummary,
  serverSummary: SweepOffer['summary'],
  recipient: string,
): { ok: true } | { ok: false; reason: WithdrawMismatch } {
  const want = canonicalRecipient(config.network, recipient);
  if (inspected.outputs.length === 0 || inspected.outputs.some((o) => o.address !== want)) {
    return { ok: false, reason: 'recipient' };
  }
  if (sumOutputs(inspected) !== serverSummary.output_zat) return { ok: false, reason: 'amount' };
  if (inspected.feeZat !== serverSummary.fee_zat || inspected.feeZat > MAX_FEE_ZAT) {
    return { ok: false, reason: 'fee' };
  }
  return { ok: true };
}

/** Asks the watcher for a sweep PCZT and checks it against `recipient` and the server's own summary. */
export async function prepareWithdraw(api: ApiClient, session: Session, recipient: string): Promise<PreparedWithdraw> {
  const offer = await api.sweep(session.tabId, session.token, recipient);
  const pczt = fromBase64(offer.pczt_b64);
  if (!pczt) throw new Error('invalid_pczt');
  const inspected = inspectPczt(config.network, pczt);
  const serverSummary = offer.summary;
  return { pczt, inspected, serverSummary, recipient, ...checkWithdraw(inspected, serverSummary, recipient) };
}

/**
 * Signs the prepared PCZT and broadcasts it. Production passes
 * `() => hkdf32(master, tabId, INFO.spend)`; the seed is zeroed here, whatever happens.
 */
export async function signAndBroadcast(
  api: ApiClient,
  session: Session,
  prepared: PreparedWithdraw,
  getSpendSeed: () => Promise<Uint8Array>,
): Promise<{ txid: string }> {
  if (!prepared.ok) throw new Error('not_ok');
  const seed = await getSpendSeed();
  let orchardSk: Uint8Array | undefined;
  const rngSeed = crypto.getRandomValues(new Uint8Array(32));
  let signed: Uint8Array;
  try {
    orchardSk = deriveTabAccount(config.network, seed).orchardSk;
    signed = signPczt(config.network, prepared.pczt, orchardSk, rngSeed, {
      recipient: prepared.recipient,
      totalZat: sumOutputs(prepared.inspected),
      feeZat: prepared.inspected.feeZat,
    });
  } finally {
    orchardSk?.fill(0);
    rngSeed.fill(0);
    seed.fill(0);
  }
  return api.broadcast(session.tabId, session.token, toBase64Url(signed));
}
