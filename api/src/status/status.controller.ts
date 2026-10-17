import { Controller, Get } from '@nestjs/common';
import { StatusService, type StatusBody } from './status.service.js';

@Controller('status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  get(): Promise<StatusBody> {
    return this.status.get();
  }
}
