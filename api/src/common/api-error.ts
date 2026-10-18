export type ApiErrorCode =
  | 'validation'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'rate_limited'
  | 'watcher_unavailable'
  | 'watcher_rejected'
  | 'internal';

/** Error with an HTTP status and a stable machine code (spec §6). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Extra top-level fields inside `error`, e.g. `watcher_status`. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
