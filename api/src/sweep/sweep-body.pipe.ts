import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { sweepBodySchema, type SweepBody } from './sweep.schemas.js';

/** Validates the POST /sweep body for the configured network (400 `validation`). */
@Injectable()
export class SweepBodyPipe implements PipeTransform<unknown, SweepBody> {
  private readonly schema;

  constructor(@Inject(CONFIG) config: Config) {
    this.schema = sweepBodySchema(config.network);
  }

  transform(value: unknown): SweepBody {
    return this.schema.parse(value);
  }
}
