// Smoke for the deployed stack (Caddy + PWA + API + watcher + Postgres), run by deploy/rehearsal.sh
// against https://localhost. Each test guards one way a bad deploy silently breaks the demo.
import { test, expect, type APIResponse } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.SMOKE_BASE_URL ?? 'https://localhost';
const PROJECT = process.env.SMOKE_COMPOSE_PROJECT ?? 'ztab-rehearsal';
const DEPLOY_DIR = path.resolve(__dirname, '..');

// Global Constraints, verbatim.
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const PAGE_HEADERS = {
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'x-content-type-options': 'nosniff',
};

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Caddy's whole log (stdout and stderr), one entry per line. */
function caddyLogs(): string[] {
  return docker(['compose', '-p', PROJECT, 'logs', '--no-log-prefix', '--no-color', 'caddy'])
    .split('\n')
    .filter(Boolean);
}

/** Every value of a header, so a duplicate (Caddy's plus the API's own) is caught. */
function values(res: APIResponse, name: string): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value);
}

function expectPageHeaders(res: APIResponse): void {
  for (const [name, value] of Object.entries(PAGE_HEADERS)) {
    expect(values(res, name), name).toEqual([value]);
  }
}

test('deep link to /t/<id> serves index.html with headers', async ({ request }) => {
  const res = await request.get(`${BASE}/t/0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('<title>ZTab</title>');
  expectPageHeaders(res);
  expect(values(res, 'strict-transport-security')).toEqual([]);
  // A deep link is index.html too: it must not be heuristically cached across deploys.
  expect(res.headers()['cache-control']).toBe('no-cache');
});

test('wasm boots and service worker registers under CSP', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(
        `Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
      );
    });
  });
  const res = await page.goto(`${BASE}/`);
  expect(res?.status()).toBe(200);
  expect(await res?.headerValue('content-security-policy')).toBe(CSP);

  await page.waitForFunction(
    () => ['ready', 'failed'].includes(document.documentElement.dataset.wasm ?? ''),
    null,
    { timeout: 10_000 },
  );
  expect(await page.evaluate(() => document.documentElement.dataset.wasm)).toBe('ready');

  const sw = await page.evaluate(
    () =>
      Promise.race([
        navigator.serviceWorker.ready.then((r) => r.active?.scriptURL ?? 'no active worker'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
      ]),
  );
  expect(sw).toBe(`${BASE}/sw.js`);
  expect(cspErrors).toEqual([]);
});

test('assets are immutable, index is no-cache', async ({ request }) => {
  const index = await request.get(`${BASE}/index.html`);
  expect(index.status()).toBe(200);
  expect(index.headers()['cache-control']).toBe('no-cache');
  const js = /\/assets\/[^"']+\.js/.exec(await index.text())?.[0];
  expect(js, 'index.html references an /assets/*.js bundle').toBeTruthy();

  const asset = await request.get(`${BASE}${js}`);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');

  // No SPA fallback under /assets/: a chunk removed by a redeploy must 404, never come back
  // as index.html cached for a year (nosniff would then break the module load on old tabs).
  const missing = await request.get(`${BASE}/assets/does-not-exist.js`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()['cache-control'] ?? '').not.toContain('immutable');
  expect(await missing.text()).not.toContain('<title>ZTab</title>');

  for (const p of ['/sw.js', '/manifest.webmanifest', '/registerSW.js']) {
    const r = await request.get(`${BASE}${p}`);
    expect(r.status(), p).toBe(200);
    expect(r.headers()['cache-control'], p).toBe('no-cache');
  }
});

test('api is proxied', async ({ request }) => {
  const health = await request.get(`${BASE}/api/healthz`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });
  // Caddy adds only nosniff (and HSTS on real domains) to /api; the API's own copies must not double up.
  expect(values(health, 'x-content-type-options')).toEqual(['nosniff']);
  expect(values(health, 'strict-transport-security')).toEqual([]);

  const status = await request.get(`${BASE}/api/status`);
  expect(status.status()).toBe(200);
  const body = await status.json();
  expect(body.network).toBe('test');
  expect(['ok', 'stale', 'down']).toContain(body.watcher);
  // The watcher's /v1/health answers 200 as soon as it binds, so 'down' here means the API
  // cannot reach the watcher at all (miswired URL or token), not a slow first sync.
  expect(body.watcher).not.toBe('down');
});

test('http redirects; HSTS only on real domains', async ({ request }) => {
  const httpBase = BASE.replace(/^https:/, 'http:');
  const res = await request.get(`${httpBase}/`, { maxRedirects: 0 });
  expect([301, 308]).toContain(res.status());
  expect(res.headers()['location']).toBe(`${BASE}/`);

  for (const p of ['/', '/t/x', '/api/healthz']) {
    const r = await request.get(`${BASE}${p}`);
    expect(values(r, 'strict-transport-security'), p).toEqual([]);
  }
});

test('the same Caddyfile sends HSTS for a real domain, not for sslip.io', async () => {
  // A second, throwaway Caddy on the production Caddyfile with a non-rehearsal DOMAIN
  // (local CA instead of ACME): proves the other branch of the HSTS rule.
  const compose = readFileSync(path.join(DEPLOY_DIR, 'docker-compose.yml'), 'utf8');
  const image = /image:\s*(caddy:\S+)/.exec(compose)?.[1];
  expect(image, 'caddy image in docker-compose.yml').toBeTruthy();
  const site = mkdtempSync(path.join(tmpdir(), 'ztab-hsts-'));
  writeFileSync(path.join(site, 'index.html'), '<title>ZTab</title>');

  async function hsts(domain: string): Promise<string | undefined> {
    const id = docker([
      'run', '-d', '--rm',
      '-e', `DOMAIN=${domain}`, '-e', 'ACME_EMAIL=smoke@example.com', '-e', 'CADDY_LOCAL_CERTS=local_certs',
      '-v', `${path.join(DEPLOY_DIR, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      '-v', `${site}:/srv/pwa:ro`,
      '-p', '127.0.0.1::443',
      image!,
    ]).trim();
    try {
      const port = Number(docker(['port', id, '443/tcp']).trim().split(':').pop());
      for (let attempt = 0; ; attempt++) {
        try {
          return await new Promise((resolve, reject) => {
            const req = https.request(
              {
                host: '127.0.0.1', port, path: '/t/x', servername: domain,
                headers: { host: domain }, rejectUnauthorized: false, timeout: 3000,
              },
              (res) => {
                res.resume();
                if (res.statusCode !== 200) reject(new Error(`status ${res.statusCode}`));
                else resolve(res.headers['strict-transport-security'] as string | undefined);
              },
            );
            req.on('error', reject).on('timeout', () => req.destroy(new Error('timeout'))).end();
          });
        } catch (e) {
          if (attempt >= 40) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } finally {
      docker(['rm', '-f', id]);
    }
  }

  try {
    expect(await hsts('ztab.example')).toBe('max-age=31536000');
    expect(await hsts('203-0-113-7.sslip.io')).toBeUndefined();
    expect(await hsts('203.0.113.7.sslip.io')).toBeUndefined();
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('only 80 and 443 are published', async () => {
  const out = docker(['compose', '-p', PROJECT, 'ps', '--format', 'json']).trim();
  // Compose prints either one JSON object per line or a single array, depending on version.
  const rows: { Service: string; Publishers?: { PublishedPort: number }[] }[] = out.startsWith('[')
    ? JSON.parse(out)
    : out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(rows.map((r) => r.Service).sort()).toEqual(['api', 'caddy', 'postgres', 'watcher']);
  const published = rows.flatMap((r) =>
    (r.Publishers ?? []).filter((p) => p.PublishedPort > 0).map((p) => `${r.Service}:${p.PublishedPort}`),
  );
  expect(published.length).toBeGreaterThan(0);
  for (const p of published) expect(['caddy:80', 'caddy:443']).toContain(p);

  await expect(fetch('http://127.0.0.1:3000/healthz')).rejects.toThrow();
  for (const port of [3000, 8787, 5432]) {
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
    });
    expect(open, `port ${port} reachable from the host`).toBe(false);
  }
});

test('error log has no URIs', async ({ request }) => {
  // Caddy logs handler errors only at >= 500 (4xx are DEBUG), so a 404 alone proves nothing.
  // Stop the API to force real 502 error-log entries for requests that carry the needles,
  // then require that error lines exist and none of them contains a URI, header or IP field.
  const needles = ['does-not-exist', 'secret=1', 'smoke-header-needle', 'remote_ip', 'client_ip'];
  // Slice by line count, not `--since`: Docker Desktop's VM clock can drift from the host's.
  const before = caddyLogs().length;
  await request.get(`${BASE}/api/does-not-exist`);
  await request.get(`${BASE}/t/x?secret=1`);

  docker(['compose', '-p', PROJECT, 'stop', 'api']);
  try {
    for (const p of ['/api/does-not-exist', '/api/tabs/x?secret=1']) {
      const r = await request.get(`${BASE}${p}`, { headers: { 'x-smoke': 'smoke-header-needle' } });
      expect(r.status(), p).toBe(502);
    }
  } finally {
    docker(['compose', '-p', PROJECT, 'start', 'api']);
  }
  await expect
    .poll(async () => (await request.get(`${BASE}/api/healthz`).catch(() => null))?.status(), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(200);

  const lines = caddyLogs().slice(before);
  const logs = lines.join('\n');
  const errorLines = lines.filter((l) => l.includes('http.log.error'));
  expect(errorLines.length, 'Caddy wrote error-log lines for the 502s').toBeGreaterThanOrEqual(2);
  for (const n of needles) expect(logs, n).not.toContain(n);
});
