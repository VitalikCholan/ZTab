// Child process started by the Playwright global setup (`node stub-server.ts`; Node 24 strips the
// types). Runs the API's StubWatcher plus a control server the test workers drive over HTTP, and
// a fake rate upstream. Prints one JSON line `{stubUrl, controlUrl}` on stdout once listening.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveAddress, loadWasm } from '@ztab/crypto';
import { StubWatcher } from '../../../api/test/stub-watcher.ts';
import type { WatcherParticipant, WatcherTab } from '../../../api/src/watcher/watcher.types.ts';

export const WATCHER_TOKEN = 'e2e-watcher-token';
export const USD_PER_ZEC = 400.5;

await loadWasm(new Uint8Array(readFileSync(new URL('../../../crypto/pkg/ztab_crypto_bg.wasm', import.meta.url))));

const stub = new StubWatcher();

/** Real addresses, so the PWA's local address check (deriveAddress over the UFVK) passes. */
function configure(): void {
  stub.setAuthToken(WATCHER_TOKEN);
  stub.setRegisterAddresses((b) =>
    Array.from({ length: b.participants_count }, (_, i) => ({ index: i, address: deriveAddress('test', b.ufvk, i) })),
  );
}
configure();
await stub.start();

// The stub keeps its scripted tabs private and `setTab` replaces a tab wholesale; the patch
// helpers below read the current tab so a test can change one field without restating the rest.
const tabs = (stub as unknown as { tabs: Map<string, WatcherTab> }).tabs;
const current = (id: string): WatcherTab => {
  const tab = tabs.get(id);
  if (!tab) throw new Error(`unknown tab ${id}`);
  return structuredClone(tab);
};

const methods: Record<string, (...args: never[]) => unknown> = {
  reset: () => {
    stub.reset();
    configure();
  },
  setTab: (id: string, tab: Partial<WatcherTab>) => stub.setTab(id, tab),
  patchTab: (id: string, patch: Partial<WatcherTab>) => stub.setTab(id, { ...current(id), ...patch }),
  patchParticipant: (id: string, index: number, patch: Partial<WatcherParticipant>) => {
    const tab = current(id);
    tab.participants = tab.participants.map((p) => (p.index === index ? { ...p, ...patch } : p));
    stub.setTab(id, tab);
  },
  getTab: (id: string) => current(id),
  setSweepResult: (id: string, r: Parameters<StubWatcher['setSweepResult']>[1]) => stub.setSweepResult(id, r),
  setSweepStatus: (id: string, s: Parameters<StubWatcher['setSweepStatus']>[1]) => stub.setSweepStatus(id, s),
  setHealth: (h: Parameters<StubWatcher['setHealth']>[0]) => stub.setHealth(h),
  failNext: (route: Parameters<StubWatcher['failNext']>[0], status: number, message?: string) =>
    stub.failNext(route, status, message),
  callsTo: (route: Parameters<StubWatcher['callsTo']>[0]) => stub.callsTo(route),
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload ?? null));
  };
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/rate-upstream') return send(200, { zcash: { usd: USD_PER_ZEC } });
  const m = /^\/__control\/(\w+)$/.exec(path);
  const fn = m ? methods[m[1]] : undefined;
  if (req.method !== 'POST' || !fn) return send(404, { error: 'not found' });
  try {
    const raw = await readBody(req);
    const args = raw ? (JSON.parse(raw) as never[]) : [];
    send(200, { result: fn(...args) });
  } catch (e) {
    send(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

const control = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;

const shutdown = async () => {
  control.closeAllConnections();
  control.close();
  await stub.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
// The parent holds our stdin open; when it dies without killing us, stdin ends and we leave too.
process.stdin.on('end', () => void shutdown());
process.stdin.resume();

process.stdout.write(`${JSON.stringify({ stubUrl: stub.url, controlUrl })}\n`);
