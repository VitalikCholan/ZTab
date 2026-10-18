import { Module } from '@nestjs/common';
import { WatcherClient } from './watcher.client.js';

@Module({ providers: [WatcherClient], exports: [WatcherClient] })
export class WatcherModule {}
