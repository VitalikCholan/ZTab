import init, * as wasm from '../pkg/ztab_crypto.js';
import { CryptoError, fromWasmError } from './errors.ts';

export type WasmSource = BufferSource | WebAssembly.Module | URL | string;

let loading: Promise<void> | undefined;
let ready = false;

/**
 * Loads the module once. In the browser the default locates `ztab_crypto_bg.wasm` next to
 * the glue (Vite handles the `new URL(..., import.meta.url)` inside it); in Node pass the
 * file bytes. Repeated calls share the first load.
 */
export function loadWasm(source?: WasmSource): Promise<void> {
  loading ??= init(source === undefined ? undefined : { module_or_path: source }).then(
    () => {
      ready = true;
    },
    (e: unknown) => {
      loading = undefined;
      throw new CryptoError(
        'wasm_unavailable',
        `cannot load the ZTab crypto module: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  );
  return loading;
}

function call<T>(f: () => T): T {
  if (!ready) throw new CryptoError('wasm_unavailable', 'call loadWasm() first');
  try {
    return f();
  } catch (e) {
    throw fromWasmError(e);
  }
}

export function wasmVersion(): string {
  return call(() => wasm.version());
}
