import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { WatcherModule } from './watcher/watcher.module.js';
import { TabsModule } from './tabs/tabs.module.js';
import { SweepModule } from './sweep/sweep.module.js';

@Module({
  imports: [ConfigModule, PrismaModule, HealthModule, WatcherModule, TabsModule, SweepModule],
})
export class AppModule {}
