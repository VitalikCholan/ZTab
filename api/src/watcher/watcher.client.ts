import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { CONFIG, type Config } from '../config/config.js';
import type {
  WatcherBroadcastBody,
  WatcherBroadcastResult,
  WatcherHealth,
  WatcherRegisterBody,
  WatcherRegisterResult,
  WatcherSweepBody,
  WatcherSweepResult,
  WatcherSweepStatus,
  WatcherTab,
} from './watcher.types.js';

export const WATCHER_OPTIONS = Symbol('WATCHER_OPTIONS');

export interface WatcherClientOptions {
  /** Clock in ms; injectable so cache expiry is testable. */
  now?: () => number;
  /** Per-request timeout; defaults to 5 s (spec). */
  timeoutMs?: number;
  /** Cache lifetime of GET /v1/tabs/{id}; defaults to 5 s (spec). */
  cacheTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 10_000;

/**
 * HTTP client for the watcher. No retries. Errors are mapped to ApiError:
 * watcher 4xx -> same status `watcher_rejected` (message verbatim),
 * 5xx / timeout / network failure -> 503 `watcher_unavailable`.
 * Logs carry only the operation name and outcome, never URLs with ids,
 * headers or bodies.
 */
@Injectable()
export class WatcherClient {
  private readonly logger = new Logger(WatcherClient.name);
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { at: number; tab: WatcherTab }>();
  /** Bumped on invalidation so an in-flight getTab cannot cache stale data. */
  private readonly generations = new Map<string, number>();

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Optional() @Inject(WATCHER_OPTIONS) options?: WatcherClientOptions,
  ) {
    this.now = options?.now ?? Date.now;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  registerTab(body: WatcherRegisterBody): Promise<WatcherRegisterResult> {
    return this.request('registerTab', 'POST', '/v1/tabs', body, {
      conflictAsConflict: true,
    });
  }

  async getTab(id: string): Promise<WatcherTab> {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < this.cacheTtlMs) {
      return structuredClone(hit.tab);
    }
    const generation = this.generations.get(id) ?? 0;
    const tab = await this.request<WatcherTab>(
      'getTab',
      'GET',
      `/v1/tabs/${encodeURIComponent(id)}`,
    );
    if ((this.generations.get(id) ?? 0) === generation) {
      this.prune();
      this.cache.set(id, { at: this.now(), tab: structuredClone(tab) });
    }
    return tab;
  }

  private invalidate(id: string): void {
    this.cache.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  /** Drop expired entries; hard-cap the map as a backstop. */
  private prune(): void {
    const t = this.now();
    for (const [key, e] of this.cache) {
      if (t - e.at >= this.cacheTtlMs) this.cache.delete(key);
    }
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async setActive(id: string, active: boolean): Promise<void> {
    try {
      await this.request(
        'setActive',
        'PUT',
        `/v1/tabs/${encodeURIComponent(id)}/active`,
        { active },
        { noContent: true },
      );
    } finally {
      this.invalidate(id);
    }
  }

  async sweep(id: string, body: WatcherSweepBody): Promise<WatcherSweepResult> {
    try {
      return await this.request(
        'sweep',
        'POST',
        `/v1/tabs/${encodeURIComponent(id)}/sweep`,
        body,
      );
    } finally {
      this.invalidate(id);
    }
  }

  async broadcast(
    id: string,
    body: WatcherBroadcastBody,
  ): Promise<WatcherBroadcastResult> {
    try {
      return await this.request(
        'broadcast',
        'POST',
        `/v1/tabs/${encodeURIComponent(id)}/broadcast`,
        body,
      );
    } finally {
      this.invalidate(id);
    }
  }

  sweepStatus(id: string): Promise<WatcherSweepStatus> {
    return this.request(
      'sweepStatus',
      'GET',
      `/v1/tabs/${encodeURIComponent(id)}/sweep`,
    );
  }

  health(): Promise<WatcherHealth> {
    return this.request('health', 'GET', '/v1/health');
  }

  private async request<T>(
    op: string,
    method: string,
    path: string,
    body?: unknown,
    opts: { conflictAsConflict?: boolean; noContent?: boolean } = {},
  ): Promise<T> {
    const base = this.config.watcherUrl.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.config.watcherToken}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'timeout'
          : 'network error';
      this.logger.warn(`watcher ${op}: ${reason}`);
      throw unavailable();
    }

    if (res.ok) {
      if (opts.noContent) {
        await res.body?.cancel();
        return undefined as T;
      }
      try {
        return (await res.json()) as T;
      } catch {
        this.logger.warn(`watcher ${op}: unreadable response`);
        throw unavailable();
      }
    }

    if (res.status === 401 || res.status === 403) {
      // Our own WATCHER_TOKEN is wrong: an operator problem, not the caller's.
      await res.body?.cancel();
      this.logger.error('watcher auth rejected: check WATCHER_TOKEN');
      throw unavailable();
    }

    if (res.status >= 400 && res.status < 500) {
      const message = await readErrorMessage(res);
      this.logger.warn(`watcher ${op}: rejected with ${res.status}`);
      if (res.status === 409 && opts.conflictAsConflict) {
        throw new ApiError(409, 'conflict', message);
      }
      throw new ApiError(res.status, 'watcher_rejected', message, {
        watcher_status: res.status,
      });
    }

    await res.body?.cancel();
    this.logger.warn(`watcher ${op}: failed with ${res.status}`);
    throw unavailable();
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'watcher_unavailable', 'watcher unavailable');
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const parsed: unknown = await res.json();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'string'
    ) {
      return parsed.error;
    }
  } catch {
    // fall through to the generic message
  }
  return 'watcher rejected the request';
}
