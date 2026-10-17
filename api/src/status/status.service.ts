import { Inject, Injectable, Optional } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { WatcherClient } from '../watcher/watcher.client.js';

export const STATUS_OPTIONS = Symbol('STATUS_OPTIONS');

export interface StatusOptions {
  /** Clock in ms; injectable so cache expiry is testable. */
  now?: () => number;
  /** Cache lifetime; defaults to 5 s (spec §8). */
  cacheTtlMs?: number;
}

export interface StatusBody {
  network: 'test' | 'main';
  tip_height: number | null;
  synced_height: number | null;
  lag_seconds: number | null;
  watcher: 'ok' | 'stale' | 'down';
  block_interval_seconds: number;
}

const DEFAULT_TTL_MS = 5000;
/** Zcash target spacing after Blossom is 75 s; the testnet cohort uses 25 s (NU7 config). */
const BLOCK_INTERVAL_SECONDS = { test: 25, main: 75 } as const;

/** Public chain status; says nothing about tabs. Cached to spare the watcher. */
@Injectable()
export class StatusService {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; value: Promise<StatusBody> } | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly watcher: WatcherClient,
    @Optional() @Inject(STATUS_OPTIONS) options?: StatusOptions,
  ) {
    this.now = options?.now ?? Date.now;
    this.ttlMs = options?.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  get(): Promise<StatusBody> {
    const hit = this.cached;
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    // Cache the promise so concurrent callers share one watcher call.
    const value = this.compute();
    this.cached = { at: this.now(), value };
    return value;
  }

  private async compute(): Promise<StatusBody> {
    const interval = BLOCK_INTERVAL_SECONDS[this.config.network];
    const base = { network: this.config.network, block_interval_seconds: interval };
    try {
      const h = await this.watcher.health();
      return {
        ...base,
        tip_height: h.tip_height,
        synced_height: h.synced_height,
        lag_seconds: h.lag_seconds,
        watcher: h.lag_seconds > 3 * interval ? 'stale' : 'ok',
      };
    } catch {
      return {
        ...base,
        tip_height: null,
        synced_height: null,
        lag_seconds: null,
        watcher: 'down',
      };
    }
  }
}
