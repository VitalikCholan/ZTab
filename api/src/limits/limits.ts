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

/** True for `PUT /tabs/{id}` (the only route under the `create` budget). */
export function isCreateRoute(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'PUT' && /^\/tabs\/[^/]+\/?$/.test(req.path);
}

/**
 * Rate-limit tracker. With `trust proxy` 1, Express resolves `req.ip` to the
 * last X-Forwarded-For hop, i.e. the address the reverse proxy saw.
 */
export function trackerOf(req: Record<string, unknown>): Promise<string> {
  return Promise.resolve(String((req as unknown as Request).ip ?? 'unknown'));
}
