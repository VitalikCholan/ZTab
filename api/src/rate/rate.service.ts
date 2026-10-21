import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { CONFIG, type Config } from '../config/config.js';

export const RATE_OPTIONS = Symbol('RATE_OPTIONS');

export interface RateOptions {
  /** Clock in ms; injectable so cache expiry is testable. */
  now?: () => number;
  /** Cache lifetime; defaults to 60 s. */
  cacheTtlMs?: number;
}

export interface RateResponse {
  usd_per_zec: number;
  /** RFC 3339 time of the successful upstream fetch. */
  fetched_at: string;
  source: 'coingecko';
}

const DEFAULT_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 5000;

/** Public USD/ZEC price, fetched on demand and cached in-process. */
@Injectable()
export class RateService {
  private readonly logger = new Logger(RateService.name);
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; value: RateResponse } | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Optional() @Inject(RATE_OPTIONS) options?: RateOptions,
  ) {
    this.now = options?.now ?? Date.now;
    this.ttlMs = options?.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  async current(): Promise<RateResponse> {
    const hit = this.cached;
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const at = this.now();
    const usd = await this.fetchUsd();
    const value: RateResponse = {
      usd_per_zec: usd,
      fetched_at: new Date(at).toISOString(),
      source: 'coingecko',
    };
    this.cached = { at, value };
    this.logger.debug(`rate ${usd}`);
    return value;
  }

  private async fetchUsd(): Promise<number> {
    try {
      const res = await fetch(this.config.rateUrl, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { zcash?: { usd?: unknown } } | null;
      const usd = body?.zcash?.usd;
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
        throw new Error('unexpected body');
      }
      return usd;
    } catch (err) {
      this.logger.warn(`rate upstream failed: ${err instanceof Error ? err.name : 'error'}`);
      throw new ApiError(503, 'rate_unavailable', 'exchange rate is unavailable');
    }
  }
}
