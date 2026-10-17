import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '../limits/throttler.js';
import { version } from './version.js';

/** Exempt from rate limiting: probes must never be throttled. */
@SkipThrottle({ default: true, create: true })
@Controller()
export class HealthController {
  @Get('healthz')
  healthz(): { ok: true; version: string } {
    return { ok: true, version };
  }
}
