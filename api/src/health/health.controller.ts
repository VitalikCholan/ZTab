import { Controller, Get } from '@nestjs/common';
import { version } from './version.js';

@Controller()
export class HealthController {
  @Get('healthz')
  healthz(): { ok: true; version: string } {
    return { ok: true, version };
  }
}
