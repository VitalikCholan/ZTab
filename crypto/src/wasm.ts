import init, * as wasm from '../pkg/ztab_crypto.js';
import { CryptoError, fromWasmError } from './errors.ts';
import type { Network, PcztSummary, SignExpectation, TabAccount } from './types.ts';

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

export function deriveTabAccount(network: Network, spendSeed: Uint8Array): TabAccount {
  const account = call(() => wasm.deriveTabAccount(network, spendSeed));
  try {
    return { ufvk: account.ufvk, orchardSk: account.takeOrchardSk() };
  } finally {
    account.free();
  }
}

export function deriveAddress(network: Network, ufvk: string, index: number): string {
  return call(() => wasm.deriveAddress(network, ufvk, index));
}

export function validateRecipient(network: Network, address: string): void {
  call(() => wasm.validateRecipient(network, address));
}

/**
 * The Orchard-only unified address of `address`, which is how `inspectPczt` prints outputs.
 * Compare a wallet UA (Orchard + Sapling + transparent) to PCZT outputs through this.
 * Throws the same `CryptoError` as `validateRecipient`.
 */
export function canonicalRecipient(network: Network, address: string): string {
  return call(() => wasm.canonicalRecipient(network, address));
}

export function inspectPczt(network: Network, pczt: Uint8Array): PcztSummary {
  return JSON.parse(call(() => wasm.inspectPczt(network, pczt))) as PcztSummary;
}

/**
 * Signs the watcher's complete PCZT. Refuses (pczt_mismatch) before signing unless every
 * value-carrying output pays `expected.recipient`, is encrypted so that recipient's wallet can
 * decrypt it, and the sums match. `rngSeed` must be 32 fresh bytes from
 * `crypto.getRandomValues` for every call. `rngSeed` is key-equivalent (with it and a
 * signature the signing key is recoverable): generate it fresh and `fill(0)` it after the
 * call, like `orchardSk`.
 */
export function signPczt(
  network: Network,
  pczt: Uint8Array,
  orchardSk: Uint8Array,
  rngSeed: Uint8Array,
  expected: SignExpectation,
): Uint8Array {
  return call(() => wasm.signPczt(network, pczt, orchardSk, rngSeed, JSON.stringify(expected)));
}
