import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError, type ApiErrorCode } from './api-error.js';

function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 400:
    case 413:
    case 415:
    case 422:
      return 'validation';
    default:
      return status >= 500 ? 'internal' : 'validation';
  }
}

/** Renders every error as `{ error: { code, message } }`. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    let status: number;
    let code: ApiErrorCode;
    let message: string;
    let extra: Record<string, unknown> | undefined;

    if (exception instanceof ApiError) {
      ({ status, code, message, extra } = exception);
    } else if (exception instanceof ZodError) {
      status = 400;
      code = 'validation';
      message = exception.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; ');
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeForStatus(status);
      message =
        status >= 500
          ? 'internal error'
          : exception.cause instanceof SyntaxError || isJsonParseMessage(exception)
            ? 'invalid JSON'
            : httpMessage(exception, status);
    } else if (exception instanceof SyntaxError && clientStatus(exception)) {
      status = 400;
      code = 'validation';
      message = 'invalid JSON';
    } else if (clientStatus(exception)) {
      // Library errors such as body-parser's PayloadTooLargeError.
      status = clientStatus(exception)!;
      code = codeForStatus(status);
      message = status === 413 ? 'request body too large' : 'bad request';
    } else {
      status = 500;
      code = 'internal';
      message = 'internal error';
    }

    if (status >= 500) {
      // Method, path and error class only; never bodies, headers or messages.
      const name = exception instanceof Error ? exception.name : 'unknown';
      this.logger.error(`${req.method} ${req.path} ${status} ${code} ${name}`);
    }

    res.status(status).json({ error: { ...extra, code, message } });
  }
}

function httpMessage(e: HttpException, status: number): string {
  if (status === 404) return 'not found';
  if (status === 413) return 'request body too large';
  if (status === 429) return 'too many requests';
  const r = e.getResponse();
  if (typeof r === 'string') return r;
  const m = (r as { message?: unknown }).message;
  return typeof m === 'string' ? m : e.message;
}

/** 4xx status carried by http-errors style objects, if any. */
function clientStatus(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const o = e as { status?: unknown; statusCode?: unknown };
  const n = typeof o.status === 'number' ? o.status : o.statusCode;
  return typeof n === 'number' && n >= 400 && n <= 499 ? n : null;
}

/** Nest wraps body-parser's JSON SyntaxError in a BadRequestException. */
function isJsonParseMessage(e: HttpException): boolean {
  return e.getStatus() === 400 && /JSON/.test(e.message);
}
