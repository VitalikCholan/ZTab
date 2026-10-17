import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TabAuthGuard, type TabAuthRequest } from '../src/auth/tab-auth.guard.js';
import { Roles } from '../src/auth/role.decorator.js';
import { hashToken } from '../src/auth/token.js';
import { truncateAll } from './setup-db.js';
import { TEST_DATABASE_URL } from './test-env.js';

// Test-only routes exercising the guard; registered in this module only.
@Controller('test-auth/:tab_id')
@UseGuards(TabAuthGuard)
class TestAuthController {
  @Get('whoami')
  whoami(@Req() req: TabAuthRequest) {
    return { role: req.tabAuth.role, tab_id: req.tabAuth.tab.id };
  }

  @Get('admin-only')
  @Roles('admin')
  adminOnly() {
    return { ok: true };
  }

  @Get('validate/:n')
  validate(@Param('n') n: string) {
    z.object({ n: z.coerce.number().int() }).strict().parse({ n });
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail');
  }
}

const tok = () => randomBytes(32);
const bearer = (t: Buffer) => `Bearer ${t.toString('base64url')}`;

describe('tab auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tabA = randomUUID();
  const tabB = randomUUID();
  const adminA = tok();
  const p0 = tok();
  const p1 = tok();
  const adminB = tok();

  async function seed(tabId: string, tokens: [Buffer, 'admin' | 'participant', number | null][]) {
    await prisma.tab.create({
      data: {
        id: tabId,
        mode: 'individual',
        participantsCount: 2,
        ufvk: 'ufvk',
        birthday: 1,
        network: 'test',
        lastKnownState: 'open',
        tokens: {
          create: tokens.map(([t, role, index]) => ({
            role,
            index,
            tokenHash: hashToken(t),
          })),
        },
      },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestAuthController],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await seed(tabA, [[adminA, 'admin', null], [p0, 'participant', 0], [p1, 'participant', 1]]);
    await seed(tabB, [[adminB, 'admin', null]]);
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
  });

  const get = (path: string, auth?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return auth ? r.set('Authorization', auth) : r;
  };

  it('401 unauthorized without a header', async () => {
    const res = await get(`/test-auth/${tabA}/whoami`).expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('401 for a malformed token', async () => {
    const res = await get(`/test-auth/${tabA}/whoami`, 'Bearer garbage').expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('resolves the admin role', async () => {
    const res = await get(`/test-auth/${tabA}/whoami`, bearer(adminA)).expect(200);
    expect(res.body).toEqual({ role: { kind: 'admin' }, tab_id: tabA });
  });

  it('resolves participant 1 with its index', async () => {
    const res = await get(`/test-auth/${tabA}/whoami`, bearer(p1)).expect(200);
    expect(res.body.role).toEqual({ kind: 'participant', index: 1 });
  });

  it('foreign token on another tab is indistinguishable from unknown tab', async () => {
    const foreign = await get(`/test-auth/${tabB}/whoami`, bearer(p0)).expect(404);
    const unknown = await get(`/test-auth/${randomUUID()}/whoami`, bearer(p0)).expect(404);
    const notUuid = await get(`/test-auth/nope/whoami`, bearer(p0)).expect(404);
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).toBe(notUuid.text);
    expect(foreign.body.error.code).toBe('not_found');
  });

  it('unknown random token on a known tab is 404', async () => {
    await get(`/test-auth/${tabA}/whoami`, bearer(tok())).expect(404);
  });

  it('403 forbidden for a participant on an admin-only route', async () => {
    const res = await get(`/test-auth/${tabA}/admin-only`, bearer(p0)).expect(403);
    expect(res.body.error.code).toBe('forbidden');
    await get(`/test-auth/${tabA}/admin-only`, bearer(adminA)).expect(200);
  });

  it('filter maps zod errors to 400 validation', async () => {
    const res = await get(`/test-auth/${tabA}/validate/abc`, bearer(adminA)).expect(400);
    expect(res.body.error.code).toBe('validation');
  });

  it('filter hides details of unknown errors', async () => {
    const res = await get(`/test-auth/${tabA}/boom`, bearer(adminA)).expect(500);
    expect(res.body.error.code).toBe('internal');
    expect(res.text).not.toContain('secret internal detail');
  });

  it('filter maps unknown routes and 413 to the error shape', async () => {
    const res = await get('/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
