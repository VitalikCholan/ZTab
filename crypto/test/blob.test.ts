import { describe, expect, it } from 'vitest';
import { CryptoError, importBlobKey, openBlob, sealBlob } from '../src/index.ts';

const keyA = await importBlobKey(Uint8Array.from({ length: 32 }, (_, i) => i));
const keyB = await importBlobKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const tab = { title: 'Dinner', currency: 'EUR', participants: [{ name: 'Bob', shareZat: 1234567 }] };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    expect((e as CryptoError).message).toBe('the blob cannot be opened with this key');
    return (e as CryptoError).code;
  }
  throw new Error('did not throw');
}

describe('blobs', () => {
  it('round-trips JSON with a version byte and a fresh nonce', async () => {
    const one = await sealBlob(keyA, tab);
    const two = await sealBlob(keyA, tab);
    expect(one[0]).toBe(1);
    expect(one.length).toBe(1 + 12 + JSON.stringify(tab).length + 16);
    expect(Buffer.from(one.subarray(1, 13)).equals(Buffer.from(two.subarray(1, 13)))).toBe(false);
    expect(await openBlob(keyA, one)).toEqual(tab);
    expect(await openBlob(keyA, two)).toEqual(tab);
  });

  it('fails closed with a fixed message', async () => {
    const blob = await sealBlob(keyA, tab);
    expect(await codeOf(openBlob(keyB, blob))).toBe('decrypt_failed');
    const tampered = blob.slice();
    tampered[20] ^= 1;
    expect(await codeOf(openBlob(keyA, tampered))).toBe('decrypt_failed');
    const wrongVersion = blob.slice();
    wrongVersion[0] = 2;
    expect(await codeOf(openBlob(keyA, wrongVersion))).toBe('decrypt_failed');
    expect(await codeOf(openBlob(keyA, blob.subarray(0, 20)))).toBe('decrypt_failed');
    expect(await codeOf(openBlob(keyA, new Uint8Array(0)))).toBe('decrypt_failed');
  });
});
