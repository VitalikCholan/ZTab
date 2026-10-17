import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { DEFAULT_LIMITS, LIMITS_OPTIONS, type LimitsOptions } from '../src/limits/limits.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StubWatcher } from './stub-watcher.js';
import { truncateAll } from './setup-db.js';
import { TEST_DATABASE_URL } from './test-env.js';

const hex = () => randomBytes(32).toString('hex');
const blob = () => randomBytes(24).toString('base64');
const body = () => ({
  mode: 'group',
  participants_count: 2,
  ufvk: 'uviewtest1abc',
  birthday: 3_000_000,
  blobs: { admin: blob(), group: blob() },
  token_hashes: { admin: hex(), group: hex() },
});

const stub = new StubWatcher();
let app: INestApplication;
let prisma: PrismaService;

async function boot(limits?: LimitsOptions): Promise<void> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.WATCHER_TOKEN = 'test-token';
  process.env.WATCHER_URL = stub.url;
  process.env.ZTAB_NETWORK = 'test';
  process.env.CORS_ORIGIN = 'https://ztab.example';
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (limits) builder = builder.overrideProvider(LIMITS_OPTIONS).useValue(limits);
  app = (await builder.compile()).createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  await truncateAll(prisma);
}

beforeAll(async () => {
  await stub.start();
});
afterAll(async () => {
  await stub.stop();
});
afterEach(async () => {
  await truncateAll(prisma);
  await app.close();
  stub.reset();
});

const put = (ip?: string) => {
  const r = request(app.getHttpServer()).put(`/tabs/${randomUUID()}`);
  return (ip ? r.set('X-Forwarded-For', ip) : r).send(body());
};

describe('limits (real values)', () => {
  beforeEach(() => boot());

  it('pins the spec values', () => {
    expect(DEFAULT_LIMITS).toEqual({
      create: { limit: 10, ttlMs: 3_600_000 },
      default: { limit: 120, ttlMs: 60_000 },
    });
  });

  it('allows 10 creations per IP and answers the 11th with 429 rate_limited', async () => {
    for (let i = 0; i < 10; i++) await put().expect(201);
    const res = await put().expect(429);
    expect(res.body).toEqual({
      error: { code: 'rate_limited', message: expect.any(String) },
    });
  });

  it('does not count creations against the default budget and vice versa', async () => {
    for (let i = 0; i < 10; i++) await put().expect(201);
    await request(app.getHttpServer()).get('/status').expect(200);
  });
});

describe('limits (lowered)', () => {
  const low: LimitsOptions = {
    create: { limit: 3, ttlMs: 3_600_000 },
    default: { limit: 4, ttlMs: 60_000 },
  };
  beforeEach(() => boot(low));

  it('rate limit keys on forwarded client ip (last hop)', async () => {
    const xff = '1.1.1.1, 2.2.2.2';
    for (let i = 0; i < 3; i++) await put(xff).expect(201);
    await put(xff).expect(429);
    // A spoofed first hop does not buy a new budget...
    await put('9.9.9.9, 2.2.2.2').expect(429);
    // ...but a different last hop (another client behind the proxy) does.
    await put('1.1.1.1, 3.3.3.3').expect(201);
  });

  it('limits other routes with the default budget and exempts /healthz', async () => {
    for (let i = 0; i < 4; i++) await request(app.getHttpServer()).get('/status').expect(200);
    const res = await request(app.getHttpServer()).get('/status').expect(429);
    expect(res.body.error.code).toBe('rate_limited');
    for (let i = 0; i < 10; i++) await request(app.getHttpServer()).get('/healthz').expect(200);
  });
});

describe('CORS and helmet', () => {
  beforeEach(() => boot());

  it('answers a preflight from CORS_ORIGIN', async () => {
    const res = await request(app.getHttpServer())
      .options(`/tabs/${randomUUID()}`)
      .set('Origin', 'https://ztab.example')
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://ztab.example');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('gives another origin no Access-Control-Allow-Origin', async () => {
    const res = await request(app.getHttpServer())
      .options(`/tabs/${randomUUID()}`)
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PUT');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const get = await request(app.getHttpServer())
      .get('/status')
      .set('Origin', 'https://evil.example');
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets helmet headers', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
