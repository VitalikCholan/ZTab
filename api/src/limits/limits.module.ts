import { Global, Module, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CONFIG, type Config } from '../config/config.js';
import { ThrottlerGuard, ThrottlerModule } from './throttler.js';
import {
  LIMITS_OPTIONS,
  budgetKey,
  limitsFromConfig,
  usesCreateBudget,
  trackerOf,
  type LimitsOptions,
} from './limits.js';

/** Holds the limits so tests can override them through LIMITS_OPTIONS. */
@Global()
@Module({
  providers: [
    {
      provide: LIMITS_OPTIONS,
      inject: [CONFIG],
      useFactory: (config: Config): LimitsOptions => limitsFromConfig(config),
    },
  ],
  exports: [LIMITS_OPTIONS],
})
class LimitsConfigModule {}

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
        generateKey: budgetKey,
        throttlers: [
          {
            name: 'create',
            limit: limits.create.limit,
            ttl: limits.create.ttlMs,
            skipIf: (ctx) => !usesCreateBudget(ctx.getHandler()),
          },
          {
            name: 'default',
            limit: limits.default.limit,
            ttl: limits.default.ttlMs,
            skipIf: (ctx) => usesCreateBudget(ctx.getHandler()),
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class LimitsModule {}
