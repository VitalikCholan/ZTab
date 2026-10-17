import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface RequestLogLine {
  method: string;
  path: string;
  status: number;
  ms: number;
  code?: string;
}

/** `res.locals` key under which the exception filter records the error code. */
export const ERROR_CODE_LOCAL = 'errorCode';

/**
 * Per-request log line: method, path, status, duration and, for errors, the
 * error code. Nothing else is ever read from the request or response (no
 * headers, bodies or query string), so nothing sensitive can leak (spec §9).
 */
export function requestLogger(
  sink: (line: RequestLogLine) => void = defaultSink,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const code = res.locals[ERROR_CODE_LOCAL] as string | undefined;
      sink({
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
        ...(code ? { code } : {}),
      });
    });
    next();
  };
}

const logger = new Logger('Http');
function defaultSink(line: RequestLogLine): void {
  logger.log(JSON.stringify(line));
}
