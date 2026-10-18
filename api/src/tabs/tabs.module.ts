import { Module } from '@nestjs/common';
import { WatcherModule } from '../watcher/watcher.module.js';
import { CreateTabPipe } from './create-tab.pipe.js';
import { TabsController } from './tabs.controller.js';
import { TabsService } from './tabs.service.js';

@Module({
  imports: [WatcherModule],
  controllers: [TabsController],
  providers: [TabsService, CreateTabPipe],
  exports: [TabsService],
})
export class TabsModule {}
