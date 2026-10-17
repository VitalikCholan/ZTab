import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { hashToken } from '../src/auth/token.js';
import { StubWatcher } from './stub-watcher.js';
import { truncateAll } from './setup-db.js';
import { TEST_DATABASE_URL } from './test-env.js';

const bearer = (t: Buffer) => `Bearer ${t.toString('base64url')}`;
const PCZT_B64 = readFileSync(
  new URL('../../watcher/tests/fixtures/sweep.proved.pczt', import.meta.url),
).toString('base64url');
const SUMMARY = {
  inputs_zat: 100000,
  output_zat: 90000,
  fee_zat: 10000,
  expiry_height: 220,
  txid: 'bb'.repeat(32),
  pending_mempool_zat: 0,
};

describe('sweep proxy', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stub = new StubWatcher();
  const admin = randomBytes(32);
  const group = randomBytes(32);
  const p0 = randomBytes(32);
  let id: string;

  beforeAll(async () => {
    await stub.start();
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    process.env.WATCHER_URL = stub.url;
    process.env.ZTAB_NETWORK = 'test';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    stub.reset();
    stub.setAuthToken('test-token');
    await truncateAll(prisma);
    id = randomUUID();
    await prisma.tab.create({
      data: {
        id,
        mode: 'individual',
        participantsCount: 1,
        ufvk: 'uviewtest1secret',
        birthday: 1,
        network: 'test',
        addresses: { create: [{ index: 0, address: 'utest1a0' }] },
        blobs: {
          create: [
            { role: 'admin', index: null, ciphertext: Buffer.from('admin') },
            { role: 'group', index: null, ciphertext: Buffer.from('group') },
            { role: 'participant', index: 0, ciphertext: Buffer.from('p0') },
          ],
        },
        tokens: {
          create: [
            { role: 'admin', index: null, tokenHash: hashToken(admin) },
            { role: 'group', index: null, tokenHash: hashToken(group) },
            { role: 'participant', index: 0, tokenHash: hashToken(p0) },
          ],
        },
      },
    });
    stub.setTab(id, {
      participants: [
        {
          index: 0,
          address: 'utest1a0',
          payments: [],
          status_facts: {
            confirmed_zat: 1,
            mempool_zat: 0,
            best_confirmations: 3,
            transparent_source: false,
          },
        },
      ],
    });
    stub.setSweepResult(id, { pczt_b64: PCZT_B64, summary: SUMMARY });
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
    await stub.stop();
  });

  const sweep = (token: Buffer, body: unknown = { recipient_address: 'utest1dest' }) =>
    request(app.getHttpServer())
      .post(`/tabs/${id}/sweep`)
      .set('Authorization', bearer(token))
      .send(body as object);
  const broadcast = (token: Buffer, body: unknown = { pczt_b64: PCZT_B64 }) =>
    request(app.getHttpServer())
      .post(`/tabs/${id}/broadcast`)
      .set('Authorization', bearer(token))
      .send(body as object);
  const status = (token: Buffer) =>
    request(app.getHttpServer())
      .get(`/tabs/${id}/sweep`)
      .set('Authorization', bearer(token));

  it('admin sweep returns the watcher body unchanged', async () => {
    const res = await sweep(admin).expect(200);
    expect(res.body).toEqual({ pczt_b64: PCZT_B64, summary: SUMMARY });
    expect(stub.callsTo('sweep')[0].body).toEqual({ recipient_address: 'utest1dest' });
  });

  it.each([
    ['participant', p0],
    ['group', group],
  ])('%s cannot sweep, broadcast or read sweep status', async (_n, token) => {
    for (const res of [
      await sweep(token),
      await broadcast(token),
      await status(token),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect(stub.callsTo('sweep')).toHaveLength(0);
    expect(stub.callsTo('broadcast')).toHaveLength(0);
  });

  it('watcher 409 becomes 409 watcher_rejected with its message', async () => {
    stub.failNext('sweep', 409, 'not every note has 10 confirmations');
    const res = await sweep(admin).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'watcher_rejected',
      message: 'not every note has 10 confirmations',
    });
    expect(res.body.error.watcher_status).toBe(409);
  });

  it('watcher 5xx on sweep is 503 watcher_unavailable', async () => {
    stub.failNext('sweep', 500);
    const res = await sweep(admin).expect(503);
    expect(res.body.error.code).toBe('watcher_unavailable');
  });

  it('broadcast returns the txid; next GET refetches from the watcher', async () => {
    const get = () =>
      request(app.getHttpServer())
        .get(`/tabs/${id}`)
        .set('Authorization', bearer(admin))
        .expect(200);
    await get();
    await get();
    expect(stub.callsTo('getTab')).toHaveLength(1);
    const res = await broadcast(admin).expect(200);
    expect(res.body).toEqual({ txid: 'aa'.repeat(32) });
    expect(stub.callsTo('broadcast')[0].body).toEqual({ pczt_b64: PCZT_B64 });
    const after = await get();
    expect(stub.callsTo('getTab')).toHaveLength(2);
    expect(after.body.state).toBe('sweeping');
  });

  it('GET sweep returns the watcher status', async () => {
    const st = { state: 'sweeping', txid: 'cc'.repeat(32), mined_height: null, confirmations: 0 };
    stub.setSweepStatus(id, st as never);
    const res = await status(admin).expect(200);
    expect(res.body).toEqual(st);
  });

  it('rejects invalid bodies with 400 validation', async () => {
    const bad: [string, unknown][] = [
      ['sweep', { recipient_address: 'x'.repeat(513) }],
      ['sweep', {}],
      ['sweep', { recipient_address: 'a', extra: 1 }],
      ['sweep', { recipient_address: 5 }],
      ['broadcast', { pczt_b64: 'A'.repeat(49153) }],
      ['broadcast', { pczt_b64: 'not base64!' }],
      ['broadcast', {}],
      ['broadcast', { pczt_b64: 'AAAA', extra: 1 }],
    ];
    for (const [route, body] of bad) {
      const res = await (route === 'sweep' ? sweep(admin, body) : broadcast(admin, body));
      expect([route, res.status]).toEqual([route, 400]);
      expect(res.body.error.code).toBe('validation');
    }
    expect(stub.callsTo('sweep')).toHaveLength(0);
    expect(stub.callsTo('broadcast')).toHaveLength(0);
  });

  it('accepts the largest allowed values', async () => {
    await sweep(admin, { recipient_address: 'x'.repeat(512) }).expect(200);
    await broadcast(admin, { pczt_b64: 'A'.repeat(49152) }).expect(200);
  });

  it('revives a paused tab before forwarding', async () => {
    await prisma.tab.update({ where: { id }, data: { paused: true } });
    await sweep(admin).expect(200);
    expect(stub.callsTo('setActive')).toHaveLength(1);
    expect(stub.callsTo('setActive')[0].body).toEqual({ active: true });
    expect(
      (await prisma.tab.findUniqueOrThrow({ where: { id } })).paused,
    ).toBe(false);
  });

  it('failed revival is 503 and nothing is forwarded', async () => {
    await prisma.tab.update({ where: { id }, data: { paused: true } });
    stub.failNext('setActive', 500);
    const res = await broadcast(admin).expect(503);
    expect(res.body.error.code).toBe('watcher_unavailable');
    expect(stub.callsTo('broadcast')).toHaveLength(0);
    expect(
      (await prisma.tab.findUniqueOrThrow({ where: { id } })).paused,
    ).toBe(true);
  });

  it('revives a paused tab for the status read too', async () => {
    await prisma.tab.update({ where: { id }, data: { paused: true } });
    await status(admin).expect(200);
    expect(stub.callsTo('setActive')).toHaveLength(1);
  });
});
