import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StubWatcher } from './stub-watcher.js';
import { truncateAll } from './setup-db.js';
import { TEST_DATABASE_URL } from './test-env.js';

const sha = (t: Buffer) => createHash('sha256').update(t).digest('hex');

describe('logging policy', () => {
  const stub = new StubWatcher();
  let app: INestApplication;
  let prisma: PrismaService;
  const captured: string[] = [];

  beforeAll(async () => {
    await stub.start();
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    process.env.WATCHER_URL = stub.url;
    process.env.ZTAB_NETWORK = 'test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
    await stub.stop();
  });

  it('never logs tokens, blobs, ufvk, addresses or 64-hex strings across create+read+sweep', async () => {
    // Capture everything written to stdout/stderr (Nest's logger writes there)
    // and to the console.
    const restore: Array<() => void> = [];
    const patch = <T extends object, K extends keyof T>(obj: T, key: K) => {
      const original = obj[key];
      (obj as Record<K, unknown>)[key] = (...a: unknown[]) => {
        captured.push(a.map(String).join(' '));
        return true;
      };
      restore.push(() => {
        obj[key] = original;
      });
    };
    patch(process.stdout, 'write');
    patch(process.stderr, 'write');
    patch(console, 'log');
    patch(console, 'error');
    patch(console, 'warn');
    // The testing module silences Nest's logger; turn it fully on.
    Logger.overrideLogger(new ConsoleLogger({ logLevels: ['log', 'error', 'warn', 'debug', 'verbose'] }));

    const id = randomUUID();
    const admin = randomBytes(32);
    const adminB64 = admin.toString('base64url');
    const blobs = { admin: randomBytes(24).toString('base64'), group: randomBytes(24).toString('base64') };
    let put: request.Response, read: request.Response, sweep: request.Response, denied: request.Response;
    try {
      put = await request(app.getHttpServer())
        .put(`/tabs/${id}`)
        .send({
          mode: 'group',
          participants_count: 2,
          ufvk: 'uviewtest1secret',
          birthday: 3_000_000,
          blobs,
          token_hashes: { admin: sha(admin), group: randomBytes(32).toString('hex') },
        });
      read = await request(app.getHttpServer())
        .get(`/tabs/${id}`)
        .set('Authorization', `Bearer ${adminB64}`);
      sweep = await request(app.getHttpServer())
        .post(`/tabs/${id}/sweep`)
        .set('Authorization', `Bearer ${adminB64}`)
        .send({ recipient_address: 'utest1dest' });
      denied = await request(app.getHttpServer())
        .get(`/tabs/${id}`)
        .set('Authorization', `Bearer ${randomBytes(32).toString('base64url')}`);


    } finally {
      restore.forEach((r) => r());
    }
    expect([put.status, read.status, sweep.status, denied.status]).toEqual([201, 200, 200, 404]);

    const out = captured.join('');
    const lines = out.split('\n').filter((l) => l.includes('"method"'));
    expect(lines.length).toBeGreaterThanOrEqual(4); // the policy log exists
    expect(lines.join('\n')).toContain('not_found');
    for (const forbidden of [
      'Bearer',
      adminB64,
      'uviewtest',
      'utest1',
      blobs.admin,
      blobs.group,
    ]) {
      expect(out).not.toContain(forbidden);
    }
    expect(out).not.toMatch(/[0-9a-f]{64}/i);
  });
});
