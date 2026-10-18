import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { RATE_OPTIONS } from '../src/rate/rate.service.js';
import { configureApp } from '../src/setup.js';
import { TEST_DATABASE_URL } from './test-env.js';

type Reply = { status: number; body: string; delayMs?: number };

describe('GET /rate', () => {
  let app: INestApplication;
  let upstream: Server;
  let hits = 0;
  let reply: Reply = { status: 200, body: '{"zcash":{"usd":41.23}}' };
  const clock = { t: 1_000_000 };

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      hits++;
      const r = reply;
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body);
      }, r.delayMs ?? 0);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    process.env.RATE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/price`;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    process.env.WATCHER_URL = 'http://127.0.0.1:1';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_OPTIONS)
      .useValue({ now: () => clock.t })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    hits = 0;
    reply = { status: 200, body: '{"zcash":{"usd":41.23}}' };
    clock.t += 120_000; // expire any cache from the previous test
  });

  const get = () => request(app.getHttpServer()).get('/rate');

  it('returns the upstream price and caches it for 60 s', async () => {
    const res = await get().expect(200);
    expect(res.body.usd_per_zec).toBe(41.23);
    expect(res.body.source).toBe('coingecko');
    expect(new Date(res.body.fetched_at).toISOString()).toBe(res.body.fetched_at);
    await get().expect(200);
    expect(hits).toBe(1);
    clock.t += 59_999;
    await get().expect(200);
    expect(hits).toBe(1);
    clock.t += 1;
    reply = { status: 200, body: '{"zcash":{"usd":50}}' };
    expect((await get().expect(200)).body.usd_per_zec).toBe(50);
    expect(hits).toBe(2);
  });

  it('answers 503 rate_unavailable when the upstream fails', async () => {
    reply = { status: 500, body: '{}' };
    const res = await get().expect(503);
    expect(res.body.error.code).toBe('rate_unavailable');
  });

  it.each([
    ['not json', 'oops'],
    ['wrong shape', '{"bitcoin":{"usd":1}}'],
    ['non-positive', '{"zcash":{"usd":0}}'],
    ['not a number', '{"zcash":{"usd":"41"}}'],
  ])('answers 503 for a malformed body (%s)', async (_n, body) => {
    reply = { status: 200, body };
    const res = await get().expect(503);
    expect(res.body.error.code).toBe('rate_unavailable');
  });

  it('a failed refresh after expiry is a 503, and does not cache the failure', async () => {
    await get().expect(200);
    clock.t += 60_000;
    reply = { status: 500, body: '{}' };
    await get().expect(503);
    reply = { status: 200, body: '{"zcash":{"usd":42}}' };
    expect((await get().expect(200)).body.usd_per_zec).toBe(42);
  });

  it('answers 503 within the 5 s timeout when the upstream is slow', async () => {
    reply = { status: 200, body: '{"zcash":{"usd":41.23}}', delayMs: 6000 };
    const started = Date.now();
    const res = await get().expect(503);
    expect(res.body.error.code).toBe('rate_unavailable');
    expect(Date.now() - started).toBeLessThan(5500);
  }, 10_000);
});
