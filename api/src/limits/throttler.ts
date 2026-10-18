/**
 * @nestjs/throttler 6 is CommonJS while @nestjs/common 12 is ESM-only. Under
 * Jest's ESM runtime a static import makes the CJS build `require()` Nest
 * while Nest's own ESM graph is still being linked, which Jest rejects as a
 * require(esm) cycle. Loading it dynamically (top-level await) after the
 * graph is linked avoids that and behaves the same under plain Node.
 */
const throttler = await import('@nestjs/throttler');

export const { ThrottlerGuard, ThrottlerModule, SkipThrottle } = throttler;
