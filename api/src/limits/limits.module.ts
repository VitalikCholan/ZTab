import { Global, Module, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from './throttler.js';
import type { Request } from 'express';
import {
  DEFAULT_LIMITS,
  LIMITS_OPTIONS,
  isCreateRoute,
  trackerOf,
  type LimitsOptions,
} from './limits.js';

/** Holds the limits so tests can override them through LIMITS_OPTIONS. */
@Global()
@Module({
  providers: [{ provide: LIMITS_OPTIONS, useValue: DEFAULT_LIMITS }],
  exports: [LIMITS_OPTIONS],
})
class LimitsConfigModule {}

const req = (ctx: ExecutionContext): Request =>
  ctx.switchToHttp().getRequest<Request>();

@Module({
  imports: [
    LimitsConfigModule,
    ThrottlerModule.forRootAsync({
      imports: [LimitsConfigModule],
      inject: [LIMITS_OPTIONS],
      useFactory: (limits: LimitsOptions) => ({
        // In-memory storage (default). Each request is counted against exactly
        // one budget: `create` for PUT /tabs/{id}, `default` otherwise.
        getTracker: trackerOf,
        throttlers: [
          {
            name: 'create',
            limit: limits.create.limit,
            ttl: limits.create.ttlMs,
            skipIf: (ctx) => !isCreateRoute(req(ctx)),
          },
          {
            name: 'default',
            limit: limits.default.limit,
            ttl: limits.default.ttlMs,
            skipIf: (ctx) => isCreateRoute(req(ctx)),
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class LimitsModule {}
