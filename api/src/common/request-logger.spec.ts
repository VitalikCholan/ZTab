import { request as httpRequest } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requestLogger, ERROR_CODE_LOCAL, type RequestLogLine } from './request-logger.js';

function run(
  path: string,
  status: number,
  code?: string,
  headers: Record<string, string> = {},
): Promise<RequestLogLine[]> {
  const lines: RequestLogLine[] = [];
  const log = requestLogger((l) => lines.push(l));
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(log);
    app.use((_req, res) => {
      res.locals[ERROR_CODE_LOCAL] = code;
      res.status(status).end('{"secret":"body"}');
    });
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const req = httpRequest({ port, host: '127.0.0.1', path, method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => setImmediate(() => server.close(() => resolve(lines))));
      });
      req.on('error', reject);
      req.end('{"ufvk":"uviewtest1x"}');
    });
  });
}

describe('requestLogger', () => {
  it('logs exactly method, path, status and ms; no query string', async () => {
    const lines = await run('/tabs/abc?token=zzz', 201);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(['method', 'ms', 'path', 'status']);
    expect(lines[0]).toMatchObject({ method: 'POST', path: '/tabs/abc', status: 201 });
    expect(typeof lines[0].ms).toBe('number');
  });

  it('adds the error code only for errors, never headers', async () => {
    const lines = await run('/x', 404, 'not_found', { authorization: 'Bearer abc' });
    expect(lines[0].code).toBe('not_found');
    expect(JSON.stringify(lines)).not.toMatch(/Bearer|secret|uviewtest/);
  });
});
