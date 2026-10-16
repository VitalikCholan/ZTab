import { CryptoError } from './errors.ts';
import type { TabMode } from './types.ts';

const encoder = new TextEncoder();

export const INFO = {
  spend: 'ztab/v1/spend',
  admin: 'ztab/v1/admin',
  group: 'ztab/v1/group',
  participant: (index: number) => `ztab/v1/participant/${index}`,
} as const;

/** An AES-256-GCM blob key: the raw bytes (for links) and the non-extractable CryptoKey. */
export interface BlobKey {
  readonly raw: Uint8Array<ArrayBuffer>;
  readonly key: CryptoKey;
}

export interface TabKeys {
  spendSeed: Uint8Array<ArrayBuffer>;
  admin: BlobKey;
  /** Only in `group` mode. */
  group?: BlobKey;
  /** Only in `individual` mode, indexed by participant. */
  participants?: BlobKey[];
}

/** HKDF-SHA256, salt = the tab id as UTF-8, 32 bytes out (watcher-spec §4). */
export async function hkdf32(master: Uint8Array, tabId: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  if (master.length !== 32) throw new CryptoError('internal', 'master must be 32 bytes');
  const base = await crypto.subtle.importKey('raw', master.slice(), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(tabId), info: encoder.encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function importBlobKey(raw: Uint8Array): Promise<BlobKey> {
  if (raw.length !== 32) throw new CryptoError('internal', 'blob key must be 32 bytes');
  const copy = raw.slice();
  const key = await crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { raw: copy, key };
}

export async function deriveTabKeys(
  master: Uint8Array,
  tabId: string,
  mode: TabMode,
  participantsCount: number,
): Promise<TabKeys> {
  if (!Number.isInteger(participantsCount) || participantsCount < 1) {
    throw new CryptoError('internal', 'participantsCount must be a positive integer');
  }
  const keys: TabKeys = {
    spendSeed: await hkdf32(master, tabId, INFO.spend),
    admin: await importBlobKey(await hkdf32(master, tabId, INFO.admin)),
  };
  if (mode === 'group') {
    keys.group = await importBlobKey(await hkdf32(master, tabId, INFO.group));
  } else {
    keys.participants = [];
    for (let i = 0; i < participantsCount; i++) {
      keys.participants.push(await importBlobKey(await hkdf32(master, tabId, INFO.participant(i))));
    }
  }
  return keys;
}
