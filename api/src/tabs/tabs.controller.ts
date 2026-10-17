import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TabAuthGuard, type TabAuthRequest } from '../auth/tab-auth.guard.js';
import { CreateTabPipe } from './create-tab.pipe.js';
import type { CreateTabInput } from './create-tab.schema.js';
import { TabsService } from './tabs.service.js';

@Controller('tabs')
export class TabsController {
  constructor(private readonly tabs: TabsService) {}

  @Put(':id')
  async create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(CreateTabPipe) body: CreateTabInput,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { status, body: out } = await this.tabs.create(id, body, authorization);
    res.status(status);
    return out;
  }

  @Get(':tab_id')
  @UseGuards(TabAuthGuard)
  read(@Req() req: TabAuthRequest) {
    return this.tabs.read(req.tabAuth.tab, req.tabAuth.role);
  }
}
