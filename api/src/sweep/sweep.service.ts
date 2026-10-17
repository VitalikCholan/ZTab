import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import type { Tab } from '../generated/prisma/client.js';
import { TabsService } from '../tabs/tabs.service.js';
import { WatcherClient } from '../watcher/watcher.client.js';
import type {
  WatcherBroadcastResult,
  WatcherSweepResult,
  WatcherSweepStatus,
} from '../watcher/watcher.types.js';
import type { BroadcastBody, SweepBody } from './sweep.schemas.js';

@Injectable()
export class SweepService {
  constructor(
    private readonly tabs: TabsService,
    private readonly watcher: WatcherClient,
  ) {}

  async sweep(tab: Tab, body: SweepBody): Promise<WatcherSweepResult> {
    await this.active(tab);
    return this.watcher.sweep(tab.id, { recipient_address: body.recipient_address });
  }

  async broadcast(tab: Tab, body: BroadcastBody): Promise<WatcherBroadcastResult> {
    await this.active(tab);
    return this.watcher.broadcast(tab.id, { pczt_b64: body.pczt_b64 });
  }

  async status(tab: Tab): Promise<WatcherSweepStatus> {
    await this.active(tab);
    return this.watcher.sweepStatus(tab.id);
  }

  /** The watcher refuses a paused tab's work, so a failed revival stops here. */
  private async active(tab: Tab): Promise<void> {
    if (!(await this.tabs.ensureActive(tab))) {
      throw new ApiError(503, 'watcher_unavailable', 'watcher is unavailable');
    }
  }
}
