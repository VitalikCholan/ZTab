import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const LIMITS_OPTIONS = Symbol('LIMITS_OPTIONS');

export interface LimitRule {
  limit: number;
  ttlMs: number;
}

export interface LimitsOptions {
  /** PUT /tabs/{id}: tab creation. */
  create: LimitRule;
  /** Every other route except /healthz. */
  default: LimitRule;
}

/** Spec §8: 10 creations per hour, 120 other requests per minute, per IP. */
export const DEFAULT_LIMITS: LimitsOptions = {
  create: { limit: 10, ttlMs: 3_600_000 },
  default: { limit: 120, ttlMs: 60_000 },
};

/** Limits from the environment (RATE_LIMIT_*); defaults equal DEFAULT_LIMITS. */
export function limitsFromConfig(config: {
  rateLimitCreatePerHour: number;
  rateLimitDefaultPerMinute: number;
}): LimitsOptions {
  return {
    create: { limit: config.rateLimitCreatePerHour, ttlMs: 3_600_000 },
    default: { limit: config.rateLimitDefaultPerMinute, ttlMs: 60_000 },
  };
}

const CREATE_BUDGET = 'ztab:create-budget';

/**
 * Marks a handler as tab creation: it is counted against the `create` budget
 * instead of `default`. Bound to the handler, not the URL, so Express's
 * case-insensitive routing cannot dodge it; any route without it gets `default`.
 */
export const CreateBudget = () => SetMetadata(CREATE_BUDGET, true);

export function usesCreateBudget(handler: Function): boolean {
  return Reflect.getMetadata(CREATE_BUDGET, handler) === true;
}

/** One counter per named budget and client, shared by every route. */
export function budgetKey(_ctx: ExecutionContext, tracker: string, name: string): string {
  return `${name}:${tracker}`;
}

/**
 * Rate-limit tracker. With `trust proxy` 1, Express resolves `req.ip` to the
 * last X-Forwarded-For hop, i.e. the address the reverse proxy saw.
 */
export function trackerOf(req: Record<string, unknown>): Promise<string> {
  return Promise.resolve(String((req as unknown as Request).ip ?? 'unknown'));
}
