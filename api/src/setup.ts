import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const BODY_LIMIT = '64kb';

/** App-level setup shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1);
  express.useBodyParser('json', { limit: BODY_LIMIT });
  app.enableShutdownHooks();
}
