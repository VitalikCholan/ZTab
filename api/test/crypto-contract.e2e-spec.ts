import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createMaster,
  deriveTabKeys,
  encodeToken,
  hashToken,
  openBlob,
  sealBlob,
} from '@ztab/crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { LIMITS_OPTIONS } from '../src/limits/limits.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { configureApp } from '../src/setup.js';
import { truncateAll } from './setup-db.js';
import { StubWatcher } from './stub-watcher.js';
import { TEST_DATABASE_URL } from './test-env.js';

// Syntactically plausible test-network UFVK; the stub watcher does not parse it.
const UFVK = 'uviewtest10ff4c0qk6sneplhnr5h53lw9j4n2a4af7j6spgy5sh67xfcfje3mpwdurusf590p2usjt7d07q952xyv2eqjudd568nqun8qqvcfjz2qmtw9ttkqtygkrmhku885eez4dhztlnev8cleaxqdtakgk9et8t4d6n2ll8fm3vp9efwre8tf42t35esdgz89w';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../crypto/test/fixtures/hkdf.json', import.meta.url),
    'utf8',
  ),
) as { masterHex: string; tabId: string; tokenHex: { admin: string; group: string } };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bearer = (token: Uint8Array) => `Bearer ${encodeToken(token)}`;

describe('@ztab/crypto contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stub = new StubWatcher();

  beforeAll(async () => {
    await stub.start();
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    process.env.WATCHER_URL = stub.url;
    process.env.ZTAB_NETWORK = 'test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LIMITS_OPTIONS)
      .useValue({
        create: { limit: 10_000, ttlMs: 60_000 },
        createGlobal: { limit: 10_000, ttlMs: 60_000 },
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
    await app.close();
    await stub.stop();
  });

  it('accepts hashes derived by the browser package and authenticates its tokens', async () => {
    const tabId = randomUUID();
    const master = createMaster();
    const keys = await deriveTabKeys(master, tabId, 'individual', 2);
    const tokens = keys.tokens;
    const participants = keys.participants!;
    const secrets = ['alice owes 10', 'bob owes 20'];

    const sealedAdmin = await sealBlob(keys.admin, { everyone: secrets });
    const sealed = await Promise.all(
      participants.map((k, i) => sealBlob(k, { share: secrets[i] })),
    );

    const put = await request(app.getHttpServer())
      .put(`/tabs/${tabId}`)
      .send({
        mode: 'individual',
        participants_count: 2,
        ufvk: UFVK,
        birthday: 3_000_000,
        blobs: { admin: b64(sealedAdmin), participants: sealed.map(b64) },
        token_hashes: {
          admin: await hashToken(tokens.admin),
          participants: await Promise.all(tokens.participants!.map(hashToken)),
        },
      });
    expect(put.status).toBe(201);

    const asP1 = await request(app.getHttpServer())
      .get(`/tabs/${tabId}`)
      .set('Authorization', bearer(tokens.participants![1]));
    expect(asP1.status).toBe(200);
    expect(asP1.body.role).toBe('participant');
    expect(asP1.body.participants).toHaveLength(1);
    expect(asP1.body.participants[0].index).toBe(1);
    const opened = await openBlob(
      participants[1],
      new Uint8Array(Buffer.from(asP1.body.blob, 'base64')),
    );
    expect(opened).toEqual({ share: secrets[1] });

    const asAdmin = await request(app.getHttpServer())
      .get(`/tabs/${tabId}`)
      .set('Authorization', bearer(tokens.admin));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.role).toBe('admin');
    expect(asAdmin.body.participants.map((p: { index: number }) => p.index)).toEqual([0, 1]);
    expect(
      await openBlob(keys.admin, new Uint8Array(Buffer.from(asAdmin.body.blob, 'base64'))),
    ).toEqual({ everyone: secrets });

    // Another participant's token cannot read this blob or key.
    await expect(
      openBlob(participants[0], new Uint8Array(Buffer.from(asP1.body.blob, 'base64'))),
    ).rejects.toThrow();
  });

  it('pins the ztab/v1/token port: fixture master and tab_id authenticate end to end', async () => {
    const master = new Uint8Array(Buffer.from(fixture.masterHex, 'hex'));
    const keys = await deriveTabKeys(master, fixture.tabId, 'group', 3);
    expect(Buffer.from(keys.tokens.admin).toString('hex')).toBe(fixture.tokenHex.admin);
    expect(Buffer.from(keys.tokens.group!).toString('hex')).toBe(fixture.tokenHex.group);

    const put = await request(app.getHttpServer())
      .put(`/tabs/${fixture.tabId}`)
      .send({
        mode: 'group',
        participants_count: 3,
        ufvk: UFVK,
        birthday: 3_000_000,
        blobs: {
          admin: b64(await sealBlob(keys.admin, { a: 1 })),
          group: b64(await sealBlob(keys.group!, { g: 1 })),
        },
        token_hashes: {
          admin: await hashToken(keys.tokens.admin),
          group: await hashToken(keys.tokens.group!),
        },
      });
    expect(put.status).toBe(201);

    const get = await request(app.getHttpServer())
      .get(`/tabs/${fixture.tabId}`)
      .set('Authorization', bearer(keys.tokens.group!));
    expect(get.status).toBe(200);
    expect(get.body.role).toBe('group');
  });
});
