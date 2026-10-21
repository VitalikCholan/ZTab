import { createMaster, importBlobKey, sealBlob } from '@ztab/crypto';
import { describe, expect, it } from 'vitest';
import {
  adminBlobV1,
  BlobError,
  groupBlobV1,
  openTyped,
  participantBlobV1,
  toBase64,
  type AdminBlob,
} from '../../src/tab/blobs.ts';

const ADMIN: AdminBlob = {
  v: 1,
  title: 'Dinner',
  currency: 'USD',
  total_cents: 5000,
  rate_usd_per_zec: 40.25,
  rate_at: '2026-10-18T12:00:00.000Z',
  mode: 'individual',
  participants: [
    { index: 0, name: 'Ann', share_cents: 2500, share_zat: 62111801, address: 'utest1a' },
    { index: 1, name: 'Bob', share_cents: 2500, share_zat: 62111801, address: 'utest1b' },
  ],
  withdraw_address: 'utest1w',
  created_at: '2026-10-18T12:00:01.000Z',
};

const key = () => importBlobKey(createMaster());

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => {
      throw new Error('did not reject');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(BlobError);
  return (e as BlobError).code;
}

describe('openTyped', () => {
  it('round-trips the admin blob', async () => {
    const k = await key();
    expect(await openTyped(k, toBase64(await sealBlob(k, ADMIN)), adminBlobV1)).toEqual(ADMIN);
  });

  it('round-trips the group and participant blobs', async () => {
    const k = await key();
    const { withdraw_address: _w, ...group } = ADMIN;
    expect(await openTyped(k, toBase64(await sealBlob(k, group)), groupBlobV1)).toEqual(group);
    const p = {
      v: 1, title: 'Dinner', index: 1, name: 'Bob', share_cents: 2500, share_zat: 62111801,
      address: 'utest1b', rate_usd_per_zec: 40.25, mode: 'individual',
    };
    expect(await openTyped(k, toBase64(await sealBlob(k, p)), participantBlobV1)).toEqual(p);
  });

  it('an extra field is invalid_blob', async () => {
    const k = await key();
    expect(await codeOf(openTyped(k, toBase64(await sealBlob(k, { ...ADMIN, extra: 1 })), adminBlobV1))).toBe('invalid_blob');
  });

  it('an extra field inside a participant row is invalid_blob', async () => {
    const k = await key();
    const bad = { ...ADMIN, participants: [{ ...ADMIN.participants[0], note: 'x' }] };
    expect(await codeOf(openTyped(k, toBase64(await sealBlob(k, bad)), adminBlobV1))).toBe('invalid_blob');
  });

  it('a wrong v is invalid_blob', async () => {
    const k = await key();
    expect(await codeOf(openTyped(k, toBase64(await sealBlob(k, { ...ADMIN, v: 2 })), adminBlobV1))).toBe('invalid_blob');
  });

  it('a group blob with withdraw_address is invalid_blob', async () => {
    const k = await key();
    expect(await codeOf(openTyped(k, toBase64(await sealBlob(k, ADMIN)), groupBlobV1))).toBe('invalid_blob');
  });

  it('a wrong key is decrypt_failed', async () => {
    const sealed = toBase64(await sealBlob(await key(), ADMIN));
    expect(await codeOf(openTyped(await key(), sealed, adminBlobV1))).toBe('decrypt_failed');
  });

  it('text that is not base64 is decrypt_failed', async () => {
    expect(await codeOf(openTyped(await key(), '***', adminBlobV1))).toBe('decrypt_failed');
  });
});
