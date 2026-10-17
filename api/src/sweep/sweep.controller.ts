import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/role.decorator.js';
import { TabAuthGuard, type TabAuthRequest } from '../auth/tab-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SweepService } from './sweep.service.js';
import {
  broadcastBodySchema,
  sweepBodySchema,
  type BroadcastBody,
  type SweepBody,
} from './sweep.schemas.js';

/** Admin-only proxy to the watcher's sweep flow (spec §6-§7). */
@Controller('tabs/:tab_id')
@UseGuards(TabAuthGuard)
@Roles('admin')
export class SweepController {
  constructor(private readonly sweeps: SweepService) {}

  @Post('sweep')
  @HttpCode(200)
  sweep(
    @Req() req: TabAuthRequest,
    @Body(new ZodValidationPipe(sweepBodySchema)) body: SweepBody,
  ) {
    return this.sweeps.sweep(req.tabAuth.tab, body);
  }

  @Post('broadcast')
  @HttpCode(200)
  broadcast(
    @Req() req: TabAuthRequest,
    @Body(new ZodValidationPipe(broadcastBodySchema)) body: BroadcastBody,
  ) {
    return this.sweeps.broadcast(req.tabAuth.tab, body);
  }

  @Get('sweep')
  status(@Req() req: TabAuthRequest) {
    return this.sweeps.status(req.tabAuth.tab);
  }
}
