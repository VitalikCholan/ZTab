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
  warn: (message: string) => void = defaultWarn,
) {
  let warned = false;
  return (req: Request, res: Response, next: NextFunction): void => {
    // Spec §12: without a proxy header, rate limits key on the socket address.
    if (!warned && req.headers['x-forwarded-for'] === undefined) {
      warned = true;
      warn(MISSING_XFF_WARNING);
    }
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

export const MISSING_XFF_WARNING =
  'X-Forwarded-For missing: rate limits key on the socket address; run behind exactly one reverse proxy';

const logger = new Logger('Http');
function defaultWarn(message: string): void {
  logger.warn(message);
}
function defaultSink(line: RequestLogLine): void {
  logger.log(JSON.stringify(line));
}
