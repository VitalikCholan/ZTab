import { randomBytes, randomUUID } from 'node:crypto';
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
const facts = (n: number) => ({
  confirmed_zat: n,
  mempool_zat: 0,
  best_confirmations: 3,
  transparent_source: false,
});

const BALANCE = {
  spendable_zat: 1000,
  pending_zat: 200,
  swept_zat: 300,
  min_unspent_confirmations: 3,
};

describe('GET /tabs/:id', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stub = new StubWatcher();

  const admin = randomBytes(32);
  const p0 = randomBytes(32);
  const p1 = randomBytes(32);
  const blobs = { admin: 'YWRtaW4=', p0: 'cDA=', p1: 'cDE=' };
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
        participantsCount: 2,
        ufvk: 'uviewtest1secret',
        birthday: 1,
        network: 'test',
        addresses: {
          create: [
            { index: 0, address: 'utest1a0' },
            { index: 1, address: 'utest1a1' },
          ],
        },
        blobs: {
          create: [
            { role: 'admin', index: null, ciphertext: Buffer.from('admin') },
            { role: 'participant', index: 0, ciphertext: Buffer.from('p0') },
            { role: 'participant', index: 1, ciphertext: Buffer.from('p1') },
          ],
        },
        tokens: {
          create: [
            { role: 'admin', index: null, tokenHash: hashToken(admin) },
            { role: 'participant', index: 0, tokenHash: hashToken(p0) },
            { role: 'participant', index: 1, tokenHash: hashToken(p1) },
          ],
        },
      },
    });
    stub.setTab(id, {
      participants: [
        { index: 0, address: 'utest1a0', payments: [], status_facts: facts(5) },
        { index: 1, address: 'utest1a1', payments: [], status_facts: facts(7) },
      ],
      balance: BALANCE,
    });
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
    await stub.stop();
  });

  const get = (token: Buffer) =>
    request(app.getHttpServer())
      .get(`/tabs/${id}`)
      .set('Authorization', bearer(token));
  const row = () => prisma.tab.findUniqueOrThrow({ where: { id } });

  it('admin sees everything, never the ufvk', async () => {
    const res = await get(admin).expect(200);
    expect(res.body).toMatchObject({
      tab_id: id,
      mode: 'individual',
      participants_count: 2,
      state: 'open',
      stale: false,
      role: 'admin',
      blob: blobs.admin,
      synced_height: 100,
      tip_height: 100,
    });
    expect(res.body.participants).toHaveLength(2);
    expect(res.body.participant_index).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('admin gets balance; participant never does', async () => {
    expect((await get(admin).expect(200)).body.balance).toEqual(BALANCE);
    const res = await get(p1).expect(200);
    expect('balance' in res.body).toBe(false);
    expect(res.text).not.toContain('spendable_zat');
  });

  it('participant sees only its own slice and blob', async () => {
    const res = await get(p1).expect(200);
    expect(res.body.role).toBe('participant');
    expect(res.body.participant_index).toBe(1);
    expect(res.body.blob).toBe(blobs.p1);
    expect(res.body.participants).toEqual([
      { index: 1, address: 'utest1a1', payments: [], status_facts: facts(7) },
    ]);
  });

  it('participant 0 sees its own slice; participant 1 never sees 0 data', async () => {
    const r0 = await get(p0).expect(200);
    expect(r0.body.blob).toBe(blobs.p0);
    expect(r0.body.participants.map((p: { index: number }) => p.index)).toEqual([0]);
    const r1 = await get(p1).expect(200);
    expect(r1.text).not.toContain('utest1a0');
    expect(r1.text).not.toContain(blobs.p0);
  });

  it('group token sees all participants and the group blob', async () => {
    const gid = randomUUID();
    const group = randomBytes(32);
    await prisma.tab.create({
      data: {
        id: gid,
        mode: 'group',
        participantsCount: 2,
        ufvk: 'uviewtest1secret',
        birthday: 1,
        network: 'test',
        addresses: {
          create: [
            { index: 0, address: 'g0' },
            { index: 1, address: 'g1' },
          ],
        },
        blobs: {
          create: [
            { role: 'admin', index: null, ciphertext: Buffer.from('admin') },
            { role: 'group', index: null, ciphertext: Buffer.from('grp') },
          ],
        },
        tokens: {
          create: [{ role: 'group', index: null, tokenHash: hashToken(group) }],
        },
      },
    });
    stub.setTab(gid);
    const res = await request(app.getHttpServer())
      .get(`/tabs/${gid}`)
      .set('Authorization', bearer(group))
      .expect(200);
    expect(res.body.role).toBe('group');
    expect(res.body.blob).toBe(Buffer.from('grp').toString('base64'));
    expect(res.body.participants).toHaveLength(2);
  });

  it('watcher down returns stale snapshot', async () => {
    stub.failNext('getTab', 502);
    const res = await get(admin).expect(200);
    expect(res.body).toMatchObject({
      stale: true,
      state: 'open',
      blob: blobs.admin,
    });
    expect(res.body.synced_height).toBeUndefined();
    expect(res.body.participants.map((p: { address: string }) => p.address)).toEqual([
      'utest1a0',
      'utest1a1',
    ]);
    expect(res.body.participants[0].payments).toEqual([]);
    expect(
      res.body.participants.map((p: { status_facts: unknown }) => p.status_facts),
    ).toEqual([null, null]);
  });

  it('watcher that lost the tab also yields a stale snapshot', async () => {
    stub.failNext('getTab', 404, 'tab not found');
    const res = await get(admin).expect(200);
    expect(res.body.stale).toBe(true);
  });

  it('writes last_access_at at most once a minute', async () => {
    await prisma.tab.update({
      where: { id },
      data: { lastAccessAt: new Date(Date.now() - 120_000) },
    });
    await get(admin).expect(200);
    const first = (await row()).lastAccessAt;
    expect(Date.now() - first.getTime()).toBeLessThan(10_000);
    await get(admin).expect(200);
    expect((await row()).lastAccessAt.getTime()).toBe(first.getTime());
  });

  it('revives a paused tab', async () => {
    await prisma.tab.update({ where: { id }, data: { paused: true } });
    const res = await get(admin).expect(200);
    expect(stub.callsTo('setActive').map((c) => c.body)).toEqual([{ active: true }]);
    expect((await row()).paused).toBe(false);
    expect(res.body).toMatchObject({ stale: false, state: 'open' });
  });

  it('revival failure keeps tab paused', async () => {
    await prisma.tab.update({ where: { id }, data: { paused: true } });
    stub.failNext('setActive', 502);
    const res = await get(admin).expect(200);
    expect(res.body).toMatchObject({ stale: true, state: 'abandoned' });
    expect((await row()).paused).toBe(true);
    await get(admin).expect(200);
    expect(stub.callsTo('setActive')).toHaveLength(2);
    expect((await row()).paused).toBe(false);
  });

  it('records the watcher state and sets closed_at the first time', async () => {
    stub.setTab(id, { state: 'closed' });
    const res = await get(admin).expect(200);
    expect(res.body.state).toBe('closed');
    const first = await row();
    expect(first.lastKnownState).toBe('closed');
    expect(first.lastKnownAt).not.toBeNull();
    expect(first.closedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await prisma.tab.update({ where: { id }, data: { lastKnownAt: new Date(0) } });
    await get(admin).expect(200);
    expect((await row()).closedAt!.getTime()).toBe(first.closedAt!.getTime());
  });

  it('serves the watcher\'s own stale flag with heights present', async () => {
    stub.setTab(id, { stale: true, synced_height: 80, tip_height: 99 });
    const res = await get(admin).expect(200);
    expect(res.body).toMatchObject({ stale: true, synced_height: 80, tip_height: 99 });
  });

  it('self-heals: watcher inactive while the row is unpaused re-activates it', async () => {
    stub.setTab(id, { active: false });
    await get(admin).expect(200);
    expect(stub.callsTo('setActive')).toHaveLength(1);
    expect(stub.callsTo('setActive')[0].body).toEqual({ active: true });
    expect((await row()).paused).toBe(false);
  });

  it('a failing self-heal never fails the GET', async () => {
    stub.setTab(id, { active: false });
    stub.failNext('setActive', 500);
    await get(admin).expect(200);
  });
});
