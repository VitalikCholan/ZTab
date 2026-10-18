import { Module, type DynamicModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WatcherModule } from '../watcher/watcher.module.js';
import { LifecycleService } from './lifecycle.service.js';

/**
 * Cron timers are registered only when ZTAB_DISABLE_CRON is not "1"; the
 * e2e tests set it and call the service methods directly.
 */
const timers: DynamicModule[] =
  process.env.ZTAB_DISABLE_CRON === '1' ? [] : [ScheduleModule.forRoot()];

@Module({
  imports: [...timers, WatcherModule],
  providers: [LifecycleService],
})
export class LifecycleModule {}
