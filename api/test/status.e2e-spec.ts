import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { STATUS_OPTIONS } from '../src/status/status.service.js';
import { StubWatcher } from './stub-watcher.js';
import { TEST_DATABASE_URL } from './test-env.js';

async function boot(
  stub: StubWatcher,
  network: 'test' | 'main',
  clock: { t: number },
  watcherUrl = stub.url,
): Promise<INestApplication> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.WATCHER_TOKEN = 'test-token';
  process.env.WATCHER_URL = watcherUrl;
  process.env.ZTAB_NETWORK = network;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(STATUS_OPTIONS)
    .useValue({ now: () => clock.t })
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('GET /status', () => {
  const stub = new StubWatcher();
  const clock = { t: 1_000_000 };
  let app: INestApplication;

  beforeAll(async () => {
    await stub.start();
    app = await boot(stub, 'test', clock);
  });
  afterAll(async () => {
    await app.close();
    await stub.stop();
  });
  beforeEach(() => {
    stub.reset();
    stub.setHealth({ tip_height: 100, synced_height: 99, lag_seconds: 4 });
    clock.t += 60_000; // expire any cache from the previous test
  });

  const get = () => request(app.getHttpServer()).get('/status');

  it('reports watcher health with the test block interval', async () => {
    const res = await get().expect(200);
    expect(res.body).toEqual({
      network: 'test',
      tip_height: 100,
      synced_height: 99,
      lag_seconds: 4,
      watcher: 'ok',
      block_interval_seconds: 25,
    });
  });

  it('caches for 5 s: one watcher call for two requests, a new one after', async () => {
    await get().expect(200);
    clock.t += 4_999;
    await get().expect(200);
    expect(stub.callsTo('health')).toHaveLength(1);
    clock.t += 1;
    await get().expect(200);
    expect(stub.callsTo('health')).toHaveLength(2);
  });

  it('is stale when lag exceeds 3 block intervals (75 s on test)', async () => {
    stub.setHealth({ lag_seconds: 75 });
    expect((await get().expect(200)).body.watcher).toBe('ok');
    clock.t += 5_000;
    stub.setHealth({ lag_seconds: 76 });
    expect((await get().expect(200)).body.watcher).toBe('stale');
  });

  it('is down, with null facts, when the watcher health call fails', async () => {
    stub.failNext('health', 500);
    const res = await get().expect(200);
    expect(res.body).toEqual({
      network: 'test',
      tip_height: null,
      synced_height: null,
      lag_seconds: null,
      watcher: 'down',
      block_interval_seconds: 25,
    });
  });

  it('is down when the watcher is not reachable at all', async () => {
    const lost = await boot(stub, 'test', { t: 1 }, 'http://127.0.0.1:1');
    try {
      const res = await request(lost.getHttpServer()).get('/status').expect(200);
      expect(res.body.watcher).toBe('down');
    } finally {
      await lost.close();
    }
  });

  it('uses 75 s blocks on main: stale only beyond 225 s of lag', async () => {
    const mainClock = { t: 5_000_000 };
    const main = await boot(stub, 'main', mainClock);
    try {
      stub.setHealth({ lag_seconds: 200 });
      const res = await request(main.getHttpServer()).get('/status').expect(200);
      expect(res.body).toMatchObject({
        network: 'main',
        block_interval_seconds: 75,
        watcher: 'ok',
      });
      mainClock.t += 5_000;
      stub.setHealth({ lag_seconds: 226 });
      const stale = await request(main.getHttpServer()).get('/status').expect(200);
      expect(stale.body.watcher).toBe('stale');
    } finally {
      await main.close();
      process.env.ZTAB_NETWORK = 'test';
    }
  });
});
