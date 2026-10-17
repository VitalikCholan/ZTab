import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { version } from '../src/health/version.js';
import { TEST_DATABASE_URL } from './test-env.js';

describe('GET /healthz', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.WATCHER_TOKEN = 'test-token';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok and the package version', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(res.body).toEqual({ ok: true, version });
  });

  it('boots against the compose db and can query it', async () => {
    const prisma = app.get(PrismaService);
    await expect(prisma.tab.count()).resolves.toBe(0);
  });
});
