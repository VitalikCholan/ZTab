# @ztab/crypto

Everything in ZTab that touches a key runs here, in the browser:

- **Rust → WASM** (`rust/`, built into `pkg/`): tab account from the spend seed (`deriveTabAccount`), participant addresses exactly as the watcher derives them (`deriveAddress`), recipient validation (`validateRecipient`), closing-PCZT inspection (`inspectPczt`) and Ironwood signing (`signPczt`). Nothing here logs or talks to the network; the Rust side never sees the master key.
- **TypeScript on WebCrypto** (`src/`): HKDF-SHA256 key derivation (`deriveTabKeys`, `importBlobKey`), AES-256-GCM blobs (`sealBlob`, `openBlob`), link fragments (`encodeFragment`, `parseFragment`), random bytes, and typed wrappers over the WASM exports.

Design: `docs/superpowers/specs/2026-10-16-ztab-crypto-design.md`. Key model: watcher spec §4.

## Use

```ts
import { createMaster, deriveTabKeys, deriveTabAccount, deriveAddress, loadWasm, sealBlob } from '@ztab/crypto';

await loadWasm();                                   // browser: fetches pkg/ztab_crypto_bg.wasm
const master = createMaster();
const tabId = crypto.randomUUID();
const keys = await deriveTabKeys(master, tabId, 'group', 3);
const { ufvk, orchardSk } = deriveTabAccount('test', keys.spendSeed);
orchardSk.fill(0);                                  // not needed until closing
const addresses = [0, 1, 2].map((i) => deriveAddress('test', ufvk, i));
const adminBlob = await sealBlob(keys.admin, { title: 'Dinner', addresses /* … */ });
```

Closing: `inspectPczt` builds the confirmation screen from the PCZT itself, after binding every output's value and recipient to its note commitment; `signPczt` re-checks recipient, total and fee against what Alice confirmed and refuses before signing on any difference. See `scripts/sign-stdin.ts` for the full sequence.

Errors are `CryptoError { code, message }` with codes `invalid_fragment`, `decrypt_failed`, `invalid_recipient`, `invalid_pczt`, `pczt_mismatch`, `sign_failed`, `wasm_unavailable`; `internal` means a bug in the caller or here.

## Build and test

```sh
pnpm install
pnpm --filter @ztab/crypto test        # Vitest, loads pkg/ztab_crypto_bg.wasm in Node
pnpm --filter @ztab/crypto typecheck
(cd crypto/rust && cargo test)         # native tests of the Rust logic
crypto/build.sh                        # rebuild pkg/ in Docker (needed after any Rust change)
```

`pkg/` is committed so the PWA and CI need no Docker. Apple clang cannot target wasm32 and the cohort includes C (`secp256k1-sys`), hence Docker (`rust:1.98-bookworm` with clang/llvm and the matching `wasm-bindgen` CLI).

## Trust boundaries

- `master` exists only in the admin link fragment and the page's memory. Everything else is HKDF-derived with the tab id as salt.
- The PWA checks the watcher's participant addresses against `deriveAddress`: a compromised server cannot redirect payments.
- `signPczt` never signs a PCZT that pays anyone but the confirmed recipient, or a different amount or fee.
