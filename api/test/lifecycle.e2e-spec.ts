import { randomBytes, randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import { StubWatcher } from './stub-watcher.js';
import { truncateAll } from './setup-db.js';
import { TEST_DATABASE_URL } from './test-env.js';

const DAY = 86_400_000;

describe('lifecycle', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let lifecycle: LifecycleService;
  const stub = new StubWatcher();
  const now = new Date('2026-10-17T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

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
    lifecycle = app.get(LifecycleService);
  });

  beforeEach(async () => {
    stub.reset();
    stub.setAuthToken('test-token');
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
    await stub.stop();
  });

  async function seed(
    data: {
      lastAccessAt?: Date;
      lastKnownState?: string;
      paused?: boolean;
      closedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.tab.create({
      data: {
        id,
        mode: 'group',
        participantsCount: 1,
        ufvk: 'uviewtest1x',
        birthday: 1,
        network: 'test',
        ...data,
        addresses: { create: [{ index: 0, address: 'utest1a' }] },
        blobs: { create: [{ role: 'admin', index: null, ciphertext: Buffer.from('a') }] },
        tokens: { create: [{ role: 'admin', index: null, tokenHash: randomBytes(32) }] },
      },
    });
    stub.setTab(id);
    return id;
  }

  const paused = async (id: string) =>
    (await prisma.tab.findUniqueOrThrow({ where: { id } })).paused;

  describe('archiveIdle', () => {
    it('archives a tab idle for 7 days and 1 s', async () => {
      const id = await seed({ lastAccessAt: ago(7 * DAY + 1000) });
      expect(await lifecycle.archiveIdle(now)).toBe(1);
      expect(await paused(id)).toBe(true);
      const calls = stub.callsTo('setActive');
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ active: false });
    });

    it('leaves a tab idle for 6 days', async () => {
      const id = await seed({ lastAccessAt: ago(6 * DAY) });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      expect(await paused(id)).toBe(false);
      expect(stub.callsTo('setActive')).toHaveLength(0);
    });

    it('leaves tabs the watcher still reports as sweeping', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY), lastKnownState: 'sweeping' });
      stub.setTab(id, { state: 'sweeping' });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      expect(await paused(id)).toBe(false);
    });

    it('leaves already paused tabs without calling the watcher', async () => {
      await seed({ lastAccessAt: ago(8 * DAY), paused: true });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      expect(stub.callsTo('setActive')).toHaveLength(0);
    });

    it('skips a tab whose watcher call fails and archives the other', async () => {
      const a = await seed({ lastAccessAt: ago(9 * DAY) });
      const b = await seed({ lastAccessAt: ago(8 * DAY) });
      stub.failNext('setActive', 503);
      expect(await lifecycle.archiveIdle(now)).toBe(1);
      const states = [await paused(a), await paused(b)];
      expect(states.filter(Boolean)).toHaveLength(1);
    });

    it('does not archive a tab accessed mid-call, and undoes the watcher pause', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY) });
      stub.onNext('setActive', async () => {
        await prisma.tab.update({ where: { id }, data: { lastAccessAt: now } });
      });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      expect(await paused(id)).toBe(false);
      expect(stub.callsTo('setActive').map((c) => c.body)).toEqual([
        { active: false },
        { active: true },
      ]);
    });

    it('keeps paused=false and warns when the undo fails', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY) });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      stub.onNext('setActive', async () => {
        await prisma.tab.update({ where: { id }, data: { lastAccessAt: now } });
        // Fail the undo (the next setActive request), not this one.
        stub.onNext('setActive', async () => stub.failNext('setActive', 503));
      });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      expect(await paused(id)).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('could not undo'))).toBe(true);
      warn.mockRestore();
    });

    it('does not pause a tab the watcher reports as sweeping, and refreshes the cache', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY) });
      stub.setTab(id, { state: 'sweeping' });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      const tab = await prisma.tab.findUniqueOrThrow({ where: { id } });
      expect(tab.paused).toBe(false);
      expect(tab.lastKnownState).toBe('sweeping');
      expect(tab.lastKnownAt).toEqual(now);
      expect(stub.callsTo('setActive')).toHaveLength(0);
    });

    it('re-checks a cached sweeping tab that is really closed', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY), lastKnownState: 'sweeping' });
      stub.setTab(id, { state: 'closed' });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      const tab = await prisma.tab.findUniqueOrThrow({ where: { id } });
      expect(tab.paused).toBe(false);
      expect(tab.lastKnownState).toBe('closed');
      expect(tab.closedAt).toEqual(now);
    });

    it('records closed tabs with closed_at so purge removes them later', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY) });
      stub.setTab(id, { state: 'closed' });
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      const tab = await prisma.tab.findUniqueOrThrow({ where: { id } });
      expect(tab.paused).toBe(false);
      expect(tab.lastKnownState).toBe('closed');
      expect(tab.closedAt).toEqual(now);
      expect(stub.callsTo('setActive')).toHaveLength(0);
      expect(await lifecycle.purgeClosed(new Date(now.getTime() + 31 * DAY))).toBe(1);
      expect(await prisma.tab.count({ where: { id } })).toBe(0);
    });

    it('leaves a tab unchanged when getTab fails', async () => {
      const id = await seed({ lastAccessAt: ago(8 * DAY) });
      stub.failNext('getTab', 503);
      expect(await lifecycle.archiveIdle(now)).toBe(0);
      expect(await paused(id)).toBe(false);
      expect(stub.callsTo('setActive')).toHaveLength(0);
    });

    it('pauses without a setActive call when getTab says 404', async () => {
      const id = randomUUID();
      await prisma.tab.create({
        data: {
          id, mode: 'group', participantsCount: 1, ufvk: 'u', birthday: 1,
          network: 'test', lastAccessAt: ago(8 * DAY),
        },
      });
      expect(await lifecycle.archiveIdle(now)).toBe(1);
      expect(await paused(id)).toBe(true);
      expect(stub.callsTo('setActive')).toHaveLength(0);
    });

    it('processes more than one batch', async () => {
      for (let i = 0; i < 3; i++) await seed({ lastAccessAt: ago(8 * DAY) });
      expect(await lifecycle.archiveIdle(now, 2)).toBe(3);
    });
  });

  describe('cron wrappers', () => {
    it('catch errors from the runs', async () => {
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const a = jest.spyOn(lifecycle, 'archiveIdle').mockRejectedValueOnce(new Error('db down'));
      const p = jest.spyOn(lifecycle, 'purgeClosed').mockRejectedValueOnce(new Error('db down'));
      await expect(lifecycle.archiveIdleJob()).resolves.toBeUndefined();
      await expect(lifecycle.purgeClosedJob()).resolves.toBeUndefined();
      expect(err).toHaveBeenCalledTimes(2);
      expect(String(err.mock.calls[0][0])).toContain('Error');
      expect(String(err.mock.calls[0][0])).not.toContain('db down');
      a.mockRestore();
      p.mockRestore();
      err.mockRestore();
    });
  });

  describe('purgeClosed', () => {
    it('purges across several batches', async () => {
      for (let i = 0; i < 5; i++) await seed({ lastKnownState: 'closed', closedAt: ago(40 * DAY) });
      expect(await lifecycle.purgeClosed(now, 2)).toBe(5);
      expect(await prisma.tab.count()).toBe(0);
    });

    it('deletes a tab closed 31 days ago with all its rows', async () => {
      const id = await seed({ lastKnownState: 'closed', closedAt: ago(31 * DAY) });
      expect(await lifecycle.purgeClosed(now)).toBe(1);
      expect(await prisma.tab.count({ where: { id } })).toBe(0);
      expect(await prisma.tabAddress.count()).toBe(0);
      expect(await prisma.tabBlob.count()).toBe(0);
      expect(await prisma.tabToken.count()).toBe(0);
    });

    it('keeps a tab closed 29 days ago', async () => {
      const id = await seed({ lastKnownState: 'closed', closedAt: ago(29 * DAY) });
      expect(await lifecycle.purgeClosed(now)).toBe(0);
      expect(await prisma.tab.count({ where: { id } })).toBe(1);
      expect(await prisma.tabToken.count()).toBe(1);
    });

    it('keeps tabs that never closed', async () => {
      await seed({ lastAccessAt: ago(90 * DAY) });
      expect(await lifecycle.purgeClosed(now)).toBe(0);
    });
  });
});
