import { CryptoError, deriveAddress, deriveToken, encodeFragment, hkdf32, importBlobKey, INFO, openBlob, parseFragment, sealBlob } from '@ztab/crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { adminLinks, sessionFromFragment, zeroSession } from '../../src/tab/keys.ts';
import { ApiClient, type CreateTabBody } from '../../src/api/client.ts';
import { adminBlobV1, openTyped, type AdminBlob } from '../../src/tab/blobs.ts';
import { createTab } from '../../src/tab/create.ts';
import { hex, json, hkdfFixture as F, toHex } from '../helpers/fixtures.ts';
import { loadTestWasm } from '../helpers/wasm.ts';

const ORIGIN = 'https://ztab.example';
const COMMIT = new Uint8Array(16).map((_, i) => i + 1);

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
    const fragment = encodeFragment({ kind: 'participant', index: 0, key: hex(F.participantKeyHex['0']), commit: COMMIT });
    const s = await sessionFromFragment(F.tabId, fragment, ORIGIN);
    expect(s).toMatchObject({ role: 'participant', index: 0 });
    expect(s.master).toBeUndefined();
    expect(toHex(s.token)).toBe(F.tokenHex.participant0);
    expect(toHex(s.blobKey.raw)).toBe(F.participantKeyHex['0']);
    expect(s.fullUrl).toBe(`${ORIGIN}/t/${F.tabId}${fragment}`);
  });

  it('group fragment yields the fixture group token', async () => {
    const s = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'group', key: hex(F.groupKeyHex), commit: COMMIT }), ORIGIN);
    expect(s.role).toBe('group');
    expect(toHex(s.token)).toBe(F.tokenHex.group);
  });

  it('sessionFromFragment keeps the commitment for group and participant', async () => {
    const g = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'group', key: hex(F.groupKeyHex), commit: COMMIT }), ORIGIN);
    expect(Array.from(g.commit!)).toEqual(Array.from(COMMIT));
    const p = await sessionFromFragment(
      F.tabId,
      encodeFragment({ kind: 'participant', index: 1, key: hex(F.participantKeyHex['1']), commit: COMMIT }),
      ORIGIN,
    );
    expect(Array.from(p.commit!)).toEqual(Array.from(COMMIT));
    const a = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'admin', master: hex(F.masterHex) }), ORIGIN);
    expect(a.commit).toBeUndefined();
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
    const g = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'group', key: hex(F.groupKeyHex), commit: COMMIT }), ORIGIN);
    zeroSession(g);
    expect(g.commit!.every((b) => b === 0)).toBe(true);
  });
});

const WITHDRAW = 'utest1withdraw';

function adminBlob(mode: 'group' | 'individual', n: number): AdminBlob {
  return {
    v: 1,
    title: 'Dinner',
    currency: 'USD',
    total_cents: 5000,
    rate_usd_per_zec: 40,
    rate_at: '2026-10-18T11:59:00.000Z',
    mode,
    participants: Array.from({ length: n }, (_, i) => ({
      index: i,
      name: `P${i}`,
      share_cents: 100 + i,
      share_zat: 1000 + i,
      address: `addr${i}`,
    })),
    created_at: '2026-10-18T12:00:00.000Z',
    withdraw_address: WITHDRAW,
  };
}

describe('adminLinks', () => {
  it('rebuilds the admin and participant URLs (individual)', async () => {
    const master = hex(F.masterHex);
    const { adminUrl, participantUrls } = await adminLinks(master, F.tabId, adminBlob('individual', 2), ORIGIN);
    expect(adminUrl).toBe(`${ORIGIN}/t/${F.tabId}${encodeFragment({ kind: 'admin', master })}`);
    expect(participantUrls).toHaveLength(2);
    participantUrls.forEach((url, i) => {
      const f = parseFragment(new URL(url).hash);
      expect(f).toMatchObject({ kind: 'participant', index: i });
      expect(toHex((f as { key: Uint8Array }).key)).toBe(F.participantKeyHex[String(i)]);
      expect((f as { commit: Uint8Array }).commit).toHaveLength(16);
    });
    expect(toHex(master)).toBe(F.masterHex);
  });

  it('gives one group URL in group mode', async () => {
    const { participantUrls } = await adminLinks(hex(F.masterHex), F.tabId, adminBlob('group', 3), ORIGIN);
    expect(participantUrls).toHaveLength(1);
    const f = parseFragment(new URL(participantUrls[0]).hash);
    expect(f.kind).toBe('group');
    expect(toHex(await deriveToken((f as { key: Uint8Array }).key, F.tabId))).toBe(F.tokenHex.group);
  });

  it('adminLinks output verifies against blobs built at creation', async () => {
    for (const mode of ['group', 'individual'] as const) {
      let sent: CreateTabBody | undefined;
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/status')) return json(200, { network: 'test', tip_height: 1000, synced_height: 1000, lag_seconds: 1, watcher: 'ok', block_interval_seconds: 75 });
        sent = JSON.parse(init.body as string) as CreateTabBody;
        return json(201, {
          tab_id: 'x',
          addresses: Array.from({ length: sent.participants_count }, (_, index) => ({ index, address: deriveAddress('test', sent!.ufvk, index) })),
        });
      });
      const api = new ApiClient('https://api.example', fetchImpl as unknown as typeof fetch);
      const created = await createTab(
        {
          title: 'Dinner', totalCents: 5000, usdPerZec: 40, rateAt: '2026-10-18T11:59:00.000Z', mode,
          participants: [{ name: 'Ann', shareCents: 1668 }, { name: 'Bob', shareCents: 3332 }],
          withdrawAddress: WITHDRAW,
        },
        { api, network: 'test', now: () => new Date('2026-10-18T12:00:00.000Z'), origin: ORIGIN },
      );
      const adminKey = await importBlobKey(await hkdf32(created.master, created.tabId, INFO.admin));
      const blob = await openTyped(adminKey, sent!.blobs.admin, adminBlobV1);
      const links = await adminLinks(created.master, created.tabId, blob, ORIGIN);
      expect(links.adminUrl).toBe(created.adminUrl);
      expect(links.participantUrls).toEqual(created.participantLinks.map((l) => l.url));
    }
  });

  it('the admin session blob key opens what the admin key sealed', async () => {
    const s = await sessionFromFragment(F.tabId, encodeFragment({ kind: 'admin', master: hex(F.masterHex) }), ORIGIN);
    expect(await openBlob(s.blobKey, await sealBlob(s.blobKey, { ok: 1 }))).toEqual({ ok: 1 });
  });
});
