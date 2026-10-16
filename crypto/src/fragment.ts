import { fromBase64Url, toBase64Url } from './base64url.ts';
import { CryptoError } from './errors.ts';

/** The part of a ZTab link after `#` (watcher-spec §4). Never sent to any server. */
export type Fragment =
  | { kind: 'admin'; master: Uint8Array }
  | { kind: 'group'; key: Uint8Array }
  | { kind: 'participant'; index: number; key: Uint8Array };

export function encodeFragment(fragment: Fragment): string {
  const key = fragment.kind === 'admin' ? fragment.master : fragment.key;
  if (key.length !== 32) throw new CryptoError('internal', 'a ZTab key is 32 bytes');
  if (fragment.kind === 'participant' && !(Number.isInteger(fragment.index) && fragment.index >= 0 && fragment.index <= 0xffff_ffff)) {
    throw new CryptoError('internal', 'participant index must be an integer in 0..=4294967295');
  }
  switch (fragment.kind) {
    case 'admin':
      return `#a=${toBase64Url(fragment.master)}`;
    case 'group':
      return `#g=${toBase64Url(fragment.key)}`;
    case 'participant':
      return `#p=${fragment.index}.${toBase64Url(fragment.key)}`;
  }
}

/** Accepts the fragment with or without its leading `#`. */
export function parseFragment(text: string): Fragment {
  const bad = (message: string) => new CryptoError('invalid_fragment', message);
  const body = text.startsWith('#') ? text.slice(1) : text;
  const m = /^([agp])=(.*)$/s.exec(body);
  if (!m) throw bad('the link carries no ZTab key');
  const key32 = (encoded: string): Uint8Array<ArrayBuffer> => {
    const bytes = fromBase64Url(encoded);
    if (!bytes || bytes.length !== 32) throw bad('the key is not 32 base64url bytes');
    return bytes;
  };
  if (m[1] === 'p') {
    const p = /^(0|[1-9]\d{0,9})\.([A-Za-z0-9_-]+)$/.exec(m[2]);
    if (!p) throw bad('malformed participant key');
    const index = Number(p[1]);
    if (index > 0xffff_ffff) throw bad('participant index out of range');
    return { kind: 'participant', index, key: key32(p[2]) };
  }
  const bytes = key32(m[2]);
  return m[1] === 'a' ? { kind: 'admin', master: bytes } : { kind: 'group', key: bytes };
}
