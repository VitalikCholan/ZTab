import { Module } from '@nestjs/common';
import { RateController } from './rate.controller.js';
import { RATE_OPTIONS, RateService } from './rate.service.js';

@Module({
  controllers: [RateController],
  providers: [RateService, { provide: RATE_OPTIONS, useValue: {} }],
})
export class RateModule {}
