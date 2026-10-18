import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { CONFIG, type Config } from './config/config.js';
import { configureApp } from './setup.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureApp(app);
  const config = app.get<Config>(CONFIG);
  await app.listen(config.port);
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'startup failed');
  process.exit(1);
});
