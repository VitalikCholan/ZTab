import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CryptoError, loadWasm, wasmVersion } from '../src/index.ts';

const wasmBytes = new Uint8Array(readFileSync(new URL('../pkg/ztab_crypto_bg.wasm', import.meta.url)));

describe('wasm module', () => {
  it('refuses calls before loadWasm', () => {
    expect(() => wasmVersion()).toThrow(CryptoError);
    try {
      wasmVersion();
    } catch (e) {
      expect((e as CryptoError).code).toBe('wasm_unavailable');
    }
  });

  it('loads once and reports its version', async () => {
    await loadWasm(wasmBytes);
    await loadWasm(wasmBytes); // second call is a no-op
    expect(wasmVersion()).toBe('0.1.0');
  });
});
