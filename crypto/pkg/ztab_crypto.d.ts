/* tslint:disable */
/* eslint-disable */

/**
 * Returned to JS as an object with `ufvk` and `orchardSk` getters and `free()`; the Rust
 * copy of the key is zeroed when freed.
 */
export class TabAccount {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    orchardSk: Uint8Array;
    ufvk: string;
}

export function deriveAddress(network: string, ufvk: string, index: number): string;

export function deriveTabAccount(network: string, spend_seed: Uint8Array): TabAccount;

/**
 * JSON `{ outputs: [{ address, zat }], feeZat, totalInZat, txid }`.
 */
export function inspectPczt(network: string, pczt: Uint8Array): string;

/**
 * `expected_json` is `{ recipient, totalZat, feeZat }`. Returns the signed PCZT bytes.
 */
export function signPczt(network: string, pczt: Uint8Array, orchard_sk: Uint8Array, rng_seed: Uint8Array, expected_json: string): Uint8Array;

export function validateRecipient(network: string, address: string): void;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_tabaccount_orchardSk: (a: number) => [number, number];
    readonly __wbg_get_tabaccount_ufvk: (a: number) => [number, number];
    readonly __wbg_set_tabaccount_orchardSk: (a: number, b: number, c: number) => void;
    readonly __wbg_set_tabaccount_ufvk: (a: number, b: number, c: number) => void;
    readonly __wbg_tabaccount_free: (a: number, b: number) => void;
    readonly deriveAddress: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly deriveTabAccount: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly inspectPczt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly signPczt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly validateRecipient: (a: number, b: number, c: number, d: number) => [number, number];
    readonly version: () => [number, number];
    readonly rustsecp256k1_v0_14_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_14_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
