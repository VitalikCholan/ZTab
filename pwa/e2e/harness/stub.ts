// Test-side client of the stub watcher's control server (see stub-server.ts).
import { readFileSync } from 'node:fs';
import type { StubCall, StubRoute } from '../../../api/test/stub-watcher.ts';
import type {
  WatcherParticipant,
  WatcherSweepResult,
  WatcherSweepStatus,
  WatcherTab,
} from '../../../api/src/watcher/watcher.types.ts';
import { HARNESS_FILE } from './start.ts';

function controlUrl(): string {
  const fromEnv = process.env.ZTAB_E2E_CONTROL_URL;
  if (fromEnv) return fromEnv;
  return (JSON.parse(readFileSync(HARNESS_FILE, 'utf8')) as { controlUrl: string }).controlUrl;
}

async function call<T = void>(method: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`${controlUrl()}/__control/${method}`, { method: 'POST', body: JSON.stringify(args) });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok) throw new Error(`stub.${method}: ${body.error ?? res.status}`);
  return body.result as T;
}

export const stub = {
  reset: () => call('reset'),
  /** Replaces the tab's watcher facts (unspecified fields take the stub's defaults). */
  setTab: (id: string, tab: Partial<WatcherTab>) => call('setTab', id, tab),
  /** Changes some fields of the tab's facts, keeping the rest. */
  patchTab: (id: string, patch: Partial<WatcherTab>) => call('patchTab', id, patch),
  patchParticipant: (id: string, index: number, patch: Partial<WatcherParticipant>) =>
    call('patchParticipant', id, index, patch),
  getTab: (id: string) => call<WatcherTab>('getTab', id),
  setSweepResult: (id: string, r: WatcherSweepResult) => call('setSweepResult', id, r),
  setSweepStatus: (id: string, s: WatcherSweepStatus) => call('setSweepStatus', id, s),
  callsTo: (route: StubRoute) => call<StubCall[]>('callsTo', route),
};
