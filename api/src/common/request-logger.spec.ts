import { request as httpRequest } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requestLogger, ERROR_CODE_LOCAL, MISSING_XFF_WARNING, type RequestLogLine } from './request-logger.js';

function run(
  path: string,
  status: number,
  code?: string,
  headers: Record<string, string> = {},
  warn: (m: string) => void = () => undefined,
  mw?: ReturnType<typeof requestLogger>,
): Promise<RequestLogLine[]> {
  const lines: RequestLogLine[] = [];
  const log = mw ?? requestLogger((l) => lines.push(l), warn);
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

  it('warns once per logger when X-Forwarded-For is missing, never when present', async () => {
    const warnings: string[] = [];
    const mw = requestLogger(() => undefined, (m) => warnings.push(m));
    await run('/a', 200, undefined, {}, undefined, mw);
    await run('/b', 200, undefined, {}, undefined, mw);
    expect(warnings).toEqual([MISSING_XFF_WARNING]);

    const quiet: string[] = [];
    await run('/c', 200, undefined, { 'x-forwarded-for': '1.2.3.4' }, (m) => quiet.push(m));
    expect(quiet).toEqual([]);
  });
});
