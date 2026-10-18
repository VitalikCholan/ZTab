import { encodeToken } from '@ztab/crypto';
import type { RateResponse, StatusResponse, SweepOffer, SweepStatus, TabView } from './types.ts';

/** Body of `PUT /tabs/{id}` (api/src/tabs/create-tab.schema.ts). Blobs are standard base64, hashes lowercase hex. */
export interface CreateTabBody {
  mode: 'group' | 'individual';
  participants_count: number;
  ufvk: string;
  birthday: number;
  blobs: { admin: string; group?: string; participants?: string[] };
  token_hashes: { admin: string; group?: string; participants?: string[] };
}

export interface TabAddress {
  index: number;
  address: string;
}

export interface CreateTabResult {
  status: 200 | 201;
  tabId: string;
  addresses: TabAddress[];
}

/**
 * An API failure. `code` is the API's `error.code`, or `network` (no response at all) or
 * `invalid_response` (a body that is not the expected JSON). `status` is 0 for `network`.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly watcherStatus?: number;

  constructor(status: number, code: string, message: string, watcherStatus?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    if (watcherStatus !== undefined) this.watcherStatus = watcherStatus;
  }
}

interface RequestOptions {
  token?: Uint8Array;
  body?: unknown;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  status(): Promise<StatusResponse> {
    return this.json<StatusResponse>('GET', '/status');
  }

  rate(): Promise<RateResponse> {
    return this.json<RateResponse>('GET', '/rate');
  }

  /** First attempt: never carries a token (the tab has none yet). */
  createTab(id: string, body: CreateTabBody): Promise<CreateTabResult> {
    return this.put(id, body);
  }

  /** Retry after a lost response: the API demands the admin token and identical hashes. */
  retryCreate(id: string, body: CreateTabBody, adminToken: Uint8Array): Promise<CreateTabResult> {
    return this.put(id, body, adminToken);
  }

  getTab(id: string, token: Uint8Array): Promise<TabView> {
    return this.json<TabView>('GET', `/tabs/${enc(id)}`, { token });
  }

  sweep(id: string, token: Uint8Array, recipient: string): Promise<SweepOffer> {
    return this.json<SweepOffer>('POST', `/tabs/${enc(id)}/sweep`, { token, body: { recipient_address: recipient } });
  }

  broadcast(id: string, token: Uint8Array, pcztB64: string): Promise<{ txid: string }> {
    return this.json<{ txid: string }>('POST', `/tabs/${enc(id)}/broadcast`, { token, body: { pczt_b64: pcztB64 } });
  }

  sweepStatus(id: string, token: Uint8Array): Promise<SweepStatus> {
    return this.json<SweepStatus>('GET', `/tabs/${enc(id)}/sweep`, { token });
  }

  private async put(id: string, body: CreateTabBody, token?: Uint8Array): Promise<CreateTabResult> {
    const { status, data } = await this.request('PUT', `/tabs/${enc(id)}`, { token, body });
    const out = data as { tab_id?: unknown; addresses?: unknown };
    if ((status !== 200 && status !== 201) || typeof out.tab_id !== 'string' || !Array.isArray(out.addresses)) {
      throw new ApiRequestError(status, 'invalid_response', 'unexpected response to PUT /tabs');
    }
    return { status, tabId: out.tab_id, addresses: out.addresses as TabAddress[] };
  }

  private async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.request(method, path, opts)).data as T;
  }

  private async request(method: string, path: string, opts: RequestOptions): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${encodeToken(opts.token)}`;
    const init: RequestInit = { method, headers, cache: 'no-store', credentials: 'omit' };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      text = await res.text();
    } catch {
      throw new ApiRequestError(0, 'network', 'the network request failed');
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiRequestError(res.status, 'invalid_response', 'the response is not JSON');
    }
    if (data === null || typeof data !== 'object') {
      throw new ApiRequestError(res.status, 'invalid_response', 'the response is not a JSON object');
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: unknown; message?: unknown; watcher_status?: unknown } }).error;
      if (!err || typeof err.code !== 'string') {
        throw new ApiRequestError(res.status, 'invalid_response', `HTTP ${res.status} without an error body`);
      }
      throw new ApiRequestError(
        res.status,
        err.code,
        typeof err.message === 'string' ? err.message : err.code,
        typeof err.watcher_status === 'number' ? err.watcher_status : undefined,
      );
    }
    return { status: res.status, data };
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}
