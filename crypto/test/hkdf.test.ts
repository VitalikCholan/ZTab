import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CryptoError, deriveTabKeys, hkdf32, importBlobKey } from '../src/index.ts';

const v = JSON.parse(readFileSync(new URL('./fixtures/hkdf.json', import.meta.url), 'utf8')) as {
  masterHex: string;
  tabId: string;
  spendSeedHex: string;
  adminKeyHex: string;
  groupKeyHex: string;
  participantKeyHex: Record<string, string>;
};
const master = new Uint8Array(Buffer.from(v.masterHex, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('hkdf32', () => {
  it('matches the vectors verified against the Rust hkdf crate', async () => {
    expect(hex(await hkdf32(master, v.tabId, 'ztab/v1/spend'))).toBe(v.spendSeedHex);
    expect(hex(await hkdf32(master, v.tabId, 'ztab/v1/admin'))).toBe(v.adminKeyHex);
  });

  it('is bound to the tab id', async () => {
    expect(hex(await hkdf32(master, '00000000-0000-4000-8000-000000000000', 'ztab/v1/spend'))).not.toBe(v.spendSeedHex);
  });
});

describe('deriveTabKeys', () => {
  it('derives the group mode set', async () => {
    const keys = await deriveTabKeys(master, v.tabId, 'group', 3);
    expect(hex(keys.spendSeed)).toBe(v.spendSeedHex);
    expect(hex(keys.admin.raw)).toBe(v.adminKeyHex);
    expect(hex(keys.group!.raw)).toBe(v.groupKeyHex);
    expect(keys.participants).toBeUndefined();
    expect(keys.admin.key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    expect(keys.admin.key.extractable).toBe(false);
  });

  it('derives the individual mode set', async () => {
    const keys = await deriveTabKeys(master, v.tabId, 'individual', 2);
    expect(keys.group).toBeUndefined();
    expect(keys.participants!.map((k) => hex(k.raw))).toEqual([v.participantKeyHex['0'], v.participantKeyHex['1']]);
  });

  it('refuses a bad participant count or master length', async () => {
    await expect(deriveTabKeys(master, v.tabId, 'individual', 0)).rejects.toMatchObject({ code: 'internal' });
    await expect(deriveTabKeys(master, v.tabId, 'individual', 1.5)).rejects.toMatchObject({ code: 'internal' });
    await expect(deriveTabKeys(new Uint8Array(16), v.tabId, 'group', 2)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('importBlobKey', () => {
  it('copies the raw bytes and yields a non-extractable AES-GCM key', async () => {
    const raw = new Uint8Array(Buffer.from(v.groupKeyHex, 'hex'));
    const key = await importBlobKey(raw);
    raw.fill(0);
    expect(hex(key.raw)).toBe(v.groupKeyHex);
    expect(key.key.extractable).toBe(false);
    await expect(importBlobKey(new Uint8Array(31))).rejects.toMatchObject({ code: 'internal' });
  });
});
