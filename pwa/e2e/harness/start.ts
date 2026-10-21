// Playwright global setup: Postgres (the API's test compose file), a fresh `ztab_e2e` database,
// the stub watcher with its control server, and the real API built from source. Returns the
// teardown. Child output goes to e2e/.harness/*.log.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const API = resolve(ROOT, 'api');
export const HARNESS_DIR = resolve(HERE, '../.harness');
export const HARNESS_FILE = resolve(HARNESS_DIR, 'harness.json');

const API_PORT = 3000;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
const PWA_ORIGIN = 'http://127.0.0.1:4173';
const DATABASE_URL = 'postgresql://ztab:ztab@localhost:55432/ztab_e2e';
const WATCHER_TOKEN = 'e2e-watcher-token';

const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });

function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });
}

function spawnLogged(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const log = createWriteStream(resolve(HARNESS_DIR, `${name}.log`));
  // stdin stays a pipe: the stub server exits when it closes, should we die without teardown.
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  return child;
}

function firstLine(child: ChildProcess, name: string): Promise<string> {
  return new Promise((done, fail) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) {
        child.stdout!.off('data', onData);
        done(buf.slice(0, i));
      }
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code) => fail(new Error(`${name} exited (${code}) before it was ready; see e2e/.harness/${name}.log`)));
  });
}

async function waitHealthy(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the API exited (${child.exitCode}); see e2e/.harness/api.log`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the API did not answer ${url} within ${timeoutMs} ms; see e2e/.harness/api.log`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(HARNESS_DIR, { recursive: true });
  if (await portInUse(API_PORT)) throw new Error(`port ${API_PORT} is busy; stop whatever runs there (an API dev server?)`);

  run('pnpm', ['--filter', '@ztab/api', 'db:up'], ROOT);
  const dbEnv = { ...process.env, DATABASE_URL };
  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], API, dbEnv); // creates ztab_e2e if missing
  run(
    'docker',
    ['compose', '-f', 'docker-compose.test.yml', 'exec', '-T', 'postgres', 'psql', '-q', '-U', 'ztab', '-d', 'ztab_e2e', '-c',
      'TRUNCATE TABLE "tab_tokens", "tab_blobs", "tab_addresses", "tabs" RESTART IDENTITY CASCADE'],
    API,
  );
  run('pnpm', ['--filter', '@ztab/api', 'build'], ROOT);

  const children: ChildProcess[] = [];
  const teardown = async () => {
    await Promise.all(children.map(stop));
  };
  try {
    const stubProc = spawnLogged('stub', [resolve(HERE, 'stub-server.ts')], HERE, process.env);
    children.push(stubProc);
    const { stubUrl, controlUrl } = JSON.parse(await firstLine(stubProc, 'stub')) as { stubUrl: string; controlUrl: string };

    const apiProc = spawnLogged('api', ['dist/src/main.js'], API, {
      ...process.env,
      DATABASE_URL,
      WATCHER_URL: stubUrl,
      WATCHER_TOKEN,
      ZTAB_NETWORK: 'test',
      CORS_ORIGIN: PWA_ORIGIN,
      PORT: String(API_PORT),
      RATE_URL: `${controlUrl}/rate-upstream`,
      ZTAB_DISABLE_CRON: '1',
      RATE_LIMIT_CREATE_PER_HOUR: '1000',
      RATE_LIMIT_DEFAULT_PER_MINUTE: '10000',
    });
    children.push(apiProc);
    await waitHealthy(`${API_URL}/healthz`, apiProc, 30_000);

    writeFileSync(HARNESS_FILE, JSON.stringify({ controlUrl, stubUrl, apiUrl: API_URL }));
    process.env.ZTAB_E2E_CONTROL_URL = controlUrl;
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
