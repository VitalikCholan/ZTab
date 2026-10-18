import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WatcherClient } from '../watcher/watcher.client.js';

const DAY_MS = 86_400_000;
/** Archive after 7 days without access (spec §7.3). */
export const ARCHIVE_AFTER_MS = 7 * DAY_MS;
/** Delete 30 days after `closed_at` (spec §7.5). */
export const PURGE_AFTER_MS = 30 * DAY_MS;
const BATCH_SIZE = 100;

/**
 * Tab lifecycle jobs. A cron timer (not a queue) is enough: both jobs are
 * idempotent, cheap, and safe to repeat if a run is missed or overlaps.
 * Logs carry counts only, never tab ids.
 */
@Injectable()
export class LifecycleService implements OnModuleInit {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watcher: WatcherClient,
  ) {}

  onModuleInit(): void {
    if (process.env.ZTAB_DISABLE_CRON === '1') {
      this.logger.warn('lifecycle cron disabled (ZTAB_DISABLE_CRON=1)');
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async archiveIdleJob(): Promise<void> {
    try {
      await this.archiveIdle(new Date());
    } catch (err) {
      this.logger.error(`archive run failed: ${errorLabel(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeClosedJob(): Promise<void> {
    try {
      await this.purgeClosed(new Date());
    } catch (err) {
      this.logger.error(`purge run failed: ${errorLabel(err)}`);
    }
  }

  /**
   * Pause open tabs nobody has touched for 7 days. The watcher is told first;
   * the row is flipped only afterwards, and only if the tab is still idle, so
   * a failure never leaves a half-archived tab and a concurrent access wins.
   */
  async archiveIdle(now: Date, batchSize = BATCH_SIZE): Promise<number> {
    const cutoff = new Date(now.getTime() - ARCHIVE_AFTER_MS);
    let archived = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.tab.findMany({
        where: {
          paused: false,
          lastKnownState: { in: ['open', 'sweeping'] },
          lastAccessAt: { lt: cutoff },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      for (const { id } of batch) {
        if (await this.archiveOne(id, cutoff, now)) archived++;
      }
      if (batch.length < batchSize) break;
    }
    this.logger.log(`archived ${archived}`);
    return archived;
  }

  private async archiveOne(id: string, cutoff: Date, now: Date): Promise<boolean> {
    // The cached state can be stale for idle tabs: ask the watcher first.
    let state: string | undefined;
    try {
      state = (await this.watcher.getTab(id)).state;
    } catch (err) {
      // 404: the watcher lost the tab, nothing to watch. Otherwise skip.
      if (!(err instanceof ApiError && err.status === 404)) return false;
    }
    if (state !== undefined && state !== 'open') {
      await this.prisma.tab.updateMany({
        where: { id },
        data: {
          lastKnownState: state,
          lastKnownAt: now,
        },
      });
      if (state === 'closed') {
        await this.prisma.tab.updateMany({
          where: { id, closedAt: null },
          data: { closedAt: now },
        });
      }
      return false;
    }
    if (state === undefined) {
      const { count } = await this.prisma.tab.updateMany({
        where: { id, paused: false, lastAccessAt: { lt: cutoff } },
        data: { paused: true },
      });
      return count === 1;
    }
    try {
      await this.watcher.setActive(id, false);
    } catch (err) {
      // 404: the watcher lost the tab, nothing to pause there. Anything else
      // leaves the tab untouched for the next run.
      if (!(err instanceof ApiError && err.status === 404)) return false;
    }
    const { count } = await this.prisma.tab.updateMany({
      where: { id, paused: false, lastAccessAt: { lt: cutoff } },
      data: { paused: true },
    });
    if (count === 1) return true;
    // Accessed meanwhile: undo the watcher-side pause, best effort.
    try {
      await this.watcher.setActive(id, true);
    } catch {
      this.logger.warn('could not undo watcher pause for a tab accessed during archiving');
    }
    return false;
  }

  /**
   * Delete tabs closed more than 30 days ago. Children go via ON DELETE
   * CASCADE, so each delete is a single atomic statement.
   */
  async purgeClosed(now: Date, batchSize = BATCH_SIZE): Promise<number> {
    const cutoff = new Date(now.getTime() - PURGE_AFTER_MS);
    let purged = 0;
    for (;;) {
      const batch = await this.prisma.tab.findMany({
        where: { closedAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (batch.length === 0) break;
      const { count } = await this.prisma.tab.deleteMany({
        where: { id: { in: batch.map((t) => t.id) }, closedAt: { lt: cutoff } },
      });
      purged += count;
      if (batch.length < batchSize) break;
    }
    this.logger.log(`purged ${purged}`);
    return purged;
  }
}

function errorLabel(err: unknown): string {
  if (err instanceof ApiError) return `ApiError ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
