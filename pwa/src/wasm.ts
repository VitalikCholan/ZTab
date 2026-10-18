import { loadWasm, wasmVersion } from '@ztab/crypto';
import { useSyncExternalStore } from 'react';

export type WasmState = 'loading' | 'ready' | 'failed';

let state: WasmState = 'loading';
let started: Promise<void> | undefined;
const listeners = new Set<() => void>();

function set(next: WasmState): void {
  state = next;
  document.documentElement.dataset.wasm = next;
  listeners.forEach((l) => l());
}

export function wasmState(): WasmState {
  return state;
}

export function useWasmState(): WasmState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Loads the crypto module once; retries 3 times before marking it failed. */
export function ensureWasm(): Promise<void> {
  started ??= (async () => {
    set('loading');
    for (let attempt = 1; ; attempt++) {
      try {
        await loadWasm();
        wasmVersion();
        set('ready');
        return;
      } catch (e) {
        if (attempt >= 3) {
          set('failed');
          throw e;
        }
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  })();
  return started;
}
