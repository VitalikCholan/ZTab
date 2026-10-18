import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { CONFIG, type Config } from './config/config.js';
import { requestLogger } from './common/request-logger.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';

export const BODY_LIMIT = '64kb';

/** App-level setup shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  // req.ip is the last X-Forwarded-For hop. Without exactly one reverse proxy
  // in front, a client could pick its own IP and dodge rate limits, so
  // production must sit behind one proxy (spec §8, §10).
  express.set('trust proxy', 1);
  const config = app.get<Config>(CONFIG);
  express.use(requestLogger());
  express.use(helmet());
  // Only the PWA origin; no cookies, so no credentials.
  express.enableCors({
    // A function, not a string: a string makes the cors package answer every
    // origin with the configured one; here other origins get no CORS headers.
    origin: (origin, cb) => cb(null, origin === config.corsOrigin),
    methods: ['GET', 'PUT', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });
  // After the logger, so body-parser rejections (413, bad JSON) are logged too.
  express.useBodyParser('json', { limit: BODY_LIMIT });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
}
