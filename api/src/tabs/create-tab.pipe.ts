import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { createTabSchema, type CreateTabInput } from './create-tab.schema.js';

/** Validates the PUT /tabs body; a ZodError becomes 400 `validation`. */
@Injectable()
export class CreateTabPipe implements PipeTransform<unknown, CreateTabInput> {
  private readonly schema;

  constructor(@Inject(CONFIG) config: Config) {
    this.schema = createTabSchema(config.network);
  }

  transform(value: unknown): CreateTabInput {
    return this.schema.parse(value);
  }
}
