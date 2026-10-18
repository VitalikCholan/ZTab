import { CryptoError } from './errors.ts';
import type { TabMode } from './types.ts';

const encoder = new TextEncoder();

export const INFO = {
  spend: 'ztab/v1/spend',
  admin: 'ztab/v1/admin',
  group: 'ztab/v1/group',
  token: 'ztab/v1/token',
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
  /** API access tokens, one per link (HKDF of that link's secret, salt = tab id). */
  tokens: {
    admin: Uint8Array<ArrayBuffer>;
    /** Only in `group` mode. */
    group?: Uint8Array<ArrayBuffer>;
    /** Only in `individual` mode, indexed by participant. */
    participants?: Uint8Array<ArrayBuffer>[];
  };
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

/** The API token of one link: `secret` is `master` (admin), a group key's raw bytes, or a participant key's raw bytes. */
export function deriveToken(secret: Uint8Array, tabId: string): Promise<Uint8Array<ArrayBuffer>> {
  return hkdf32(secret, tabId, INFO.token);
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
    tokens: { admin: await deriveToken(master, tabId) },
  };
  if (mode === 'group') {
    keys.group = await importBlobKey(await hkdf32(master, tabId, INFO.group));
    keys.tokens.group = await deriveToken(keys.group.raw, tabId);
  } else {
    keys.participants = [];
    keys.tokens.participants = [];
    for (let i = 0; i < participantsCount; i++) {
      const key = await importBlobKey(await hkdf32(master, tabId, INFO.participant(i)));
      keys.participants.push(key);
      keys.tokens.participants.push(await deriveToken(key.raw, tabId));
    }
  }
  return keys;
}
