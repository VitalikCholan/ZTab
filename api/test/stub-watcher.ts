import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  WatcherHealth,
  WatcherSweepResult,
  WatcherSweepStatus,
  WatcherTab,
} from '../src/watcher/watcher.types.js';

export type StubRoute =
  | 'register'
  | 'getTab'
  | 'setActive'
  | 'sweep'
  | 'broadcast'
  | 'sweepStatus'
  | 'health';

export interface StubCall {
  route: StubRoute;
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

interface Failure {
  status: number;
  message?: string;
}

/**
 * In-process stand-in for the watcher HTTP contract (watcher-spec §6 plus
 * PUT /v1/tabs/{id}/active). Listens on an ephemeral port; reused by the
 * API's e2e tests.
 */
export class StubWatcher {
  readonly calls: StubCall[] = [];
  private server: Server | undefined;
  private readonly tabs = new Map<string, WatcherTab>();
  private readonly failures = new Map<StubRoute, Failure[]>();
  private readonly sweepStatuses = new Map<string, WatcherSweepStatus>();
  private readonly sweepResults = new Map<string, WatcherSweepResult>();
  private readonly registered = new Map<string, string>(); // tab_id -> ufvk
  private delayMs = 0;
  private readonly hooks = new Map<StubRoute, () => Promise<void>>();
  private authToken: string | undefined;
  private healthFacts: WatcherHealth = {
    tip_height: 100,
    synced_height: 100,
    mempool_subscribed: true,
    lag_seconds: 0,
  };

  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Clear scripted state and recorded calls between tests. */
  reset(): void {
    this.calls.length = 0;
    this.tabs.clear();
    this.failures.clear();
    this.sweepStatuses.clear();
    this.sweepResults.clear();
    this.registered.clear();
    this.delayMs = 0;
    this.hooks.clear();
    this.authToken = undefined;
  }

  /**
   * Require `Authorization: Bearer <token>` on every route except
   * /v1/health (like the real watcher); undefined disables the check.
   */
  setAuthToken(token: string | undefined): void {
    this.authToken = token;
  }

  /** Script the facts returned by GET /v1/tabs/{id}. */
  setTab(id: string, tab: Partial<WatcherTab> = {}): void {
    this.tabs.set(id, {
      tab_id: id,
      state: 'open',
      active: true,
      synced_height: 100,
      tip_height: 100,
      stale: false,
      participants: [],
      ...tab,
    });
  }

  setSweepResult(id: string, result: WatcherSweepResult): void {
    this.sweepResults.set(id, result);
  }

  setSweepStatus(id: string, status: WatcherSweepStatus): void {
    this.sweepStatuses.set(id, status);
  }

  setHealth(health: Partial<WatcherHealth>): void {
    this.healthFacts = { ...this.healthFacts, ...health };
  }

  /** Make the next call(s) to `route` fail with `status` and an `{error}` body. */
  failNext(route: StubRoute, status: number, message?: string): void {
    const list = this.failures.get(route) ?? [];
    list.push({ status, message });
    this.failures.set(route, list);
  }

  /** Delay every response by `ms` (0 clears). */
  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /**
   * Pretend `tab_id` is already registered with a different UFVK, so the next
   * registration of it answers 409.
   */
  setRegisterConflict(tabId: string): void {
    this.registered.set(tabId, '\0conflicting-ufvk');
  }

  /** Run `fn` (once) when the next request to `route` arrives, before it is answered. */
  onNext(route: StubRoute, fn: () => Promise<void>): void {
    this.hooks.set(route, fn);
  }

  callsTo(route: StubRoute): StubCall[] {
    return this.calls.filter((c) => c.route === route);
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const route = this.match(method, path);
    const id = path.split('/')[3] ?? '';

    const json = (status: number, payload?: unknown): void => {
      if (payload === undefined) {
        res.writeHead(status).end();
      } else {
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(payload));
      }
    };

    if (!route) {
      json(404, { error: 'not found' });
      return;
    }
    this.calls.push({
      route,
      method,
      path,
      authorization: req.headers.authorization,
      body,
    });

    if (
      this.authToken !== undefined &&
      route !== 'health' &&
      req.headers.authorization !== `Bearer ${this.authToken}`
    ) {
      json(401, { error: 'unauthorized' });
      return;
    }

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    const hook = this.hooks.get(route);
    if (hook) {
      this.hooks.delete(route);
      await hook();
    }

    const failure = this.failures.get(route)?.shift();
    if (failure) {
      json(
        failure.status,
        failure.status >= 500
          ? { error: 'internal' }
          : { error: failure.message ?? 'rejected' },
      );
      return;
    }

    if (route !== 'register' && route !== 'health' && !this.tabs.has(id)) {
      json(404, { error: 'tab not found' });
      return;
    }

    switch (route) {
      case 'register': {
        const b = body as {
          tab_id: string;
          ufvk: string;
          participants_count: number;
        };
        const known = this.registered.get(b.tab_id);
        if (known !== undefined && known !== b.ufvk) {
          json(409, { error: 'tab already registered with a different ufvk' });
          return;
        }
        this.registered.set(b.tab_id, b.ufvk);
        const addresses = Array.from(
          { length: b.participants_count },
          (_, i) => ({ index: i, address: `utest1stub${b.tab_id}x${i}` }),
        );
        if (!this.tabs.has(b.tab_id)) {
          this.setTab(b.tab_id, {
            participants: addresses.map((a) => ({
              ...a,
              payments: [],
              status_facts: {
                confirmed_zat: 0,
                mempool_zat: 0,
                best_confirmations: 0,
                transparent_source: false,
              },
            })),
          });
        }
        json(201, { tab_id: b.tab_id, addresses });
        return;
      }
      case 'getTab': {
        const tab = this.tabs.get(id);
        if (!tab) json(404, { error: 'tab not found' });
        else json(200, tab);
        return;
      }
      case 'setActive': {
        const tab = this.tabs.get(id);
        const active = (body as { active?: unknown } | undefined)?.active;
        if (!tab) json(404, { error: 'tab not found' });
        else if (typeof active !== 'boolean')
          json(422, { error: 'missing active' });
        else {
          tab.active = active;
          json(204);
        }
        return;
      }
      case 'sweep':
        json(
          200,
          this.sweepResults.get(id) ?? {
            pczt_b64: 'c3R1Yi1wY3p0',
            summary: {
              inputs_zat: 100000,
              output_zat: 90000,
              fee_zat: 10000,
              expiry_height: 220,
              txid: 'aa'.repeat(32),
              pending_mempool_zat: 0,
            },
          },
        );
        return;
      case 'broadcast':
        this.tabs.get(id)!.state = 'sweeping';
        json(200, { txid: 'aa'.repeat(32) });
        return;
      case 'sweepStatus':
        json(
          200,
          this.sweepStatuses.get(id) ?? {
            state: 'open',
            txid: null,
            mined_height: null,
            confirmations: 0,
          },
        );
        return;
      case 'health':
        json(200, this.healthFacts);
        return;
    }
  }

  private match(method: string, path: string): StubRoute | undefined {
    if (method === 'GET' && path === '/v1/health') return 'health';
    if (method === 'POST' && path === '/v1/tabs') return 'register';
    const m = /^\/v1\/tabs\/[^/]+(\/(active|sweep|broadcast))?$/.exec(path);
    if (!m) return undefined;
    const tail = m[2];
    if (!tail && method === 'GET') return 'getTab';
    if (tail === 'active' && method === 'PUT') return 'setActive';
    if (tail === 'sweep' && method === 'POST') return 'sweep';
    if (tail === 'sweep' && method === 'GET') return 'sweepStatus';
    if (tail === 'broadcast' && method === 'POST') return 'broadcast';
    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
