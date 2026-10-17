import { CryptoError } from './errors.ts';
import type { BlobKey } from './hkdf.ts';
import { randomBytes } from './random.ts';

/** Blob layout: version(1) || nonce(12) || AES-256-GCM ciphertext || tag(16). */
export const BLOB_VERSION = 1;
const NONCE = 12;
const TAG = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sealBlob(key: BlobKey, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE);
  const json: string | undefined = JSON.stringify(value);
  if (json === undefined) throw new CryptoError('internal', 'value is not JSON-serializable');
  const plaintext = encoder.encode(json);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key.key, plaintext),
  );
  const out = new Uint8Array(1 + NONCE + ciphertext.length);
  out[0] = BLOB_VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + NONCE);
  return out;
}

/** Fails closed: any defect (version, length, key, tampering) is the same `decrypt_failed`. */
export async function openBlob<T = unknown>(key: BlobKey, blob: Uint8Array): Promise<T> {
  const fail = () => new CryptoError('decrypt_failed', 'the blob cannot be opened with this key');
  if (blob.length < 1 + NONCE + TAG || blob[0] !== BLOB_VERSION) throw fail();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(1, 1 + NONCE) },
      key.key,
      blob.slice(1 + NONCE),
    );
  } catch {
    throw fail();
  }
  try {
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw fail();
  }
}
