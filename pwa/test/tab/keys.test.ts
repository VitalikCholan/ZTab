import { CryptoError, encodeFragment, parseFragment, sealBlob, openBlob, deriveToken } from '@ztab/crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminLinks, sessionFromFragment, zeroSession } from '../../src/tab/keys.ts';
import { hex, hkdfFixture as F, toHex } from '../helpers/fixtures.ts';
import { loadTestWasm } from '../helpers/wasm.ts';

const ORIGIN = 'https://ztab.example';

beforeAll(loadTestWasm);

describe('sessionFromFragment', () => {
  it('admin fragment yields the fixture admin token and keeps master', async () => {
    const fragment = encodeFragment({ kind: 'admin', master: hex(F.masterHex) });
    const s = await sessionFromFragment(F.tabId, fragment, ORIGIN);
    expect(s.role).toBe('admin');
    expect(s.index).toBeUndefined();
    expect(toHex(s.token)).toBe(F.tokenHex.admin);
    expect(toHex(s.master!)).toBe(F.masterHex);
    expect(s.fullUrl).toBe(`${ORIGIN}/t/${F.tabId}${fragment}`);
  });

  it('participant fragment yields the index and the fixture participant token', async () => {
    const fragment = encodeFragment({ kind: 'participant', index: 0, key: hex(F.participantKeyHex['0']) });
    const s = await sessionFromFragment(F.tabId, fragment, ORIGIN);
    expect(s).toMatchObject({ role: 'participant', index: 0 });
    expect(s.master).toBeUndefined();
    expect(toHex(s.token)).toBe(F.tokenHex.participant0);
    expect(toHex(s.blobKey.raw)).toBe(F.participantKeyHex['0']);
    expect(s.fullUrl).toBe(`${ORIGIN}/t/${F.tabId}${fragment}`);
  });

  it('group fragment yields the fixture group token', async () => {
    const s = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'group', key: hex(F.groupKeyHex) }), ORIGIN);
    expect(s.role).toBe('group');
    expect(toHex(s.token)).toBe(F.tokenHex.group);
  });

  it('a bad fragment throws CryptoError invalid_fragment', async () => {
    const e = await sessionFromFragment(F.tabId, '#x=abc', ORIGIN).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(CryptoError);
    expect((e as CryptoError).code).toBe('invalid_fragment');
  });

  it('zeroSession zeroes token, master and blob key bytes', async () => {
    const s = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'admin', master: hex(F.masterHex) }), ORIGIN);
    zeroSession(s);
    expect(s.token.every((b) => b === 0)).toBe(true);
    expect(s.master!.every((b) => b === 0)).toBe(true);
    expect(s.blobKey.raw.every((b) => b === 0)).toBe(true);
  });
});

describe('adminLinks', () => {
  it('rebuilds the admin and participant URLs (individual)', async () => {
    const master = hex(F.masterHex);
    const { adminUrl, participantUrls } = await adminLinks(master, F.tabId, 'individual', 2, ORIGIN);
    expect(adminUrl).toBe(`${ORIGIN}/t/${F.tabId}${encodeFragment({ kind: 'admin', master })}`);
    expect(participantUrls).toHaveLength(2);
    participantUrls.forEach((url, i) => {
      const f = parseFragment(new URL(url).hash);
      expect(f).toMatchObject({ kind: 'participant', index: i });
      expect(toHex((f as { key: Uint8Array }).key)).toBe(F.participantKeyHex[String(i)]);
    });
    expect(toHex(master)).toBe(F.masterHex);
  });

  it('gives one group URL in group mode', async () => {
    const { participantUrls } = await adminLinks(hex(F.masterHex), F.tabId, 'group', 3, ORIGIN);
    expect(participantUrls).toHaveLength(1);
    const f = parseFragment(new URL(participantUrls[0]).hash);
    expect(f.kind).toBe('group');
    expect(toHex(await deriveToken((f as { key: Uint8Array }).key, F.tabId))).toBe(F.tokenHex.group);
  });

  it('the admin session blob key opens what the admin key sealed', async () => {
    const s = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'admin', master: hex(F.masterHex) }), ORIGIN);
    expect(await openBlob(s.blobKey, await sealBlob(s.blobKey, { ok: 1 }))).toEqual({ ok: 1 });
  });
});
