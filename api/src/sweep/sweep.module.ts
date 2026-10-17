import { Module } from '@nestjs/common';
import { TabsModule } from '../tabs/tabs.module.js';
import { WatcherModule } from '../watcher/watcher.module.js';
import { SweepController } from './sweep.controller.js';
import { SweepService } from './sweep.service.js';

@Module({
  imports: [TabsModule, WatcherModule],
  controllers: [SweepController],
  providers: [SweepService],
})
export class SweepModule {}
