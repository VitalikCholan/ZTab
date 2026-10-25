import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../config/config.module.js';
import { WatcherModule } from './watcher.module.js';
import { ApiError } from '../common/api-error.js';
import type { Config } from '../config/config.js';
import { StubWatcher } from '../../test/stub-watcher.js';
import { WatcherClient } from './watcher.client.js';

const TOKEN = 'super-secret-watcher-token';

describe('WatcherClient', () => {
  const stub = new StubWatcher();
  let now = 0;
  let client: WatcherClient;

  const config = (watcherUrl: string): Config => ({
    databaseUrl: 'x',
    watcherUrl,
    watcherToken: TOKEN,
    network: 'test',
    corsOrigin: 'x',
    port: 0,
    rateLimitCreatePerHour: 10,
    rateLimitDefaultPerMinute: 120,
    rateUrl: 'x',
  });

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await stub.start();
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    stub.reset();
    now = 1_000_000;
    client = new WatcherClient(config(stub.url), {
      now: () => now,
      timeoutMs: 200,
    });
  });

  const expectApiError = async (
    p: Promise<unknown>,
    status: number,
    code: string,
    extra?: Record<string, unknown>,
  ): Promise<ApiError> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    if (extra) expect(e.extra).toEqual(extra);
    return e;
  };

  describe('getTab cache', () => {
    it('serves a second call within 5 s from cache', async () => {
      stub.setTab('t1');
      await client.getTab('t1');
      now += 4_999;
      const tab = await client.getTab('t1');
      expect(tab.tab_id).toBe('t1');
      expect(stub.callsTo('getTab')).toHaveLength(1);
    });

    it('refetches after 5 s', async () => {
      stub.setTab('t1');
      await client.getTab('t1');
      now += 5_000;
      await client.getTab('t1');
      expect(stub.callsTo('getTab')).toHaveLength(2);
    });

    it('caches per tab id', async () => {
      stub.setTab('t1');
      stub.setTab('t2');
      await client.getTab('t1');
      await client.getTab('t2');
      expect(stub.callsTo('getTab')).toHaveLength(2);
    });

    it('does not cache failures', async () => {
      stub.setTab('t1');
      stub.failNext('getTab', 500);
      await expectApiError(client.getTab('t1'), 503, 'watcher_unavailable');
      await client.getTab('t1');
      expect(stub.callsTo('getTab')).toHaveLength(2);
    });

    it('is invalidated by sweep, even when sweep fails', async () => {
      stub.setTab('t1');
      await client.getTab('t1');
      stub.failNext('sweep', 409, 'nothing is deep enough to sweep yet');
      await expect(
        client.sweep('t1', { recipient_address: 'u1x' }),
      ).rejects.toBeInstanceOf(ApiError);
      await client.getTab('t1');
      expect(stub.callsTo('getTab')).toHaveLength(2);
    });

    it('is invalidated by broadcast and setActive', async () => {
      stub.setTab('t1');
      await client.getTab('t1');
      await client.broadcast('t1', { pczt_b64: 'x' });
      await client.getTab('t1');
      expect(stub.callsTo('getTab')).toHaveLength(2);
      await client.setActive('t1', false);
      const tab = await client.getTab('t1');
      expect(tab.active).toBe(false);
      expect(stub.callsTo('getTab')).toHaveLength(3);
    });
  });

  describe('operations', () => {
    it('registerTab returns addresses and sends the bearer token', async () => {
      const out = await client.registerTab({
        tab_id: 't1',
        ufvk: 'uview',
        birthday: 5,
        participants_count: 2,
      });
      expect(out.addresses).toHaveLength(2);
      expect(stub.calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('sweep, sweepStatus and health round-trip', async () => {
      stub.setTab('t1');
      const s = await client.sweep('t1', { recipient_address: 'u1x' });
      expect(s.summary.fee_zat).toBe(10000);
      expect((await client.sweepStatus('t1')).state).toBe('open');
      expect((await client.health()).tip_height).toBe(100);
    });

    it('setActive resolves on 204 and maps 404', async () => {
      stub.setTab('t1');
      await expect(client.setActive('t1', false)).resolves.toBeUndefined();
      await expectApiError(client.setActive('nope', true), 404, 'watcher_rejected', {
        watcher_status: 404,
      });
    });
  });

  describe('error mapping', () => {
    it('maps watcher 409 on sweep to watcher_rejected with its message', async () => {
      stub.failNext('sweep', 409, 'nothing is deep enough to sweep yet');
      const e = await expectApiError(
        client.sweep('t1', { recipient_address: 'u1x' }),
        409,
        'watcher_rejected',
        { watcher_status: 409 },
      );
      expect(e.message).toBe('nothing is deep enough to sweep yet');
    });

    it('maps watcher 422 to the same status', async () => {
      stub.failNext('sweep', 422, 'memo is not supported');
      const e = await expectApiError(
        client.sweep('t1', { recipient_address: 'u1x' }),
        422,
        'watcher_rejected',
        { watcher_status: 422 },
      );
      expect(e.message).toBe('memo is not supported');
    });

    it('maps watcher 409 on registerTab to 409 conflict', async () => {
      stub.setRegisterConflict('t1');
      const e = await expectApiError(
        client.registerTab({
          tab_id: 't1',
          ufvk: 'other',
          birthday: 1,
          participants_count: 1,
        }),
        409,
        'conflict',
      );
      expect(e.extra).toBeUndefined();
      expect(e.message).toMatch(/different ufvk/);
    });

    it('maps watcher 422 on registerTab to watcher_rejected', async () => {
      stub.failNext('register', 422, 'birthday too old');
      await expectApiError(
        client.registerTab({
          tab_id: 't1',
          ufvk: 'u',
          birthday: 1,
          participants_count: 1,
        }),
        422,
        'watcher_rejected',
        { watcher_status: 422 },
      );
    });

    it('maps 502 and 500 to 503 watcher_unavailable', async () => {
      stub.failNext('health', 502);
      await expectApiError(client.health(), 503, 'watcher_unavailable');
      stub.failNext('health', 500);
      await expectApiError(client.health(), 503, 'watcher_unavailable');
    });

    it('maps a response slower than the timeout to 503', async () => {
      stub.setDelay(600);
      await expectApiError(client.health(), 503, 'watcher_unavailable');
    });

    it('gives sweep (proving) the longer timeout, other calls keep the short one', async () => {
      // Proving takes ~9 s on a 1 vCPU VPS; the 5 s default turned every withdraw into a 503.
      const c = new WatcherClient(config(stub.url), { timeoutMs: 200, slowTimeoutMs: 2000 });
      stub.setTab('t1');
      stub.setDelay(600);
      const s = await c.sweep('t1', { recipient_address: 'u1x' });
      expect(s.summary.fee_zat).toBe(10000);
      await expectApiError(c.health(), 503, 'watcher_unavailable');
    });

    it('maps a sweep slower than the slow timeout to 503', async () => {
      const c = new WatcherClient(config(stub.url), { timeoutMs: 100, slowTimeoutMs: 300 });
      stub.setTab('t1');
      stub.setDelay(600);
      await expectApiError(
        c.sweep('t1', { recipient_address: 'u1x' }),
        503,
        'watcher_unavailable',
      );
    });

    it('maps connection refused to 503', async () => {
      const dead = new StubWatcher();
      await dead.start();
      const url = dead.url;
      await dead.stop();
      const c = new WatcherClient(config(url), { timeoutMs: 200 });
      await expectApiError(c.health(), 503, 'watcher_unavailable');
    });
  });

  describe('logging', () => {
    it('never logs the bearer token or headers', async () => {
      const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
      const originals = methods.map((m) => Logger.prototype[m]);
      const seen: unknown[][] = [];
      for (const m of methods) {
        Logger.prototype[m] = (...args: unknown[]) => {
          seen.push(args);
        };
      }
      try {
        stub.failNext('sweep', 409, 'secret-ish message');
        await client
          .sweep('t1', { recipient_address: 'u1addr' })
          .catch(() => undefined);
        stub.failNext('health', 502);
        await client.health().catch(() => undefined);
        expect(seen.length).toBeGreaterThan(0);
        const logged = JSON.stringify(seen);
        expect(logged).not.toMatch(/Bearer/i);
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain('u1addr');
        expect(logged).not.toContain('secret-ish');
      } finally {
        methods.forEach((m, i) => {
          Logger.prototype[m] = originals[i] as never;
        });
      }
    });
  });

  describe('fix round 1', () => {
    const captureLogs = (): { seen: unknown[][]; restore: () => void } => {
      const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
      const originals = methods.map((m) => Logger.prototype[m]);
      const seen: unknown[][] = [];
      for (const m of methods) {
        Logger.prototype[m] = (...args: unknown[]) => {
          seen.push([m, ...args]);
        };
      }
      return {
        seen,
        restore: () =>
          methods.forEach((m, i) => {
            Logger.prototype[m] = originals[i] as never;
          }),
      };
    };

    it('passes the stub auth check with the right token', async () => {
      stub.setAuthToken(TOKEN);
      expect((await client.health()).tip_height).toBe(100);
      await expect(
        client.registerTab({
          tab_id: 't1',
          ufvk: 'u',
          birthday: 1,
          participants_count: 1,
        }),
      ).resolves.toBeDefined();
    });

    it('maps a watcher 401 to 503 and logs an error without the token', async () => {
      stub.setAuthToken('some-other-token');
      stub.setTab('t1');
      const logs = captureLogs();
      try {
        await expectApiError(client.getTab('t1'), 503, 'watcher_unavailable');
        const errors = logs.seen.filter((c) => c[0] === 'error');
        expect(errors).toHaveLength(1);
        const all = JSON.stringify(logs.seen);
        expect(all).toContain('check WATCHER_TOKEN');
        expect(all).not.toContain(TOKEN);
        expect(all).not.toContain('some-other-token');
        expect(all).not.toContain('unauthorized');
      } finally {
        logs.restore();
      }
    });

    it('maps a watcher 403 to 503', async () => {
      stub.failNext('health', 403);
      await expectApiError(client.health(), 503, 'watcher_unavailable');
    });

    it('does not cache a getTab that was in flight during an invalidation', async () => {
      stub.setTab('t1');
      stub.setDelay(100);
      const inflight = client.getTab('t1');
      await new Promise((r) => setTimeout(r, 20));
      await client.sweep('t1', { recipient_address: 'u1x' });
      await inflight;
      stub.setDelay(0);
      await client.getTab('t1');
      expect(stub.callsTo('getTab')).toHaveLength(2);
    });

    it('returns copies, so callers cannot mutate the cache', async () => {
      stub.setTab('t1');
      const a = await client.getTab('t1');
      a.state = 'closed';
      const b = await client.getTab('t1');
      expect(b.state).toBe('open');
      b.state = 'closed';
      expect((await client.getTab('t1')).state).toBe('open');
    });

    it('registerTab makes a later getTab work without setTab', async () => {
      await client.registerTab({
        tab_id: 'r1',
        ufvk: 'u',
        birthday: 1,
        participants_count: 2,
      });
      const tab = await client.getTab('r1');
      expect(tab.participants).toHaveLength(2);
      expect(tab.state).toBe('open');
    });

    it('broadcast moves the stub tab to sweeping; unknown tabs are 404', async () => {
      stub.setTab('t1');
      await client.broadcast('t1', { pczt_b64: 'x' });
      expect((await client.getTab('t1')).state).toBe('sweeping');
      await expectApiError(
        client.sweep('nope', { recipient_address: 'u' }),
        404,
        'watcher_rejected',
        { watcher_status: 404 },
      );
      await expectApiError(client.sweepStatus('nope'), 404, 'watcher_rejected');
    });

    it('maps a non-JSON 2xx to 503', async () => {
      const raw = createServer((_req, res) => {
        res.writeHead(200).end('not json');
      });
      await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
      try {
        const c = new WatcherClient(
          config(`http://127.0.0.1:${(raw.address() as AddressInfo).port}`),
          { timeoutMs: 500 },
        );
        await expectApiError(c.health(), 503, 'watcher_unavailable');
      } finally {
        raw.closeAllConnections();
        await new Promise((r) => raw.close(r));
      }
    });

    it('maps a 4xx with a non-JSON body to the fallback message', async () => {
      const raw = createServer((_req, res) => {
        res.writeHead(422).end('<html>nope</html>');
      });
      await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
      try {
        const c = new WatcherClient(
          config(`http://127.0.0.1:${(raw.address() as AddressInfo).port}`),
          { timeoutMs: 500 },
        );
        const e = await expectApiError(c.health(), 422, 'watcher_rejected', {
          watcher_status: 422,
        });
        expect(e.message).toBe('watcher rejected the request');
      } finally {
        raw.closeAllConnections();
        await new Promise((r) => raw.close(r));
      }
    });

    it('maps a registerTab 5xx to 503', async () => {
      stub.failNext('register', 500);
      await expectApiError(
        client.registerTab({
          tab_id: 't1',
          ufvk: 'u',
          birthday: 1,
          participants_count: 1,
        }),
        503,
        'watcher_unavailable',
      );
    });

    it('invalidates the cache when sweep fails with a 5xx', async () => {
      stub.setTab('t1');
      await client.getTab('t1');
      stub.failNext('sweep', 500);
      await expectApiError(
        client.sweep('t1', { recipient_address: 'u' }),
        503,
        'watcher_unavailable',
      );
      await client.getTab('t1');
      expect(stub.callsTo('getTab')).toHaveLength(2);
    });

    it('does not follow redirects', async () => {
      const raw = createServer((_req, res) => {
        res.writeHead(302, { location: `${stub.url}/v1/health` }).end();
      });
      await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
      try {
        const c = new WatcherClient(
          config(`http://127.0.0.1:${(raw.address() as AddressInfo).port}`),
          { timeoutMs: 500 },
        );
        await expectApiError(c.health(), 503, 'watcher_unavailable');
        expect(stub.calls).toHaveLength(0);
      } finally {
        raw.closeAllConnections();
        await new Promise((r) => raw.close(r));
      }
    });

    it('resolves from WatcherModule with the global ConfigModule', async () => {
      const saved = { ...process.env };
      process.env.DATABASE_URL = 'postgresql://u:p@localhost/db';
      process.env.WATCHER_TOKEN = TOKEN;
      process.env.WATCHER_URL = stub.url;
      try {
        const mod = await Test.createTestingModule({
          imports: [ConfigModule, WatcherModule],
        }).compile();
        const c = mod.get(WatcherClient);
        stub.setAuthToken(TOKEN);
        expect((await c.health()).tip_height).toBe(100);
        await mod.close();
      } finally {
        process.env = saved;
      }
    });
  });
});
