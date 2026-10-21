import {
  createMaster,
  deriveAddress,
  deriveToken,
  encodeToken,
  hashToken,
  hkdf32,
  importBlobKey,
  INFO,
  parseFragment,
  type Fragment,
} from '@ztab/crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiRequestError, type CreateTabBody } from '../../src/api/client.ts';
import { adminBlobV1, groupBlobV1, openTyped, participantBlobV1 } from '../../src/tab/blobs.ts';
import { AddressMismatchError, CreateNetworkError, createTab, type CreateInput } from '../../src/tab/create.ts';
import { centsToZat } from '../../src/domain/money.ts';
import { json } from '../helpers/fixtures.ts';
import { loadTestWasm } from '../helpers/wasm.ts';

const ORIGIN = 'https://ztab.example';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const WITHDRAW =
  'utest1ar2v4yu756pkxhpacqe0kut2zkjske7y2pe6dea6ezfg7qs3c8e4e5uflja4e4l5869c5j0q6g5gvvl8620uxy9nr26475939uegwc4d';

const input = (mode: 'group' | 'individual'): CreateInput => ({
  title: 'Dinner',
  totalCents: 5000,
  usdPerZec: 40,
  rateAt: '2026-10-18T11:59:00.000Z',
  mode,
  participants: [
    { name: 'Ann', shareCents: 1668 },
    { name: 'Bob', shareCents: 1666 },
    { name: 'Cy', shareCents: 1666 },
  ],
  withdrawAddress: WITHDRAW,
});

type Put = (body: CreateTabBody, headers: Headers, n: number) => Response | 'throw';

/** Mocked API: GET /status gives tip 1000; PUT is answered by `put`. */
function mockApi(put: Put) {
  const puts: { body: CreateTabBody; headers: Headers; url: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/status')) {
      return json(200, { network: 'test', tip_height: 1000, synced_height: 1000, lag_seconds: 1, watcher: 'ok', block_interval_seconds: 75 });
    }
    const body = JSON.parse(init.body as string) as CreateTabBody;
    const headers = new Headers(init.headers);
    puts.push({ body, headers, url });
    const r = put(body, headers, puts.length);
    if (r === 'throw') throw new TypeError('Failed to fetch');
    return r;
  });
  return { puts, api: new ApiClient('https://api.example', fetchImpl as unknown as typeof fetch) };
}

const honest = (body: CreateTabBody, status = 201) =>
  json(status, {
    tab_id: 'x',
    addresses: Array.from({ length: body.participants_count }, (_, index) => ({
      index,
      address: deriveAddress('test', body.ufvk, index),
    })),
  });

const keyOf = (f: Fragment) => (f.kind === 'admin' ? f.master : f.key);

beforeAll(loadTestWasm);

describe('createTab', () => {
  it('individual: 201 flow yields admin + n participant URLs matching the hashes and blobs sent', async () => {
    const { api, puts } = mockApi((b) => honest(b));
    const out = await createTab(input('individual'), { api, network: 'test', now: () => NOW, origin: ORIGIN });

    expect(puts).toHaveLength(1);
    const { body, headers, url } = puts[0];
    expect(headers.has('authorization')).toBe(false);
    expect(url).toBe(`https://api.example/tabs/${out.tabId}`);
    expect(body).toMatchObject({ mode: 'individual', participants_count: 3, birthday: 980 });
    expect(body.ufvk.startsWith('uviewtest')).toBe(true);
    expect(body.blobs.group).toBeUndefined();

    // Admin link: token hash and admin blob.
    expect(out.adminUrl.startsWith(`${ORIGIN}/t/${out.tabId}#a=`)).toBe(true);
    const admin = parseFragment(new URL(out.adminUrl).hash);
    expect(admin.kind).toBe('admin');
    expect(Array.from(out.master)).toEqual(Array.from(keyOf(admin)));
    expect(await hashToken(await deriveToken(keyOf(admin), out.tabId))).toBe(body.token_hashes.admin);
    const adminKey = await importBlobKey(await hkdf32(keyOf(admin), out.tabId, INFO.admin));
    const adminBlob = await openTyped(adminKey, body.blobs.admin, adminBlobV1);
    expect(adminBlob).toMatchObject({
      v: 1, title: 'Dinner', currency: 'USD', total_cents: 5000, rate_usd_per_zec: 40,
      rate_at: '2026-10-18T11:59:00.000Z', mode: 'individual', withdraw_address: WITHDRAW,
      created_at: NOW.toISOString(),
    });
    expect(adminBlob.participants.map((p) => p.address)).toEqual(
      [0, 1, 2].map((i) => deriveAddress('test', body.ufvk, i)),
    );
    expect(adminBlob.participants[0]).toMatchObject({ index: 0, name: 'Ann', share_cents: 1668, share_zat: centsToZat(1668, 40) });

    // Participant links.
    expect(out.participantLinks.map((l) => [l.index, l.name])).toEqual([[0, 'Ann'], [1, 'Bob'], [2, 'Cy']]);
    expect(body.token_hashes.participants).toHaveLength(3);
    for (const link of out.participantLinks) {
      const f = parseFragment(new URL(link.url).hash);
      expect(f).toMatchObject({ kind: 'participant', index: link.index });
      const token = await deriveToken(keyOf(f), out.tabId);
      expect(await hashToken(token)).toBe(body.token_hashes.participants![link.index]);
      const pb = await openTyped(await importBlobKey(keyOf(f)), body.blobs.participants![link.index], participantBlobV1);
      expect(pb).toMatchObject({ v: 1, index: link.index, name: link.name, address: deriveAddress('test', body.ufvk, link.index), mode: 'individual' });
    }
  });

  it('group: one Everyone link whose token and blob match', async () => {
    const { api, puts } = mockApi((b) => honest(b));
    const out = await createTab(input('group'), { api, network: 'test', now: () => NOW, origin: ORIGIN });
    const { body } = puts[0];
    expect(body.blobs.participants).toBeUndefined();
    expect(out.participantLinks).toHaveLength(1);
    expect(out.participantLinks[0]).toMatchObject({ index: -1, name: 'Everyone' });
    const f = parseFragment(new URL(out.participantLinks[0].url).hash);
    expect(f.kind).toBe('group');
    expect(await hashToken(await deriveToken(keyOf(f), out.tabId))).toBe(body.token_hashes.group);
    const gb = await openTyped(await importBlobKey(keyOf(f)), body.blobs.group!, groupBlobV1);
    expect(gb.participants).toHaveLength(3);
    expect('withdraw_address' in gb).toBe(false);
  });

  it('one different address → AddressMismatchError and no second call', async () => {
    const { api, puts } = mockApi((b) => {
      const addresses = Array.from({ length: b.participants_count }, (_, index) => ({
        index,
        address: deriveAddress('test', b.ufvk, index === 1 ? 7 : index),
      }));
      return json(201, { tab_id: 'x', addresses });
    });
    await expect(createTab(input('individual'), { api, network: 'test', now: () => NOW, origin: ORIGIN })).rejects.toBeInstanceOf(
      AddressMismatchError,
    );
    expect(puts).toHaveLength(1);
  });

  it('a missing address is also AddressMismatchError', async () => {
    const { api } = mockApi((b) => json(201, { tab_id: 'x', addresses: [{ index: 0, address: deriveAddress('test', b.ufvk, 0) }] }));
    await expect(createTab(input('individual'), { api, network: 'test', now: () => NOW, origin: ORIGIN })).rejects.toThrow(
      'The server returned addresses that do not match this tab',
    );
  });

  it('a network failure throws CreateNetworkError; retry() re-sends the identical body with the admin Bearer', async () => {
    const { api, puts } = mockApi((b, _h, n) => (n === 1 ? 'throw' : honest(b, 200)));
    const e = await createTab(input('individual'), { api, network: 'test', now: () => NOW, origin: ORIGIN }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CreateNetworkError);
    const err = e as CreateNetworkError;
    expect(err.code).toBe('network');
    expect(typeof err.retry).toBe('function');
    expect(puts).toHaveLength(1);
    expect(puts[0].headers.has('authorization')).toBe(false);

    const out = await err.retry();
    expect(out.tabId).toBe(err.tabId);
    expect(puts).toHaveLength(2);
    expect(puts[1].url).toBe(`https://api.example/tabs/${err.tabId}`);
    expect(puts[1].body).toEqual(puts[0].body);
    const admin = parseFragment(new URL(out.adminUrl).hash);
    expect(puts[1].headers.get('authorization')).toBe(`Bearer ${encodeToken(await deriveToken(keyOf(admin), out.tabId))}`);
    expect(out.master.some((b) => b !== 0)).toBe(true);
  });

  it('a second network failure inside retry() throws again with a still-usable retry', async () => {
    const { api, puts } = mockApi((b, _h, n) => (n <= 2 ? 'throw' : honest(b, 200)));
    const first = (await createTab(input('group'), { api, network: 'test', now: () => NOW, origin: ORIGIN }).catch((x: unknown) => x)) as CreateNetworkError;
    const second = (await first.retry().catch((x: unknown) => x)) as CreateNetworkError;
    expect(second).toBeInstanceOf(CreateNetworkError);
    expect(second.tabId).toBe(first.tabId);
    const out = await second.retry();
    expect(out.tabId).toBe(first.tabId);
    expect(puts).toHaveLength(3);
    expect(puts[2].body).toEqual(puts[0].body);
    expect(puts[2].headers.get('authorization')).toBe(puts[1].headers.get('authorization'));
    expect(puts[1].headers.get('authorization')).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
  });

  it('abandon() zeroes the master and makes retry() refuse', async () => {
    let master: Uint8Array | undefined;
    const { api, puts } = mockApi(() => 'throw');
    const deps = { api, network: 'test' as const, now: () => NOW, origin: ORIGIN, createMaster: () => (master = createMaster()) };
    const err = (await createTab(input('individual'), deps).catch((x: unknown) => x)) as CreateNetworkError;
    expect(master!.some((b) => b !== 0)).toBe(true);
    err.abandon();
    expect(master!.every((b) => b === 0)).toBe(true);
    await expect(err.retry()).rejects.toThrow('create_finished');
    expect(puts).toHaveLength(1);
  });

  it('abandon() while a retry PUT is pending → the retry rejects with create_finished and builds no links', async () => {
    let master: Uint8Array | undefined;
    let release: (() => void) | undefined;
    const putsSeen: number[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/status')) return json(200, { tip_height: 1000 });
      const body = JSON.parse(init.body as string) as CreateTabBody;
      putsSeen.push(putsSeen.length + 1);
      if (putsSeen.length === 1) throw new TypeError('Failed to fetch');
      await new Promise<void>((r) => (release = r));
      return honest(body, 200);
    });
    const api = new ApiClient('https://api.example', fetchImpl as unknown as typeof fetch);
    const deps = { api, network: 'test' as const, now: () => NOW, origin: ORIGIN, createMaster: () => (master = createMaster()) };
    const err = (await createTab(input('individual'), deps).catch((x: unknown) => x)) as CreateNetworkError;
    const pending = err.retry();
    await vi.waitFor(() => expect(release).toBeDefined());
    err.abandon();
    release!();
    await expect(pending).rejects.toThrow('create_finished');
    expect(master!.every((b) => b === 0)).toBe(true);
    expect(putsSeen).toHaveLength(2);
  });

  it('two retry() calls at once share one PUT and resolve to the same result', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/status')) return json(200, { tip_height: 1000 });
      const body = JSON.parse(init.body as string) as CreateTabBody;
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      await new Promise<void>((r) => (release = r));
      return honest(body, 200);
    });
    const api = new ApiClient('https://api.example', fetchImpl as unknown as typeof fetch);
    const err = (await createTab(input('individual'), { api, network: 'test', now: () => NOW, origin: ORIGIN }).catch(
      (x: unknown) => x,
    )) as CreateNetworkError;
    const a = err.retry();
    const b = err.retry();
    expect(b).toBe(a);
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    expect(n).toBe(2);
    // The links were built from live keys, not zeroed ones.
    const admin = parseFragment(new URL(ra.adminUrl).hash);
    expect(keyOf(admin).some((x) => x !== 0)).toBe(true);
    for (const link of ra.participantLinks) {
      expect(keyOf(parseFragment(new URL(link.url).hash)).some((x) => x !== 0)).toBe(true);
    }
    await expect(err.retry()).rejects.toThrow('create_finished');
  });

  it('a non-network error inside retry() is final and zeroes the master', async () => {
    let master: Uint8Array | undefined;
    const { api } = mockApi((_b, _h, n) => (n === 1 ? 'throw' : json(409, { error: { code: 'conflict', message: 'x' } })));
    const deps = { api, network: 'test' as const, now: () => NOW, origin: ORIGIN, createMaster: () => (master = createMaster()) };
    const err = (await createTab(input('individual'), deps).catch((x: unknown) => x)) as CreateNetworkError;
    await expect(err.retry()).rejects.toMatchObject({ code: 'conflict' });
    expect(master!.every((b) => b === 0)).toBe(true);
  });

  it('a 4xx body error is thrown as-is without a retry', async () => {
    const { api, puts } = mockApi(() => json(400, { error: { code: 'validation', message: 'bad' } }));
    const e = await createTab(input('individual'), { api, network: 'test', now: () => NOW, origin: ORIGIN }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiRequestError);
    expect((e as ApiRequestError).code).toBe('validation');
    expect(puts).toHaveLength(1);
  });

  it('clamps birthday at 0 near genesis', async () => {
    const puts: CreateTabBody[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/status')) return json(200, { tip_height: 5 });
      const body = JSON.parse(init.body as string) as CreateTabBody;
      puts.push(body);
      return honest(body);
    });
    const api = new ApiClient('https://api.example', fetchImpl as unknown as typeof fetch);
    await createTab(input('group'), { api, network: 'test', now: () => NOW, origin: ORIGIN });
    expect(puts[0].birthday).toBe(0);
  });
});
