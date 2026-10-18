import { Module } from '@nestjs/common';
import { WatcherModule } from '../watcher/watcher.module.js';
import { StatusController } from './status.controller.js';
import { STATUS_OPTIONS, StatusService } from './status.service.js';

@Module({
  imports: [WatcherModule],
  controllers: [StatusController],
  providers: [StatusService, { provide: STATUS_OPTIONS, useValue: {} }],
})
export class StatusModule {}
