import { encodeToken } from '@ztab/crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiRequestError, type CreateTabBody } from '../../src/api/client.ts';
import { json } from '../helpers/fixtures.ts';

const ID = '0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70';
const TOKEN = new Uint8Array(32).fill(7);
const BODY: CreateTabBody = {
  mode: 'group',
  participants_count: 1,
  ufvk: 'uviewtest1x',
  birthday: 100,
  blobs: { admin: 'AA==', group: 'AA==' },
  token_hashes: { admin: 'a'.repeat(64), group: 'b'.repeat(64) },
};

/** `res` is called per request so every call gets a fresh body. */
function setup(res: () => Response) {
  const fetchImpl = vi.fn(async () => res());
  return { fetchImpl, api: new ApiClient('https://api.example/', fetchImpl as unknown as typeof fetch) };
}

function call(fetchImpl: ReturnType<typeof vi.fn>, i = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchImpl.mock.calls[i] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

async function rejection(p: Promise<unknown>): Promise<ApiRequestError> {
  const e = await p.then(
    () => {
      throw new Error('did not reject');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiRequestError);
  return e as ApiRequestError;
}

describe('ApiClient', () => {
  it('maps an {error:{code,message}} body to ApiRequestError', async () => {
    const { api } = setup(() => json(404, { error: { code: 'not_found', message: 'no such tab' } }));
    const e = await rejection(api.getTab(ID, TOKEN));
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'no such tab' });
    expect(e.watcherStatus).toBeUndefined();
  });

  it('carries watcher_status from the error body', async () => {
    const { api } = setup(() =>
      json(502, { error: { code: 'watcher_rejected', message: 'refused', watcher_status: 422 } }),
    );
    const e = await rejection(api.sweep(ID, TOKEN, 'utest1abc'));
    expect(e).toMatchObject({ status: 502, code: 'watcher_rejected', watcherStatus: 422 });
  });

  it('turns a thrown fetch into code network', async () => {
    const { api } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await rejection(api.status())).toMatchObject({ status: 0, code: 'network' });
  });

  it('turns a non-JSON body into invalid_response', async () => {
    const { api } = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await rejection(api.rate())).toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('sets Authorization: Bearer from encodeToken and Accept on authorized calls', async () => {
    const { api, fetchImpl } = setup(() => json(200, { tab_id: ID }));
    await api.getTab(ID, TOKEN);
    const { url, init, headers } = call(fetchImpl);
    expect(url).toBe(`https://api.example/tabs/${ID}`);
    expect(init.method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Bearer ${encodeToken(TOKEN)}`);
    expect(headers.get('accept')).toBe('application/json');
  });

  it('sends no Authorization on /status and /rate', async () => {
    const { api, fetchImpl } = setup(() => json(200, {}));
    await api.status();
    expect(call(fetchImpl).url).toBe('https://api.example/status');
    expect(call(fetchImpl).headers.has('authorization')).toBe(false);
  });

  it('never sends a token on createTab and returns status and addresses', async () => {
    const addresses = [{ index: 0, address: 'utest1a' }];
    const { api, fetchImpl } = setup(() => json(201, { tab_id: ID, addresses }));
    const out = await api.createTab(ID, BODY);
    expect(out).toEqual({ status: 201, tabId: ID, addresses });
    const { url, init, headers } = call(fetchImpl);
    expect(url).toBe(`https://api.example/tabs/${ID}`);
    expect(init.method).toBe('PUT');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it('sends the admin Bearer on retryCreate', async () => {
    const { api, fetchImpl } = setup(() => json(200, { tab_id: ID, addresses: [] }));
    const out = await api.retryCreate(ID, BODY, TOKEN);
    expect(out.status).toBe(200);
    const { init, headers } = call(fetchImpl);
    expect(init.method).toBe('PUT');
    expect(headers.get('authorization')).toBe(`Bearer ${encodeToken(TOKEN)}`);
  });

  it('posts sweep, broadcast and reads sweep status with the token', async () => {
    const { api, fetchImpl } = setup(() => json(200, { txid: 'ab' }));
    await api.sweep(ID, TOKEN, 'utest1r');
    await api.broadcast(ID, TOKEN, 'pczt');
    await api.sweepStatus(ID, TOKEN);
    expect(call(fetchImpl, 0).url).toBe(`https://api.example/tabs/${ID}/sweep`);
    expect(JSON.parse(call(fetchImpl, 0).init.body as string)).toEqual({ recipient_address: 'utest1r' });
    expect(call(fetchImpl, 1).url).toBe(`https://api.example/tabs/${ID}/broadcast`);
    expect(JSON.parse(call(fetchImpl, 1).init.body as string)).toEqual({ pczt_b64: 'pczt' });
    expect(call(fetchImpl, 2).init.method).toBe('GET');
    for (let i = 0; i < 3; i++) {
      expect(call(fetchImpl, i).headers.get('authorization')).toBe(`Bearer ${encodeToken(TOKEN)}`);
    }
  });

  it('requests resolve against the page origin when baseUrl is a path', async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: 'ok' }));
    await new ApiClient('/api', fetchImpl as unknown as typeof fetch).status().catch(() => undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('/api/status');
  });
});
