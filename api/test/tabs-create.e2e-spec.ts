import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { LIMITS_OPTIONS } from '../src/limits/limits.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StubWatcher } from './stub-watcher.js';
import { truncateAll } from './setup-db.js';
import { TEST_DATABASE_URL } from './test-env.js';

const hex = () => randomBytes(32).toString('hex');
const sha = (t: Buffer) => createHash('sha256').update(t).digest('hex');
const bearer = (t: Buffer) => `Bearer ${t.toString('base64url')}`;
// Real tokens behind the hashes sent by groupBody, keyed by admin hash.
const adminTokens = new Map<string, Buffer>();
const adminAuth = (body: { token_hashes: { admin: string } }) =>
  bearer(adminTokens.get(body.token_hashes.admin)!);
const blob = () => randomBytes(24).toString('base64');

function groupBody(overrides: Record<string, unknown> = {}) {
  const admin = randomBytes(32);
  adminTokens.set(sha(admin), admin);
  return {
    mode: 'group',
    participants_count: 3,
    ufvk: 'uviewtest1abc',
    birthday: 3_000_000,
    blobs: { admin: blob(), group: blob() },
    token_hashes: { admin: sha(admin), group: hex() },
    ...overrides,
  };
}

function individualBody() {
  return {
    mode: 'individual',
    participants_count: 2,
    ufvk: 'uviewtest1abc',
    birthday: 3_000_000,
    blobs: { admin: blob(), participants: [blob(), blob()] },
    token_hashes: { admin: hex(), participants: [hex(), hex()] },
  };
}

describe('PUT /tabs/:id', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stub = new StubWatcher();

  beforeAll(async () => {
    await stub.start();
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    process.env.WATCHER_URL = stub.url;
    process.env.ZTAB_NETWORK = 'test';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // This suite creates far more than 10 tabs from one IP; limits are
      // covered by limits.e2e-spec.ts.
      .overrideProvider(LIMITS_OPTIONS)
      .useValue({
        create: { limit: 10_000, ttlMs: 60_000 },
        default: { limit: 10_000, ttlMs: 60_000 },
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    stub.reset();
    stub.setAuthToken('test-token');
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
    await stub.stop();
  });

  const put = (id: string, body: unknown, auth?: string) => {
    const r = request(app.getHttpServer()).put(`/tabs/${id}`);
    return (auth ? r.set('Authorization', auth) : r).send(body as object);
  };

  const counts = async () => ({
    tabs: await prisma.tab.count(),
    addresses: await prisma.tabAddress.count(),
    blobs: await prisma.tabBlob.count(),
    tokens: await prisma.tabToken.count(),
  });

  it('creates a group tab and fills all four tables', async () => {
    const id = randomUUID();
    const body = groupBody();
    const res = await put(id, body);
    expect(res.status).toBe(201);
    expect(res.body.tab_id).toBe(id);
    expect(res.body.addresses).toEqual([
      { index: 0, address: `utest1stub${id}x0` },
      { index: 1, address: `utest1stub${id}x1` },
      { index: 2, address: `utest1stub${id}x2` },
    ]);
    expect(await counts()).toEqual({ tabs: 1, addresses: 3, blobs: 2, tokens: 2 });
    const tab = await prisma.tab.findUniqueOrThrow({ where: { id } });
    expect(tab).toMatchObject({
      mode: 'group',
      participantsCount: 3,
      network: 'test',
      lastKnownState: 'open',
    });
    const tokens = await prisma.tabToken.findMany({ where: { tabId: id } });
    const admin = tokens.find((t) => t.role === 'admin')!;
    expect(Buffer.from(admin.tokenHash).toString('hex')).toBe(
      body.token_hashes.admin,
    );
    const blobs = await prisma.tabBlob.findMany({ where: { tabId: id } });
    const adminBlob = blobs.find((b) => b.role === 'admin')!;
    expect(Buffer.from(adminBlob.ciphertext).toString('base64')).toBe(
      body.blobs.admin,
    );
    const call = stub.callsTo('register')[0].body as Record<string, unknown>;
    expect(call).toEqual({
      tab_id: id,
      ufvk: 'uviewtest1abc',
      birthday: 3_000_000,
      participants_count: 3,
    });
  });

  it('creates an individual tab', async () => {
    const id = randomUUID();
    const res = await put(id, individualBody());
    expect(res.status).toBe(201);
    expect(res.body.addresses).toHaveLength(2);
    expect(await counts()).toEqual({ tabs: 1, addresses: 2, blobs: 3, tokens: 3 });
    const parts = await prisma.tabBlob.findMany({
      where: { tabId: id, role: 'participant' },
      orderBy: { index: 'asc' },
    });
    expect(parts.map((p) => p.index)).toEqual([0, 1]);
  });

  it('rejects an invalid body with 400 validation and does not call the watcher', async () => {
    const res = await put(randomUUID(), groupBody({ participants_count: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');
    expect(stub.callsTo('register')).toHaveLength(0);
  });

  it('rejects a path id that is not a UUID with 400', async () => {
    const res = await put('not-a-uuid', groupBody());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');
  });

  it('retry after watcher success is idempotent', async () => {
    const id = randomUUID();
    const body = groupBody();
    const first = await put(id, body);
    expect(first.status).toBe(201);
    const before = await counts();
    const second = await put(
      id,
      { ...body, blobs: { admin: blob(), group: blob() } },
      adminAuth(body),
    );
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await counts()).toEqual(before);
    expect(stub.callsTo('register')).toHaveLength(1);
  });

  it('a retry overwrites the blobs and keeps the token hashes', async () => {
    const id = randomUUID();
    const body = groupBody();
    await put(id, body);
    const newBlobs = { admin: blob(), group: blob() };
    const res = await put(id, { ...body, blobs: newBlobs }, adminAuth(body));
    expect(res.status).toBe(200);
    const blobs = await prisma.tabBlob.findMany({ where: { tabId: id } });
    expect(
      blobs.map((b) => Buffer.from(b.ciphertext).toString('base64')).sort(),
    ).toEqual([newBlobs.admin, newBlobs.group].sort());
  });

  it('a retry with a different non-admin hash is a 409 and changes nothing', async () => {
    const id = randomUUID();
    const body = groupBody();
    await put(id, body);
    const res = await put(
      id,
      {
        ...body,
        token_hashes: { admin: body.token_hashes.admin, group: hex() },
      },
      adminAuth(body),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  describe('retry requires the admin token', () => {
    const storedBlobs = async (id: string) =>
      (await prisma.tabBlob.findMany({ where: { tabId: id } }))
        .map((b) => Buffer.from(b.ciphertext).toString('base64'))
        .sort();

    async function setup() {
      const group = randomBytes(32);
      const id = randomUUID();
      const body = groupBody();
      body.token_hashes.group = sha(group);
      await put(id, body);
      const original = await storedBlobs(id);
      const forged = { ...body, blobs: { admin: blob(), group: blob() } };
      return { id, forged, original, group };
    }

    it('without a token is 409 and blobs are unchanged', async () => {
      const { id, forged, original } = await setup();
      const res = await put(id, forged);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
      expect(await storedBlobs(id)).toEqual(original);
    });

    it('with a participant-level (group) token is 409', async () => {
      const { id, forged, original, group } = await setup();
      const res = await put(id, forged, bearer(group));
      expect(res.status).toBe(409);
      expect(await storedBlobs(id)).toEqual(original);
    });

    it('with a wrong 32-byte token is 409', async () => {
      const { id, forged, original } = await setup();
      const res = await put(id, forged, bearer(randomBytes(32)));
      expect(res.status).toBe(409);
      expect(await storedBlobs(id)).toEqual(original);
    });

    it('with a malformed header is 409', async () => {
      const { id, forged, original } = await setup();
      const res = await put(id, forged, 'Bearer nope');
      expect(res.status).toBe(409);
      expect(await storedBlobs(id)).toEqual(original);
    });
  });

  it('same id with a different ufvk is 409 conflict', async () => {
    const id = randomUUID();
    const body = groupBody();
    await put(id, body);
    const res = await put(id, { ...body, ufvk: 'uviewtest1other' }, adminAuth(body));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('same id with a different admin hash is 409 conflict', async () => {
    const id = randomUUID();
    const body = groupBody();
    await put(id, body);
    const res = await put(id, {
      ...body,
      token_hashes: { admin: hex(), group: body.token_hashes.group },
    });
    expect(res.status).toBe(409);
  });

  it('a watcher 409 on registration is 409 conflict and stores nothing', async () => {
    const id = randomUUID();
    stub.setRegisterConflict(id);
    const res = await put(id, groupBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(await counts()).toEqual({ tabs: 0, addresses: 0, blobs: 0, tokens: 0 });
  });

  it('a watcher 422 is 422 watcher_rejected and nothing is stored', async () => {
    stub.failNext('register', 422, 'birthday too old');
    const res = await put(randomUUID(), groupBody());
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'watcher_rejected',
      message: 'birthday too old',
      watcher_status: 422,
    });
    expect(await counts()).toEqual({ tabs: 0, addresses: 0, blobs: 0, tokens: 0 });
  });

  it('watcher down is 503 watcher_unavailable and nothing is stored', async () => {
    stub.failNext('register', 500);
    const res = await put(randomUUID(), groupBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('watcher_unavailable');
    expect(await counts()).toEqual({ tabs: 0, addresses: 0, blobs: 0, tokens: 0 });
  });

  it('a token hash already used by another tab is 409', async () => {
    const body = groupBody();
    await put(randomUUID(), body);
    const res = await put(randomUUID(), {
      ...groupBody(),
      token_hashes: { admin: body.token_hashes.admin, group: hex() },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('a body of 65 KB is 413', async () => {
    const res = await put(randomUUID(), {
      ...groupBody(),
      pad: 'x'.repeat(65 * 1024),
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('validation');
  });

  describe('database uniqueness of NULL-index rows', () => {
    it('rejects a second admin blob for the same tab', async () => {
      const id = randomUUID();
      await put(id, groupBody());
      await expect(
        prisma.tabBlob.create({
          data: { tabId: id, role: 'admin', ciphertext: Buffer.from('x') },
        }),
      ).rejects.toThrow();
    });

    it('rejects a second admin token for the same tab', async () => {
      const id = randomUUID();
      await put(id, groupBody());
      await expect(
        prisma.tabToken.create({
          data: { tabId: id, role: 'admin', tokenHash: randomBytes(32) },
        }),
      ).rejects.toThrow();
    });
  });

  it.each([
    ['too few', (b: { participants_count: number; tab_id: string }) =>
      [{ index: 0, address: `utest1x${b.tab_id}` }]],
    ['duplicate index', (b: { participants_count: number; tab_id: string }) =>
      Array.from({ length: b.participants_count }, () => ({ index: 0, address: 'utest1a' }))],
    ['index out of range', (b: { participants_count: number; tab_id: string }) =>
      Array.from({ length: b.participants_count }, (_, i) => ({ index: i + 1, address: 'utest1a' }))],
    ['wrong network prefix', (b: { participants_count: number; tab_id: string }) =>
      Array.from({ length: b.participants_count }, (_, i) => ({ index: i, address: 'u1main' }))],
    ['empty address', (b: { participants_count: number; tab_id: string }) =>
      Array.from({ length: b.participants_count }, (_, i) => ({ index: i, address: '' }))],
  ])('503 watcher_unavailable and nothing stored for watcher addresses: %s', async (_n, fn) => {
    stub.setRegisterAddresses(fn);
    const res = await put(randomUUID(), groupBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('watcher_unavailable');
    expect(await counts()).toEqual({ tabs: 0, addresses: 0, blobs: 0, tokens: 0 });
  });
});
