import { readFileSync } from 'node:fs';
import { loadWasm } from '@ztab/crypto';

const WASM = new URL('../../../crypto/pkg/ztab_crypto_bg.wasm', import.meta.url);

/** Loads the real crypto module from `crypto/pkg` (call in `beforeAll`). */
export function loadTestWasm(): Promise<void> {
  return loadWasm(new Uint8Array(readFileSync(WASM)));
}
