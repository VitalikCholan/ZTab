import { Body, Controller, Param, ParseUUIDPipe, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const { status, body: out } = await this.tabs.create(id, body);
    res.status(status);
    return out;
  }
}
