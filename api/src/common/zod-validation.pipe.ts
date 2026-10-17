import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates a body against a zod schema; a ZodError becomes 400 `validation`. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
