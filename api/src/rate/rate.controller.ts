import { Controller, Get } from '@nestjs/common';
import { RateService, type RateResponse } from './rate.service.js';

@Controller('rate')
export class RateController {
  constructor(private readonly rate: RateService) {}

  @Get()
  get(): Promise<RateResponse> {
    return this.rate.current();
  }
}
