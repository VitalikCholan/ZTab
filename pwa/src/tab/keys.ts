import {
  INFO,
  deriveTabKeys,
  deriveToken,
  encodeFragment,
  hkdf32,
  importBlobKey,
  parseFragment,
  type BlobKey,
  type Fragment,
  type TabKeys,
  type TabMode,
} from '@ztab/crypto';

/** Everything a page needs to talk about one tab, derived from the link fragment. Memory only. */
export type Session = {
  tabId: string;
  role: 'admin' | 'group' | 'participant';
  /** Participant role only. */
  index?: number;
  /** Admin role only: stays in memory while the admin page is open. */
  master?: Uint8Array;
  blobKey: BlobKey;
  /** API token for `Authorization: Bearer`. */
  token: Uint8Array;
  /** `${origin}/t/${tabId}#…`, rebuilt for Copy/Share. */
  fullUrl: string;
};

export function tabUrl(origin: string, tabId: string, fragment: Fragment): string {
  return `${origin}/t/${tabId}${encodeFragment(fragment)}`;
}

/** Throws `CryptoError('invalid_fragment')` for anything but `#a=`, `#g=`, `#p=i.`. */
export async function sessionFromFragment(tabId: string, fragment: string, origin: string): Promise<Session> {
  const f = parseFragment(fragment);
  const fullUrl = tabUrl(origin, tabId, f);
  if (f.kind === 'admin') {
    const raw = await hkdf32(f.master, tabId, INFO.admin);
    const blobKey = await importBlobKey(raw);
    raw.fill(0);
    return { tabId, role: 'admin', master: f.master, blobKey, token: await deriveToken(f.master, tabId), fullUrl };
  }
  const blobKey = await importBlobKey(f.key);
  const token = await deriveToken(f.key, tabId);
  f.key.fill(0);
  return f.kind === 'group'
    ? { tabId, role: 'group', blobKey, token, fullUrl }
    : { tabId, role: 'participant', index: f.index, blobKey, token, fullUrl };
}

/**
 * Re-derives the links an admin can hand out again. `participantUrls` is one URL per
 * participant in individual mode and the single group URL in group mode.
 */
export async function adminLinks(
  master: Uint8Array,
  tabId: string,
  mode: TabMode,
  n: number,
  origin: string,
): Promise<{ adminUrl: string; participantUrls: string[] }> {
  const keys = await deriveTabKeys(master, tabId, mode, n);
  try {
    const adminUrl = tabUrl(origin, tabId, { kind: 'admin', master });
    const participantUrls = keys.group
      ? [tabUrl(origin, tabId, { kind: 'group', key: keys.group.raw })]
      : (keys.participants ?? []).map((k, index) => tabUrl(origin, tabId, { kind: 'participant', index, key: k.raw }));
    return { adminUrl, participantUrls };
  } finally {
    zeroTabKeys(keys);
  }
}

/** Zeroes every byte array in `keys` (CryptoKeys are non-extractable and cannot be wiped). */
export function zeroTabKeys(keys: TabKeys): void {
  keys.spendSeed.fill(0);
  keys.admin.raw.fill(0);
  keys.group?.raw.fill(0);
  keys.participants?.forEach((k) => k.raw.fill(0));
  keys.tokens.admin.fill(0);
  keys.tokens.group?.fill(0);
  keys.tokens.participants?.forEach((t) => t.fill(0));
}

export function zeroSession(s: Session): void {
  s.token.fill(0);
  s.master?.fill(0);
  s.blobKey.raw.fill(0);
}
