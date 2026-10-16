# ZTab crypto module (`@ztab/crypto`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser module that derives a tab's Zcash keys and addresses from its spend seed, inspects and signs the watcher's closing PCZT, and encrypts tab blobs with keys derived from the admin master key.

**Architecture:** Rust crate `ztab-crypto` compiled to `wasm32-unknown-unknown` with wasm-bindgen does only what the browser cannot: `zcash_keys` derivation, `pczt` inspection and Ironwood signing, address validation. A TypeScript layer in the same pnpm package does HKDF-SHA256 and AES-256-GCM through `crypto.subtle`, encodes link fragments and wraps the WASM exports with typed errors. The watcher's live test gains an external-signer hook so the real end-to-end proof runs through this package.

**Tech Stack:** Rust 1.98 stable, wasm-bindgen 0.2.129, NU7 pre-release librustzcash cohort (same `=` pins as `watcher/Cargo.toml`), Docker `rust:1.98-bookworm` for the wasm build, pnpm 11 workspace, TypeScript 5.9, Vitest 4, Node 24 (native WebCrypto, native `.ts` execution).

**Spec:** `docs/superpowers/specs/2026-10-16-ztab-crypto-design.md` (spec). Facts about the stack live in the skill `.claude/skills/ztab-zcash-stack/` (`reference/pczt-and-wasm.md` has the build recipe and the signing rule). The key model is watcher-spec §4 (`docs/superpowers/specs/2026-10-15-ztab-watcher-design.md`).

**Deviations from the spec, decided while planning (each is small, keep them):**
1. `deriveSingleKey` is replaced by `importBlobKey(raw)`: a `#g=`/`#p=` fragment carries an already-derived key, so nothing is derived; `deriveTabKeys` returns the raw 32 bytes of every blob key next to its `CryptoKey`, because the PWA needs the raw bytes to build the links.
2. `inspectPczt` returns `txid` always, not `txid | null`: the module accepts only complete (proved) PCZTs, because `into_effects` is also how it proves that no value leaves through a bundle it does not inspect.
3. `validateRecipient` requires an **Orchard** receiver, a subset of the watcher rule (which also accepts Sapling-only UAs): the module verifies the closing payment through Ironwood outputs, so a recipient without an Orchard receiver could never pass `signPczt`.
4. The positive signing fixture (a real proved PCZT plus the spend seed that signs it) comes from one run of the watcher's live test with a dump option (Task 10/11). The tab is a throwaway whose funds were swept, so its seed can be public.
5. The CI job that rebuilds `pkg/` and compares it (spec §7) is not in this plan: the repository has no CI yet; it belongs to the infra subproject together with the watcher's CI.

## Global Constraints

- Crate pins exactly as `watcher/Cargo.toml`: `zcash_keys =0.17.0-pre.1`, `zcash_address =0.14.0-pre.1`, `zcash_protocol =0.11.0-pre.0`, `zcash_primitives =0.31.0-pre.1`, `pczt =0.10.0-pre.1`, `orchard 0.16.0`, `zip32 0.3`, `rand 0.10` (`std_rng` only, never `getrandom`/`os_rng`). `zcash_primitives` and `orchard` with `default-features = false` (their defaults pull `multicore`/`circuits`).
- Stable Rust 1.98, no nightly. The wasm build runs only through `crypto/build.sh` (Docker), native `cargo test` runs on macOS without Docker.
- The Rust layer never receives `master`; it receives `spendSeed` and derived material only. No logging anywhere in the crate. Secrets held in `zeroize::Zeroizing`.
- Error strings from Rust are `"<code>: <message>"` with codes from spec §4: `invalid_fragment`, `decrypt_failed`, `invalid_recipient`, `invalid_pczt`, `pczt_mismatch`, `sign_failed`, `wasm_unavailable`, plus `internal` for programmer errors.
- `signPczt` refuses before producing any signature when any value-carrying output does not pay the expected recipient, the paid sum differs from `expected.totalZat`, or the fee differs from `expected.feeZat`.
- Signing rule (skill, `reference/pczt-and-wasm.md`): try `sign_ironwood` on every action, skip `WrongSpendAuthorizingKey`, fail on any other error, require at least one signature.
- `deriveAddress` uses exactly `ufvk.address(DiversifierIndex::from(index), UnifiedAddressRequest::custom(Require, Omit, Omit))`, the watcher's call in `watcher/src/wallet.rs::participant_addresses`.
- TypeScript: ESM, intra-package imports with explicit `.ts` extensions, `erasableSyntaxOnly` (Node 24 runs the sources directly, so no enums, namespaces or parameter properties). Every `Uint8Array` handed to `crypto.subtle` is a fresh `.slice()` copy (satisfies `BufferSource` typing and never aliases caller memory).
- `crypto/pkg/` is committed (PWA and CI need no Docker). Module size target ≤ 1.5 MB.
- Shell: prepend `$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/pnpm` to `PATH` before any `pnpm`, `node` or `vitest` command (they are not on the default PATH).
- Code and comments in English, UI-facing strings none (this is a library). Commit messages `crypto: …` like the watcher's `watcher: …`.

## Review Focus

Inputs the spec implies but no happy-path test covers, each pinned by a test in the owning task:
1. A PCZT with a second value-carrying output (change to another address) must be refused by `signPczt` with `pczt_mismatch`; Task 6 tests `check_expectation` on synthetic data with two receivers.
2. A fragment with base64 padding, non-URL-safe characters or a key of the wrong length must raise `invalid_fragment`, never a `DOMException` or a 31-byte key; Task 8.
3. A blob opened with another tab's key (or a tampered byte) must raise `decrypt_failed` with a fixed message, leaking nothing about which byte failed; Task 9.
4. `signPczt('main', …)` with a testnet recipient must fail with `invalid_recipient` before touching the PCZT; Task 6.
5. A truncated or garbage PCZT must raise `invalid_pczt`, not panic (a panic aborts the wasm instance); Task 5.

## File structure

```
pnpm-workspace.yaml                     workspace: crypto (api, pwa later)
package.json                            root scripts: test, typecheck
.gitignore                              add !crypto/pkg/*.wasm
.gitattributes                          crypto/pkg/** linguist-generated
crypto/
  package.json                          @ztab/crypto, exports ./src/index.ts
  tsconfig.json, vitest.config.ts
  build.sh                              Docker wasm build -> pkg/
  README.md
  rust/
    Cargo.toml, Cargo.lock
    src/lib.rs                          wasm-bindgen exports only (thin)
    src/error.rs                        CryptoError { code, message }
    src/network.rs                      "test" | "main" -> Network
    src/keys.rs                         derive_tab_account, derive_address
    src/recipient.rs                    orchard_receiver, validate_recipient, encode_orchard
    src/pczt_ops.rs                     inspect, sign, check_expectation
    tests/fixtures/spend_seed.hex       deterministic fixture seed (= HKDF spend key of the TS vectors)
    tests/fixtures/expected.json        UFVK + addresses for that seed
    tests/fixtures/tab/                 Task 11: real tab seed + proved PCZT + expected
    tests/keys.rs, recipient.rs, pczt.rs
  pkg/                                  generated: ztab_crypto.js, ztab_crypto_bg.wasm, *.d.ts
  src/
    index.ts, types.ts, errors.ts, random.ts, base64url.ts,
    hkdf.ts, blob.ts, fragment.ts, wasm.ts
  test/
    fixtures/hkdf.json
    wasm-smoke.test.ts, wasm.test.ts, hkdf.test.ts, fragment.test.ts, blob.test.ts
  scripts/sign-stdin.ts                 external signer for the watcher live test
watcher/tests/common/mod.rs             sign_for_test (external signer hook), dump_sweep_fixture
watcher/tests/testnet_live.rs           use sign_for_test; dump when ZTAB_TEST_DUMP_DIR is set
watcher/tests/fixtures/README.md        document the two env vars
.claude/skills/ztab-zcash-stack/reference/pczt-and-wasm.md   wasm-bindgen facts, sizes, timings
```

Fixture values used throughout (computed natively on 2026-10-16 with the pinned crates; HKDF vectors verified identical from Node WebCrypto and Rust `hkdf`):

| Name | Value |
|---|---|
| `master` | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| `tabId` | `0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70` |
| HKDF `ztab/v1/spend` = `spend_seed` | `527580e4f6f7b702a2dc77a0bc917720cc182c61410ca078523753b0e38d08db` |
| HKDF `ztab/v1/admin` | `6520dc5f78da4a75a29312b191c11a032cd26818ce3a74631d798f2d65fdf0df` |
| HKDF `ztab/v1/group` | `aa5c8f2dbd9185d73f5d7a22ea883d665221e36d076c195252f0f8a36e6b9e01` |
| HKDF `ztab/v1/participant/0` | `3688efa0c994d62a5d2e6d6ee347faa65d9051a50bfe665e5f28362b17f0e99d` |
| HKDF `ztab/v1/participant/1` | `8f5a3c475de1bca24172838d8f7f274eeb25241a44a471dc8c8ca332763a2b36` |
| UFVK (testnet) of `spend_seed` | `uviewtest10ff4c0qk6sneplhnr5h53lw9j4n2a4af7j6spgy5sh67xfcfje3mpwdurusf590p2usjt7d07q952xyv2eqjudd568nqun8qqvcfjz2qmtw9ttkqtygkrmhku885eez4dhztlnev8cleaxqdtakgk9et8t4d6n2ll8fm3vp9efwre8tf42t35esdgz89w` |
| Orchard sk of `spend_seed` | `5ad2324395117be2510b63d2672f7f187302b6a1b683b512f2446bd0df378368` |
| address[0] | `utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7` |
| address[1] | `utest1x8fpfgj8l2lyfphdtwy54kj6nh732pjeeddhp383q7r9t3akxcvejuz22k6s0m6djgr4aj5qpsnndhehau4zph7y0lgp70lq5vw2mxhv` |
| address[7] | `utest1pyjpxppjd0ay5pf4y6xhgxyuk7gvk8esvrzpf7qqajc5m607a4an9jqezmx4mr9lhmy0vtfkru2lvsn459tkhjulk3kzczx5cvu9df72` |
| `watcher/tests/fixtures/sweep.proved.pczt` | 2 Ironwood actions, 1 unsigned; inputs 30 000 000 zat; one output 29 990 000 zat to `utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp`; fee 10 000; txid `659513d7a836783c8ab08445069de601c5c25b7f422e30ab8f116f5ff0e0f978`; no transparent/Sapling/Orchard bundle |
| `watcher/tests/fixtures/sweep2.proved.pczt` | same shape; inputs 20 000 000; output 19 990 000 to the same address; fee 10 000; txid `de425ef04e19f9d6e8ffa6caf7c87a110f76b321c7e0fcff97715417b943c2cb` |
| `watcher/tests/fixtures/sweep.signed.pczt` | `sweep.proved.pczt` fully signed (0 unsigned), same txid |

The PCZT fixtures are raw bytes (magic `PCZT`), not base64.

---

### Task 1: Workspace scaffolding and the native Rust crate skeleton

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `.gitattributes`
- Modify: `.gitignore` (the `*.wasm` line)
- Create: `crypto/package.json`, `crypto/tsconfig.json`, `crypto/vitest.config.ts`
- Create: `crypto/rust/Cargo.toml`, `crypto/rust/src/lib.rs`, `crypto/rust/src/error.rs`, `crypto/rust/src/network.rs`
- Test: `crypto/rust/tests/network.rs`

**Interfaces:**
- Produces: `ztab_crypto::error::{Code, CryptoError}` (`CryptoError::new(code, msg)`, `CryptoError::internal(msg)`, `Display` = `"<code>: <message>"`), `ztab_crypto::network::parse_network(&str) -> Result<Network, CryptoError>`.

- [ ] **Step 1: Workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - crypto
```

`package.json`:
```json
{
  "name": "ztab",
  "private": true,
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`.gitattributes`:
```
crypto/pkg/** linguist-generated=true
```

In `.gitignore` replace the line `*.wasm` with:
```
*.wasm
!crypto/pkg/*.wasm
```

- [ ] **Step 2: Package files**

`crypto/package.json`:
```json
{
  "name": "@ztab/crypto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "files": ["src", "pkg"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build:wasm": "./build.sh"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "~5.9.3",
    "vitest": "^4.1.12"
  }
}
```

`crypto/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts", "pkg/*.d.ts"]
}
```

`crypto/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 3: Cargo manifest**

`crypto/rust/Cargo.toml`:
```toml
[package]
name = "ztab-crypto"
version = "0.1.0"
edition = "2021"
rust-version = "1.98"
publish = false
description = "ZTab browser crypto: tab keys, addresses, PCZT inspection and Ironwood signing (wasm32)"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "=0.2.129"
zcash_keys = { version = "=0.17.0-pre.1", default-features = false, features = ["std", "orchard", "zeroize"] }
zcash_address = "=0.14.0-pre.1"
zcash_protocol = "=0.11.0-pre.0"
zcash_primitives = { version = "=0.31.0-pre.1", default-features = false, features = ["std"] }
pczt = { version = "=0.10.0-pre.1", default-features = false, features = ["signer", "orchard"] }
orchard = { version = "0.16.0", default-features = false }
zip32 = "0.3"
rand = { version = "0.10", default-features = false, features = ["std_rng"] }
zeroize = "1.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
hex = "0.4"
hkdf = "0.12"
sha2 = "0.10"
zcash_transparent = "=0.11.0-pre.1"

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
```

If `cargo` reports that `zcash_keys` has no feature `zeroize`, drop that feature (it is in the crate's default list, so it exists; this note is for the case the pre-release changes).

- [ ] **Step 4: Write the failing test**

`crypto/rust/tests/network.rs`:
```rust
use ztab_crypto::error::Code;
use ztab_crypto::network::parse_network;
use zcash_protocol::consensus::Network;

#[test]
fn parses_the_two_network_names() {
    assert!(matches!(parse_network("test"), Ok(Network::TestNetwork)));
    assert!(matches!(parse_network("main"), Ok(Network::MainNetwork)));
}

#[test]
fn rejects_anything_else_as_internal() {
    let err = parse_network("testnet").unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.to_string(), "internal: unknown network \"testnet\"; expected \"test\" or \"main\"");
}
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd crypto/rust && cargo test --test network`
Expected: compile error, `ztab_crypto::error` / `network` not found.

- [ ] **Step 6: Implement error, network and the lib root**

`crypto/rust/src/error.rs`:
```rust
//! Errors cross the WASM boundary as the string `"<code>: <message>"`; the TypeScript layer
//! turns the code back into a `CryptoError`. Codes are the ones the PWA distinguishes
//! (spec §4); everything a correct caller can never trigger is `internal`.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidRecipient,
    InvalidPczt,
    PcztMismatch,
    SignFailed,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidRecipient => "invalid_recipient",
            Code::InvalidPczt => "invalid_pczt",
            Code::PcztMismatch => "pczt_mismatch",
            Code::SignFailed => "sign_failed",
            Code::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoError {
    pub code: Code,
    pub message: String,
}

impl CryptoError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Code::Internal, message)
    }
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for CryptoError {}
```

`crypto/rust/src/network.rs`:
```rust
use zcash_protocol::consensus::Network;

use crate::error::CryptoError;

/// The network names the TypeScript layer passes (`'test' | 'main'`).
pub fn parse_network(name: &str) -> Result<Network, CryptoError> {
    match name {
        "test" => Ok(Network::TestNetwork),
        "main" => Ok(Network::MainNetwork),
        other => Err(CryptoError::internal(format!(
            "unknown network {other:?}; expected \"test\" or \"main\""
        ))),
    }
}
```

`crypto/rust/src/lib.rs`:
```rust
//! ZTab browser crypto module. The modules hold the logic and are tested natively; this file
//! holds only the wasm-bindgen exports (spec §3). Nothing here logs.
pub mod error;
pub mod network;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

- [ ] **Step 7: Run the tests**

Run: `cd crypto/rust && cargo test`
Expected: 2 passed. (The first build compiles the cohort; several minutes.)

- [ ] **Step 8: Install JS dependencies**

Run: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/pnpm:$PATH" && pnpm install`
Expected: `pnpm-lock.yaml` created, `node_modules` present, no errors.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml .gitattributes .gitignore crypto/package.json crypto/tsconfig.json crypto/vitest.config.ts crypto/rust
git commit -m "crypto: workspace scaffolding and the ztab-crypto crate skeleton"
```

---

### Task 2: Docker wasm build, committed `pkg/`, TypeScript loader smoke test

**Files:**
- Create: `crypto/build.sh`, `crypto/pkg/*` (generated), `crypto/src/errors.ts`, `crypto/src/wasm.ts`, `crypto/src/types.ts`, `crypto/src/index.ts`
- Test: `crypto/test/wasm-smoke.test.ts`

**Interfaces:**
- Consumes: `version()` export from Task 1.
- Produces: `loadWasm(source?)`, `wasmVersion()`, `CryptoError`, `fromWasmError`; `pkg/ztab_crypto.js` (`--target web` glue: default export `init`, named `initSync`, and every `#[wasm_bindgen]` export).

This task is the spec's first risk check: `zcash_keys` with `orchard` must compile to wasm32 with wasm-bindgen. The crate already depends on it, so the build either passes or shows the blocker now.

- [ ] **Step 1: Build script**

`crypto/build.sh`:
```bash
#!/usr/bin/env bash
# Builds crypto/rust for wasm32-unknown-unknown and writes the wasm-bindgen output to crypto/pkg.
# Runs in Docker: Apple clang has no wasm32 target and the cohort pulls secp256k1-sys (C).
# Cargo registry and target dir live in named volumes so rebuilds take seconds, not minutes.
set -euo pipefail
cd "$(dirname "$0")"
WB=0.2.129
mkdir -p pkg
docker run --rm \
  -v "$PWD/rust":/w \
  -v "$PWD/pkg":/pkg \
  -v ztab-crypto-cargo-registry:/usr/local/cargo/registry \
  -v ztab-crypto-target:/w/target \
  -w /w \
  rust:1.98-bookworm sh -euc '
    apt-get update -qq && apt-get install -y -qq clang lld llvm curl >/dev/null
    rustup target add wasm32-unknown-unknown
    case "$(uname -m)" in
      aarch64) triple=aarch64-unknown-linux-gnu ;;
      x86_64)  triple=x86_64-unknown-linux-musl ;;
      *) echo "unsupported arch $(uname -m)"; exit 1 ;;
    esac
    curl -sSfL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/'"$WB"'/wasm-bindgen-'"$WB"'-$triple.tar.gz" | tar -xz -C /tmp
    CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=/usr/bin/llvm-ar \
      cargo build --release --target wasm32-unknown-unknown
    /tmp/wasm-bindgen-'"$WB"'-$triple/wasm-bindgen --target web --out-dir /pkg --out-name ztab_crypto \
      target/wasm32-unknown-unknown/release/ztab_crypto.wasm
  '
ls -la pkg
```

Run: `chmod +x crypto/build.sh`

- [ ] **Step 2: Run the build**

Run: `open -a Docker` if the daemon is not running (`docker info` fails), wait for it, then `crypto/build.sh`.
Expected: `crypto/pkg/` contains `ztab_crypto.js`, `ztab_crypto_bg.wasm`, `ztab_crypto.d.ts`, `ztab_crypto_bg.wasm.d.ts`. `ztab_crypto_bg.wasm` under 1.5 MB.

If the wasm32 build fails inside `zcash_keys` (spec §8 risk), stop and report the exact error; the fallback is deriving through `orchard::keys::SpendingKey::from_zip32_seed` and encoding the UA with `zcash_address` directly, which changes Task 3 and needs a decision.

- [ ] **Step 3: Check the imports of the module**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync("crypto/pkg/ztab_crypto_bg.wasm")); console.log(WebAssembly.Module.imports(m).map(i=>i.module+"."+i.name))'
```
Expected: only `wbg.*` entries (wasm-bindgen's own string/error shims). No `env.*`, no `wasi_*`, nothing named like `getrandom` or `random`.

- [ ] **Step 4: Write the failing smoke test**

`crypto/test/wasm-smoke.test.ts`:
```ts
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
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd crypto && pnpm test`
Expected: FAIL, cannot resolve `../src/index.ts`.

- [ ] **Step 6: Implement errors, types, the loader and the index**

`crypto/src/errors.ts`:
```ts
export type CryptoErrorCode =
  | 'invalid_fragment'
  | 'decrypt_failed'
  | 'invalid_recipient'
  | 'invalid_pczt'
  | 'pczt_mismatch'
  | 'sign_failed'
  | 'wasm_unavailable'
  | 'internal';

const CODES: ReadonlySet<string> = new Set<CryptoErrorCode>([
  'invalid_fragment',
  'decrypt_failed',
  'invalid_recipient',
  'invalid_pczt',
  'pczt_mismatch',
  'sign_failed',
  'wasm_unavailable',
  'internal',
]);

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/** Turns an error thrown by the WASM module (`"<code>: <message>"`) into a CryptoError. */
export function fromWasmError(e: unknown): CryptoError {
  if (e instanceof CryptoError) return e;
  const text = e instanceof Error ? e.message : String(e);
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
  if (m && CODES.has(m[1])) return new CryptoError(m[1] as CryptoErrorCode, m[2]);
  return new CryptoError('internal', text);
}
```

`crypto/src/types.ts`:
```ts
export type Network = 'test' | 'main';
export type TabMode = 'group' | 'individual';

/** What the browser keeps from a tab's spend seed. */
export interface TabAccount {
  ufvk: string;
  /** 32-byte Orchard spending key; zero it (`fill(0)`) as soon as the signature is made. */
  orchardSk: Uint8Array;
}

export interface PcztOutput {
  address: string;
  zat: number;
}

export interface PcztSummary {
  /** Every value-carrying Ironwood output. */
  outputs: PcztOutput[];
  feeZat: number;
  totalInZat: number;
  txid: string;
}

/** What `signPczt` checks the PCZT against before it signs. */
export interface SignExpectation {
  recipient: string;
  totalZat: number;
  feeZat: number;
}
```

`crypto/src/wasm.ts`:
```ts
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
```

`crypto/src/index.ts`:
```ts
export { CryptoError, fromWasmError } from './errors.ts';
export type { CryptoErrorCode } from './errors.ts';
export type * from './types.ts';
export { loadWasm, wasmVersion } from './wasm.ts';
export type { WasmSource } from './wasm.ts';
```

- [ ] **Step 7: Run the tests and the type check**

Run: `cd crypto && pnpm test && pnpm typecheck`
Expected: 2 passed; `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add crypto/build.sh crypto/pkg crypto/src crypto/test
git commit -m "crypto: wasm build in Docker, committed pkg, typed loader"
```

---

### Task 3: Key derivation (`derive_tab_account`, `derive_address`)

**Files:**
- Create: `crypto/rust/src/keys.rs`, `crypto/rust/tests/fixtures/spend_seed.hex`, `crypto/rust/tests/fixtures/expected.json`
- Modify: `crypto/rust/src/lib.rs` (add `pub mod keys;`)
- Test: `crypto/rust/tests/keys.rs`

**Interfaces:**
- Produces: `keys::TabAccount { ufvk: String, orchard_sk: Zeroizing<[u8; 32]> }`, `keys::derive_tab_account(Network, &[u8]) -> Result<TabAccount, CryptoError>`, `keys::derive_address(Network, &str, u32) -> Result<String, CryptoError>`.

- [ ] **Step 1: Fixtures**

`crypto/rust/tests/fixtures/spend_seed.hex` (one line, no trailing newline needed):
```
527580e4f6f7b702a2dc77a0bc917720cc182c61410ca078523753b0e38d08db
```

`crypto/rust/tests/fixtures/expected.json`:
```json
{
  "network": "test",
  "ufvk": "uviewtest10ff4c0qk6sneplhnr5h53lw9j4n2a4af7j6spgy5sh67xfcfje3mpwdurusf590p2usjt7d07q952xyv2eqjudd568nqun8qqvcfjz2qmtw9ttkqtygkrmhku885eez4dhztlnev8cleaxqdtakgk9et8t4d6n2ll8fm3vp9efwre8tf42t35esdgz89w",
  "orchardSkHex": "5ad2324395117be2510b63d2672f7f187302b6a1b683b512f2446bd0df378368",
  "addresses": {
    "0": "utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7",
    "1": "utest1x8fpfgj8l2lyfphdtwy54kj6nh732pjeeddhp383q7r9t3akxcvejuz22k6s0m6djgr4aj5qpsnndhehau4zph7y0lgp70lq5vw2mxhv",
    "7": "utest1pyjpxppjd0ay5pf4y6xhgxyuk7gvk8esvrzpf7qqajc5m607a4an9jqezmx4mr9lhmy0vtfkru2lvsn459tkhjulk3kzczx5cvu9df72"
  }
}
```

These values are the native truth for the fixture seed, which is itself `HKDF(master = 00..1f, salt = "0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70", info = "ztab/v1/spend")`, so the TypeScript HKDF vectors (Task 8) and this file describe one tab.

- [ ] **Step 2: Write the failing tests**

`crypto/rust/tests/keys.rs`:
```rust
use zcash_protocol::consensus::Network;
use ztab_crypto::error::Code;
use ztab_crypto::keys::{derive_address, derive_tab_account};

fn fixture_seed() -> Vec<u8> {
    hex::decode(include_str!("fixtures/spend_seed.hex").trim()).unwrap()
}

fn expected() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/expected.json")).unwrap()
}

#[test]
fn derives_the_fixture_ufvk_and_orchard_key() {
    let account = derive_tab_account(Network::TestNetwork, &fixture_seed()).unwrap();
    let exp = expected();
    assert_eq!(account.ufvk, exp["ufvk"].as_str().unwrap());
    assert_eq!(hex::encode(*account.orchard_sk), exp["orchardSkHex"].as_str().unwrap());
}

#[test]
fn mainnet_ufvk_differs_in_prefix_only_by_network() {
    let account = derive_tab_account(Network::MainNetwork, &fixture_seed()).unwrap();
    assert!(account.ufvk.starts_with("uview1"), "{}", account.ufvk);
}

#[test]
fn rejects_a_seed_that_is_not_32_bytes() {
    let err = derive_tab_account(Network::TestNetwork, &[1u8; 31]).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "spend seed must be 32 bytes");
}

#[test]
fn derives_the_watcher_participant_addresses() {
    let exp = expected();
    let ufvk = exp["ufvk"].as_str().unwrap();
    for (index, address) in exp["addresses"].as_object().unwrap() {
        let index: u32 = index.parse().unwrap();
        assert_eq!(
            derive_address(Network::TestNetwork, ufvk, index).unwrap(),
            address.as_str().unwrap(),
            "index {index}"
        );
    }
}

#[test]
fn every_u32_index_yields_an_address() {
    let ufvk = expected()["ufvk"].as_str().unwrap().to_string();
    let last = derive_address(Network::TestNetwork, &ufvk, u32::MAX).unwrap();
    assert!(last.starts_with("utest1"));
    assert_ne!(last, derive_address(Network::TestNetwork, &ufvk, 0).unwrap());
}

#[test]
fn rejects_a_ufvk_of_the_other_network() {
    let ufvk = expected()["ufvk"].as_str().unwrap().to_string();
    let err = derive_address(Network::MainNetwork, &ufvk, 0).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert!(err.message.starts_with("ufvk decode:"), "{}", err.message);
}

#[test]
fn fixture_seed_is_the_hkdf_spend_key_of_the_ts_vectors() {
    // Pins the `ztab/v1/*` port from the Rust side: the same vectors live in crypto/test/fixtures/hkdf.json.
    let master: Vec<u8> = (0u8..32).collect();
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70"), &master);
    let mut spend_seed = [0u8; 32];
    hk.expand(b"ztab/v1/spend", &mut spend_seed).unwrap();
    assert_eq!(spend_seed.to_vec(), fixture_seed());
    let mut admin = [0u8; 32];
    hk.expand(b"ztab/v1/admin", &mut admin).unwrap();
    assert_eq!(hex::encode(admin), "6520dc5f78da4a75a29312b191c11a032cd26818ce3a74631d798f2d65fdf0df");
}
```

Add to `[dev-dependencies]` in `crypto/rust/Cargo.toml`: `serde_json = "1"` (already a dependency; listing it again under dev-dependencies is not needed, skip if cargo warns).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd crypto/rust && cargo test --test keys`
Expected: compile error, `ztab_crypto::keys` not found.

- [ ] **Step 4: Implement keys.rs**

`crypto/rust/src/keys.rs`:
```rust
//! Tab keys from the spend seed (watcher-spec §4): the seed is `HKDF(master, "ztab/v1/spend")`,
//! derived in TypeScript; this module never sees `master`.
use zcash_keys::keys::{
    ReceiverRequirement, UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey,
};
use zcash_protocol::consensus::Network;
use zeroize::Zeroizing;
use zip32::{AccountId, DiversifierIndex};

use crate::error::CryptoError;

/// What the browser keeps from a tab's spend seed: the UFVK for the watcher and the 32-byte
/// Orchard spending key that authorizes the closing PCZT.
pub struct TabAccount {
    pub ufvk: String,
    pub orchard_sk: Zeroizing<[u8; 32]>,
}

pub fn derive_tab_account(network: Network, spend_seed: &[u8]) -> Result<TabAccount, CryptoError> {
    let seed: Zeroizing<[u8; 32]> = Zeroizing::new(
        spend_seed
            .try_into()
            .map_err(|_| CryptoError::internal("spend seed must be 32 bytes"))?,
    );
    let usk = UnifiedSpendingKey::from_seed(&network, &seed[..], AccountId::ZERO)
        .map_err(|e| CryptoError::internal(format!("usk from seed: {e:?}")))?;
    let ufvk = usk
        .to_unified_full_viewing_key()
        .encode(&network)
        .map_err(|e| CryptoError::internal(format!("ufvk encode: {e:?}")))?;
    let orchard_sk = Zeroizing::new(*usk.orchard().to_bytes());
    Ok(TabAccount { ufvk, orchard_sk })
}

/// The watcher's request for participant addresses: one Orchard receiver, nothing else.
fn orchard_only() -> UnifiedAddressRequest {
    UnifiedAddressRequest::custom(
        ReceiverRequirement::Require,
        ReceiverRequirement::Omit,
        ReceiverRequirement::Omit,
    )
    .expect("an Orchard-only request is valid")
}

/// The participant address at `index`, exactly as the watcher derives it
/// (`watcher/src/wallet.rs::participant_addresses`), so the browser can check the watcher.
pub fn derive_address(network: Network, ufvk: &str, index: u32) -> Result<String, CryptoError> {
    let ufvk = UnifiedFullViewingKey::decode(&network, ufvk)
        .map_err(|e| CryptoError::internal(format!("ufvk decode: {e:?}")))?;
    let ua = ufvk
        .address(DiversifierIndex::from(index), orchard_only())
        .map_err(|e| CryptoError::internal(format!("address at index {index}: {e:?}")))?;
    Ok(ua.encode(&network))
}
```

In `crypto/rust/src/lib.rs` add `pub mod keys;` after `pub mod error;`.

- [ ] **Step 5: Run the tests**

Run: `cd crypto/rust && cargo test`
Expected: all pass (network 2, keys 7).

- [ ] **Step 6: Commit**

```bash
git add crypto/rust
git commit -m "crypto: derive the tab account and participant addresses from the spend seed"
```

---

### Task 4: Recipient validation

**Files:**
- Create: `crypto/rust/src/recipient.rs`
- Modify: `crypto/rust/src/lib.rs` (add `pub mod recipient;`)
- Test: `crypto/rust/tests/recipient.rs`

**Interfaces:**
- Produces: `recipient::orchard_receiver(Network, &str) -> Result<orchard::Address, CryptoError>`, `recipient::validate_recipient(Network, &str) -> Result<(), CryptoError>`, `recipient::encode_orchard(Network, orchard::Address) -> Result<String, CryptoError>`.

- [ ] **Step 1: Write the failing tests**

`crypto/rust/tests/recipient.rs`:
```rust
use zcash_address::ZcashAddress;
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{Network, NetworkType};
use zcash_transparent::address::TransparentAddress;
use ztab_crypto::error::Code;
use ztab_crypto::recipient::{encode_orchard, orchard_receiver, validate_recipient};

const UFVK: &str = "uviewtest10ff4c0qk6sneplhnr5h53lw9j4n2a4af7j6spgy5sh67xfcfje3mpwdurusf590p2usjt7d07q952xyv2eqjudd568nqun8qqvcfjz2qmtw9ttkqtygkrmhku885eez4dhztlnev8cleaxqdtakgk9et8t4d6n2ll8fm3vp9efwre8tf42t35esdgz89w";
const ADDRESS_0: &str = "utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7";

fn orchard_address_of_fixture() -> orchard::Address {
    // Independent of `derive_address`: straight from the Orchard full viewing key.
    let ufvk = UnifiedFullViewingKey::decode(&Network::TestNetwork, UFVK).unwrap();
    ufvk.orchard().unwrap().address_at(0u32, orchard::keys::Scope::External)
}

fn refused(network: Network, address: &str, expected_message: &str) {
    let err = validate_recipient(network, address).unwrap_err();
    assert_eq!(err.code, Code::InvalidRecipient, "{address}");
    assert_eq!(err.message, expected_message, "{address}");
}

#[test]
fn accepts_a_testnet_ua_with_an_orchard_receiver() {
    validate_recipient(Network::TestNetwork, ADDRESS_0).unwrap();
    validate_recipient(Network::TestNetwork, &format!("  {ADDRESS_0}\n")).unwrap();
    let receiver = orchard_receiver(Network::TestNetwork, ADDRESS_0).unwrap();
    assert_eq!(receiver.to_raw_address_bytes(), orchard_address_of_fixture().to_raw_address_bytes());
}

#[test]
fn encode_orchard_round_trips_the_watcher_address() {
    let receiver = orchard_receiver(Network::TestNetwork, ADDRESS_0).unwrap();
    assert_eq!(encode_orchard(Network::TestNetwork, receiver).unwrap(), ADDRESS_0);
}

#[test]
fn refuses_the_other_network() {
    let mainnet = UnifiedAddress::from_receivers(Some(orchard_address_of_fixture()), None, None, None)
        .unwrap()
        .encode(&Network::MainNetwork);
    assert!(mainnet.starts_with("u1"));
    refused(Network::TestNetwork, &mainnet, "the address belongs to another network");
    refused(Network::MainNetwork, ADDRESS_0, "the address belongs to another network");
}

#[test]
fn refuses_transparent_and_tex_addresses() {
    let t = ZcashAddress::from_transparent_p2pkh(NetworkType::Test, [1; 20]).encode();
    assert!(t.starts_with("tm"));
    refused(Network::TestNetwork, &t, "transparent addresses are not accepted; use a shielded unified address");
    let tex = ZcashAddress::from_tex(NetworkType::Test, [1; 20]).encode();
    refused(Network::TestNetwork, &tex, "transparent addresses are not accepted; use a shielded unified address");
}

#[test]
fn refuses_a_ua_without_an_orchard_receiver() {
    let transparent_only = UnifiedAddress::from_receivers(
        None,
        Some(TransparentAddress::PublicKeyHash([3; 20])),
        None,
        None,
    )
    .unwrap()
    .encode(&Network::TestNetwork);
    refused(Network::TestNetwork, &transparent_only, "the unified address has no Orchard receiver");
}

#[test]
fn refuses_garbage() {
    refused(Network::TestNetwork, "utest1x", "not a Zcash address");
    refused(Network::TestNetwork, "", "not a Zcash address");
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd crypto/rust && cargo test --test recipient`
Expected: compile error, `ztab_crypto::recipient` not found.

- [ ] **Step 3: Implement recipient.rs**

`crypto/rust/src/recipient.rs`:
```rust
//! The address Alice's funds go to. Narrower than the watcher's `shielded_recipient` (which
//! also accepts Sapling-only UAs): the closing PCZT is verified through its Ironwood outputs,
//! so the recipient must carry an Orchard receiver for the verification to see the payment.
use zcash_address::{ConversionError, ZcashAddress};
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_protocol::consensus::{Network, Parameters};

use crate::error::{Code, CryptoError};

/// Parses a recipient and returns its Orchard receiver.
pub fn orchard_receiver(network: Network, encoded: &str) -> Result<orchard::Address, CryptoError> {
    let refuse = |m: &str| CryptoError::new(Code::InvalidRecipient, m);
    let parsed = ZcashAddress::try_from_encoded(encoded.trim())
        .map_err(|_| refuse("not a Zcash address"))?;
    match parsed.convert_if_network::<Address>(network.network_type()) {
        Ok(Address::Unified(ua)) => ua
            .orchard()
            .copied()
            .ok_or_else(|| refuse("the unified address has no Orchard receiver")),
        Ok(Address::Transparent(_) | Address::Tex(_)) => Err(refuse(
            "transparent addresses are not accepted; use a shielded unified address",
        )),
        #[allow(unreachable_patterns)]
        Ok(_) => Err(refuse("not a supported address")),
        Err(ConversionError::IncorrectNetwork { .. }) => {
            Err(refuse("the address belongs to another network"))
        }
        Err(_) => Err(refuse("not a supported address")),
    }
}

pub fn validate_recipient(network: Network, encoded: &str) -> Result<(), CryptoError> {
    orchard_receiver(network, encoded).map(|_| ())
}

/// A bare Orchard receiver as a unified address of `network` (how PCZT outputs are shown).
pub fn encode_orchard(network: Network, receiver: orchard::Address) -> Result<String, CryptoError> {
    UnifiedAddress::from_receivers(Some(receiver), None, None, None)
        .map(|ua| ua.encode(&network))
        .ok_or_else(|| CryptoError::internal("unified address from an Orchard receiver"))
}
```

`from_receivers` has four parameters because the crate is built without the `sapling` feature (orchard, transparent, expiry height, expiry time). If a future dependency turns `sapling` on, the call gains a `None` for Sapling as its second argument; the compiler will say so.

In `crypto/rust/src/lib.rs` add `pub mod recipient;`.

- [ ] **Step 4: Run the tests**

Run: `cd crypto/rust && cargo test`
Expected: all pass. If `Address::Sapling` appears in a compiler error, the `sapling` feature leaked in through another crate; keep the `#[allow(unreachable_patterns)] Ok(_)` arm (it then catches Sapling) and fix `from_receivers` per the note above.

- [ ] **Step 5: Commit**

```bash
git add crypto/rust
git commit -m "crypto: validate the closing recipient (Orchard receiver of this network)"
```

---

### Task 5: PCZT inspection

**Files:**
- Create: `crypto/rust/src/pczt_ops.rs`
- Modify: `crypto/rust/src/lib.rs` (add `pub mod pczt_ops;`)
- Test: `crypto/rust/tests/pczt.rs`

**Interfaces:**
- Produces: `pczt_ops::{PcztOutput, PcztSummary, Expected, Inspected}`, `pczt_ops::parse(&[u8]) -> Result<Pczt, CryptoError>`, `pczt_ops::inspect_inner(Network, &Pczt) -> Result<Inspected, CryptoError>`, `pczt_ops::inspect(Network, &[u8]) -> Result<PcztSummary, CryptoError>`. `PcztSummary` serializes as camelCase JSON (`outputs`, `feeZat`, `totalInZat`, `txid`).

- [ ] **Step 1: Write the failing tests**

`crypto/rust/tests/pczt.rs`:
```rust
use zcash_protocol::consensus::Network;
use ztab_crypto::error::Code;
use ztab_crypto::pczt_ops::{inspect, PcztOutput};

pub const RECIPIENT: &str = "utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp";

pub fn watcher_fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../watcher/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

#[test]
fn inspects_the_proved_sweep() {
    let summary = inspect(Network::TestNetwork, &watcher_fixture("sweep.proved.pczt")).unwrap();
    assert_eq!(
        summary.outputs,
        vec![PcztOutput { address: RECIPIENT.to_string(), zat: 29_990_000 }]
    );
    assert_eq!(summary.fee_zat, 10_000);
    assert_eq!(summary.total_in_zat, 30_000_000);
    assert_eq!(
        summary.txid,
        "659513d7a836783c8ab08445069de601c5c25b7f422e30ab8f116f5ff0e0f978"
    );
}

#[test]
fn inspects_the_second_sweep_and_the_signed_form() {
    let second = inspect(Network::TestNetwork, &watcher_fixture("sweep2.proved.pczt")).unwrap();
    assert_eq!(second.outputs[0].zat, 19_990_000);
    assert_eq!(second.total_in_zat, 20_000_000);
    assert_eq!(
        second.txid,
        "de425ef04e19f9d6e8ffa6caf7c87a110f76b321c7e0fcff97715417b943c2cb"
    );
    // Signatures do not change what the transaction does.
    let signed = inspect(Network::TestNetwork, &watcher_fixture("sweep.signed.pczt")).unwrap();
    let proved = inspect(Network::TestNetwork, &watcher_fixture("sweep.proved.pczt")).unwrap();
    assert_eq!(signed, proved);
}

#[test]
fn summary_serializes_as_camel_case_json() {
    let summary = inspect(Network::TestNetwork, &watcher_fixture("sweep.proved.pczt")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&summary).unwrap()).unwrap();
    assert_eq!(json["feeZat"], 10_000);
    assert_eq!(json["totalInZat"], 30_000_000);
    assert_eq!(json["outputs"][0]["address"], RECIPIENT);
    assert_eq!(json["outputs"][0]["zat"], 29_990_000);
    assert!(json["txid"].is_string());
}

#[test]
fn garbage_and_truncated_bytes_are_invalid_pczt_not_panics() {
    for bytes in [vec![], b"PCZT".to_vec(), vec![0u8; 100], watcher_fixture("sweep.proved.pczt")[..4000].to_vec()] {
        let err = inspect(Network::TestNetwork, &bytes).unwrap_err();
        assert_eq!(err.code, Code::InvalidPczt, "{} bytes", bytes.len());
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd crypto/rust && cargo test --test pczt`
Expected: compile error, `ztab_crypto::pczt_ops` not found.

- [ ] **Step 3: Implement inspection**

`crypto/rust/src/pczt_ops.rs`:
```rust
//! What the browser does with the watcher's closing PCZT: read what it pays (the confirmation
//! screen) and sign it, but only when it pays exactly what Alice confirmed.
use pczt::roles::verifier::{OrchardError, Verifier};
use pczt::Pczt;
use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::txid::{to_txid, TxIdDigester};
use zcash_protocol::consensus::Network;

use crate::error::{Code, CryptoError};
use crate::recipient::encode_orchard;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PcztOutput {
    pub address: String,
    pub zat: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PcztSummary {
    /// Every value-carrying Ironwood output; zero-valued padding dummies are left out.
    pub outputs: Vec<PcztOutput>,
    pub fee_zat: u64,
    pub total_in_zat: u64,
    pub txid: String,
}

/// What `sign` checks the PCZT against (spec §3).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub recipient: String,
    pub total_zat: u64,
    pub fee_zat: u64,
}

/// The inspection result plus the raw receivers the signer compares.
pub struct Inspected {
    pub summary: PcztSummary,
    /// Raw Orchard address bytes of each value-carrying output, in `summary.outputs` order.
    pub receivers: Vec<[u8; 43]>,
    pub actions: usize,
}

pub fn parse(bytes: &[u8]) -> Result<Pczt, CryptoError> {
    Pczt::parse(bytes).map_err(|e| CryptoError::new(Code::InvalidPczt, format!("not a valid PCZT: {e:?}")))
}

fn invalid(message: impl Into<String>) -> CryptoError {
    CryptoError::new(Code::InvalidPczt, message)
}

pub fn inspect_inner(network: Network, pczt: &Pczt) -> Result<Inspected, CryptoError> {
    let mut outputs = Vec::new();
    let mut receivers = Vec::new();
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut actions = 0usize;
    let mut value_sum = 0i64;

    Verifier::new(pczt.clone())
        .with_ironwood::<CryptoError, _>(|bundle| {
            actions = bundle.actions().len();
            value_sum = i64::try_from(*bundle.value_sum())
                .map_err(|_| OrchardError::Custom(invalid("value sum out of range")))?;
            for (i, action) in bundle.actions().iter().enumerate() {
                let spent = action
                    .spend()
                    .value()
                    .as_ref()
                    .ok_or_else(|| OrchardError::Custom(invalid(format!("action {i}: spend value redacted"))))?
                    .inner();
                let out = action
                    .output()
                    .value()
                    .as_ref()
                    .ok_or_else(|| OrchardError::Custom(invalid(format!("action {i}: output value redacted"))))?
                    .inner();
                total_in = total_in
                    .checked_add(spent)
                    .ok_or_else(|| OrchardError::Custom(invalid("input value overflow")))?;
                total_out = total_out
                    .checked_add(out)
                    .ok_or_else(|| OrchardError::Custom(invalid("output value overflow")))?;
                if out > 0 {
                    let recipient = action
                        .output()
                        .recipient()
                        .as_ref()
                        .ok_or_else(|| OrchardError::Custom(invalid(format!("action {i}: output recipient redacted"))))?;
                    receivers.push(recipient.to_raw_address_bytes());
                    outputs.push(PcztOutput {
                        address: encode_orchard(network, *recipient).map_err(OrchardError::Custom)?,
                        zat: out,
                    });
                }
            }
            Ok(())
        })
        .map_err(|e| match e {
            OrchardError::Custom(e) => e,
            other => invalid(format!("ironwood bundle: {other:?}")),
        })?;

    if actions == 0 {
        return Err(invalid("no Ironwood actions"));
    }
    let fee = total_in
        .checked_sub(total_out)
        .ok_or_else(|| invalid("outputs exceed inputs"))?;
    if i64::try_from(fee).ok() != Some(value_sum) {
        return Err(invalid("value sum does not match the actions"));
    }

    // The PCZT must describe a complete transaction with nothing outside the Ironwood bundle,
    // otherwise value could leave through a bundle this module does not inspect.
    let effects = pczt
        .clone()
        .into_effects()
        .map_err(|e| invalid(format!("not a complete transaction: {e:?}")))?;
    if effects
        .transparent_bundle()
        .is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty())
    {
        return Err(invalid("transparent inputs or outputs are not supported"));
    }
    if effects.sapling_bundle().is_some() || effects.orchard_bundle().is_some() {
        return Err(invalid("only an Ironwood bundle is supported"));
    }
    let parts = effects.digest(TxIdDigester);
    let txid = to_txid(effects.version(), effects.consensus_branch_id(), &parts).to_string();

    Ok(Inspected {
        summary: PcztSummary { outputs, fee_zat: fee, total_in_zat: total_in, txid },
        receivers,
        actions,
    })
}

/// The confirmation-screen view of a PCZT.
pub fn inspect(network: Network, bytes: &[u8]) -> Result<PcztSummary, CryptoError> {
    Ok(inspect_inner(network, &parse(bytes)?)?.summary)
}
```

In `crypto/rust/src/lib.rs` add `pub mod pczt_ops;`.

- [ ] **Step 4: Run the tests**

Run: `cd crypto/rust && cargo test`
Expected: all pass. If the compiler complains that `value()` is not `&Option<_>` (getset returns a reference) adjust `.as_ref()` to match; if `ValueSum` is not `Copy`, use `bundle.value_sum().clone()`.

- [ ] **Step 5: Commit**

```bash
git add crypto/rust
git commit -m "crypto: inspect a closing PCZT (outputs, fee, txid; Ironwood-only, complete)"
```

---

### Task 6: PCZT signing with the expectation check

**Files:**
- Modify: `crypto/rust/src/pczt_ops.rs`
- Test: `crypto/rust/tests/pczt.rs` (append)

**Interfaces:**
- Produces: `pczt_ops::check_expectation(&Inspected, &[u8; 43], &Expected) -> Result<(), CryptoError>`, `pczt_ops::sign(Network, &[u8], &[u8], &[u8], &Expected) -> Result<Vec<u8>, CryptoError>`.

- [ ] **Step 1: Write the failing tests**

Append to `crypto/rust/tests/pczt.rs`:
```rust
use ztab_crypto::pczt_ops::{check_expectation, parse, inspect_inner, sign, Expected, Inspected, PcztSummary};
use ztab_crypto::recipient::orchard_receiver;

/// Orchard spending key of the deterministic fixture tab (NOT the key of the watcher fixture
/// PCZTs, whose wallet is gone): it signs nothing in them.
const FOREIGN_SK: &str = "5ad2324395117be2510b63d2672f7f187302b6a1b683b512f2446bd0df378368";
const FOREIGN_ADDRESS: &str = "utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7";

fn expected_for_sweep() -> Expected {
    Expected { recipient: RECIPIENT.to_string(), total_zat: 29_990_000, fee_zat: 10_000 }
}

fn sign_sweep(expected: &Expected) -> Result<Vec<u8>, ztab_crypto::error::CryptoError> {
    sign(
        Network::TestNetwork,
        &watcher_fixture("sweep.proved.pczt"),
        &hex::decode(FOREIGN_SK).unwrap(),
        &[9u8; 32],
        expected,
    )
}

#[test]
fn a_key_that_authorizes_no_spend_fails_after_the_checks_pass() {
    let err = sign_sweep(&expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::SignFailed);
    assert_eq!(err.message, "this key authorizes none of the spends");
}

#[test]
fn refuses_before_signing_when_the_recipient_differs() {
    let err = sign_sweep(&Expected { recipient: FOREIGN_ADDRESS.to_string(), ..expected_for_sweep() }).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    assert_eq!(err.message, "an output pays an address other than the expected recipient");
}

#[test]
fn refuses_before_signing_when_the_total_or_fee_differs() {
    let err = sign_sweep(&Expected { total_zat: 29_990_001, ..expected_for_sweep() }).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    assert_eq!(err.message, "outputs pay 29990000 zat, expected 29990001");
    let err = sign_sweep(&Expected { fee_zat: 20_000, ..expected_for_sweep() }).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    assert_eq!(err.message, "fee is 10000 zat, expected 20000");
}

#[test]
fn a_mainnet_call_with_a_testnet_recipient_fails_as_invalid_recipient() {
    let err = sign(
        Network::MainNetwork,
        &watcher_fixture("sweep.proved.pczt"),
        &hex::decode(FOREIGN_SK).unwrap(),
        &[9u8; 32],
        &expected_for_sweep(),
    )
    .unwrap_err();
    assert_eq!(err.code, Code::InvalidRecipient);
}

#[test]
fn wrong_key_or_seed_lengths_are_internal_errors() {
    let pczt = watcher_fixture("sweep.proved.pczt");
    let err = sign(Network::TestNetwork, &pczt, &[1u8; 31], &[9u8; 32], &expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "orchard spending key must be 32 bytes");
    let err = sign(Network::TestNetwork, &pczt, &[1u8; 32], &[9u8; 16], &expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "rng seed must be 32 bytes");
}

#[test]
fn check_expectation_refuses_a_second_value_carrying_output() {
    // Synthetic: the sweep pays the recipient AND leaks change to someone else.
    let pczt = parse(&watcher_fixture("sweep.proved.pczt")).unwrap();
    let real = inspect_inner(Network::TestNetwork, &pczt).unwrap();
    let want = orchard_receiver(Network::TestNetwork, RECIPIENT).unwrap().to_raw_address_bytes();
    let other = orchard_receiver(Network::TestNetwork, FOREIGN_ADDRESS).unwrap().to_raw_address_bytes();
    let leaky = Inspected {
        summary: PcztSummary {
            outputs: vec![
                PcztOutput { address: RECIPIENT.to_string(), zat: 29_000_000 },
                PcztOutput { address: FOREIGN_ADDRESS.to_string(), zat: 990_000 },
            ],
            fee_zat: 10_000,
            total_in_zat: 30_000_000,
            txid: real.summary.txid.clone(),
        },
        receivers: vec![want, other],
        actions: 2,
    };
    let err = check_expectation(&leaky, &want, &expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    // The honest inspection passes the same check.
    check_expectation(&real, &want, &expected_for_sweep()).unwrap();
    // No value-carrying output at all is also a mismatch.
    let empty = Inspected {
        summary: PcztSummary { outputs: vec![], fee_zat: 10_000, total_in_zat: 10_000, txid: real.summary.txid },
        receivers: vec![],
        actions: 2,
    };
    assert_eq!(check_expectation(&empty, &want, &expected_for_sweep()).unwrap_err().message, "the PCZT pays nobody");
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd crypto/rust && cargo test --test pczt`
Expected: compile error, `check_expectation` / `sign` not found.

- [ ] **Step 3: Implement the check and the signer**

Append to `crypto/rust/src/pczt_ops.rs` (add the imports at the top of the file):
```rust
use orchard::keys::{SpendAuthorizingKey, SpendingKey};
use pczt::roles::signer::{Error as SignerError, Signer};
use rand::{rngs::StdRng, SeedableRng};
use zeroize::Zeroizing;

use crate::recipient::orchard_receiver;
```

```rust
/// Refuses unless every value-carrying output pays `want`, the outputs sum to
/// `expected.total_zat` and the fee is `expected.fee_zat`. Runs before any signature exists.
pub fn check_expectation(inspected: &Inspected, want: &[u8; 43], expected: &Expected) -> Result<(), CryptoError> {
    let mismatch = |m: String| CryptoError::new(Code::PcztMismatch, m);
    if inspected.summary.outputs.is_empty() {
        return Err(mismatch("the PCZT pays nobody".into()));
    }
    if inspected.receivers.iter().any(|r| r != want) {
        return Err(mismatch("an output pays an address other than the expected recipient".into()));
    }
    let paid: u64 = inspected.summary.outputs.iter().map(|o| o.zat).sum();
    if paid != expected.total_zat {
        return Err(mismatch(format!("outputs pay {paid} zat, expected {}", expected.total_zat)));
    }
    if inspected.summary.fee_zat != expected.fee_zat {
        return Err(mismatch(format!("fee is {} zat, expected {}", inspected.summary.fee_zat, expected.fee_zat)));
    }
    Ok(())
}

/// Signs every Ironwood spend `orchard_sk` authorizes, after `check_expectation` passes.
/// `rng_seed` is 32 bytes from `crypto.getRandomValues` (RedPallas signatures are randomized).
///
/// PCZTs from the watcher come from a view-only account, so their spends carry no
/// `zip32_derivation`: the only way to find this key's spends is to try each action and treat
/// `WrongSpendAuthorizingKey` as "not ours" (the dummy spend the IO Finalizer already signed,
/// or another key's note). Any other error is fatal; at least one signature is required.
pub fn sign(
    network: Network,
    bytes: &[u8],
    orchard_sk: &[u8],
    rng_seed: &[u8],
    expected: &Expected,
) -> Result<Vec<u8>, CryptoError> {
    let want = orchard_receiver(network, &expected.recipient)?.to_raw_address_bytes();
    let sk_bytes: Zeroizing<[u8; 32]> = Zeroizing::new(
        orchard_sk
            .try_into()
            .map_err(|_| CryptoError::internal("orchard spending key must be 32 bytes"))?,
    );
    let seed: [u8; 32] = rng_seed
        .try_into()
        .map_err(|_| CryptoError::internal("rng seed must be 32 bytes"))?;

    let pczt = parse(bytes)?;
    let inspected = inspect_inner(network, &pczt)?;
    check_expectation(&inspected, &want, expected)?;

    let sk = Option::<SpendingKey>::from(SpendingKey::from_bytes(*sk_bytes))
        .ok_or_else(|| CryptoError::internal("orchard spending key is not valid"))?;
    let ask = SpendAuthorizingKey::from(&sk);
    let mut rng = StdRng::from_seed(seed);
    let mut signer = Signer::new(pczt)
        .map_err(|e| CryptoError::new(Code::InvalidPczt, format!("signer: {e:?}")))?;
    let mut signed = 0usize;
    for i in 0..inspected.actions {
        match signer.sign_ironwood(&mut rng, i, &ask) {
            Ok(()) => signed += 1,
            Err(SignerError::IronwoodSign(orchard::pczt::SignerError::WrongSpendAuthorizingKey)) => {}
            Err(e) => return Err(CryptoError::new(Code::SignFailed, format!("action {i}: {e:?}"))),
        }
    }
    if signed == 0 {
        return Err(CryptoError::new(Code::SignFailed, "this key authorizes none of the spends"));
    }
    signer
        .finish()
        .serialize()
        .map_err(|e| CryptoError::internal(format!("serialize: {e:?}")))
}
```

- [ ] **Step 4: Run the tests**

Run: `cd crypto/rust && cargo test`
Expected: all pass (the order of checks matters: recipient parsing first, then lengths, then the PCZT).

- [ ] **Step 5: Commit**

```bash
git add crypto/rust
git commit -m "crypto: sign the closing PCZT only when it pays exactly what Alice confirmed"
```

---

### Task 7: wasm-bindgen exports, rebuilt `pkg/`, TypeScript wrappers

**Files:**
- Modify: `crypto/rust/src/lib.rs`, `crypto/pkg/*` (rebuild), `crypto/src/wasm.ts`, `crypto/src/index.ts`
- Test: `crypto/test/wasm.test.ts`

**Interfaces:**
- Produces (JS, from `pkg/`): `deriveTabAccount(network, spendSeed) -> TabAccount { ufvk, orchardSk, free() }`, `deriveAddress(network, ufvk, index) -> string`, `validateRecipient(network, address) -> void`, `inspectPczt(network, pczt) -> string (JSON)`, `signPczt(network, pczt, orchardSk, rngSeed, expectedJson) -> Uint8Array`.
- Produces (TS, `@ztab/crypto`): the same five with typed returns: `deriveTabAccount(network, spendSeed): TabAccount`, `deriveAddress(...)`, `validateRecipient(...)`, `inspectPczt(network, pczt): PcztSummary`, `signPczt(network, pczt, orchardSk, rngSeed, expected: SignExpectation): Uint8Array`.

- [ ] **Step 1: Exports in lib.rs**

Replace `crypto/rust/src/lib.rs` with:
```rust
//! ZTab browser crypto module. The modules hold the logic and are tested natively; this file
//! holds only the wasm-bindgen exports (spec §3). Nothing here logs. The Rust side never sees
//! `master`: callers pass the spend seed and derived material only.
pub mod error;
pub mod keys;
pub mod network;
pub mod pczt_ops;
pub mod recipient;

use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

use crate::error::CryptoError;

fn js(e: CryptoError) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returned to JS as an object with `ufvk` and `orchardSk` getters and `free()`; the Rust
/// copy of the key is zeroed when freed.
#[wasm_bindgen(getter_with_clone)]
#[allow(non_snake_case)]
pub struct TabAccount {
    pub ufvk: String,
    pub orchardSk: Vec<u8>,
}

impl Drop for TabAccount {
    fn drop(&mut self) {
        self.orchardSk.zeroize();
    }
}

#[wasm_bindgen(js_name = deriveTabAccount)]
pub fn js_derive_tab_account(network: &str, spend_seed: &[u8]) -> Result<TabAccount, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    let account = keys::derive_tab_account(network, spend_seed).map_err(js)?;
    Ok(TabAccount { ufvk: account.ufvk, orchardSk: account.orchard_sk.to_vec() })
}

#[wasm_bindgen(js_name = deriveAddress)]
pub fn js_derive_address(network: &str, ufvk: &str, index: u32) -> Result<String, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    keys::derive_address(network, ufvk, index).map_err(js)
}

#[wasm_bindgen(js_name = validateRecipient)]
pub fn js_validate_recipient(network: &str, address: &str) -> Result<(), JsError> {
    let network = network::parse_network(network).map_err(js)?;
    recipient::validate_recipient(network, address).map_err(js)
}

/// JSON `{ outputs: [{ address, zat }], feeZat, totalInZat, txid }`.
#[wasm_bindgen(js_name = inspectPczt)]
pub fn js_inspect_pczt(network: &str, pczt: &[u8]) -> Result<String, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    let summary = pczt_ops::inspect(network, pczt).map_err(js)?;
    serde_json::to_string(&summary).map_err(|e| js(CryptoError::internal(format!("summary json: {e}"))))
}

/// `expected_json` is `{ recipient, totalZat, feeZat }`. Returns the signed PCZT bytes.
#[wasm_bindgen(js_name = signPczt)]
pub fn js_sign_pczt(
    network: &str,
    pczt: &[u8],
    orchard_sk: &[u8],
    rng_seed: &[u8],
    expected_json: &str,
) -> Result<Vec<u8>, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    let expected: pczt_ops::Expected = serde_json::from_str(expected_json)
        .map_err(|e| js(CryptoError::internal(format!("expected json: {e}"))))?;
    pczt_ops::sign(network, pczt, orchard_sk, rng_seed, &expected).map_err(js)
}
```

Run: `cd crypto/rust && cargo test` — still green natively (wasm-bindgen is a no-op shim off wasm32).

- [ ] **Step 2: Rebuild pkg**

Run: `crypto/build.sh`
Expected: `pkg/ztab_crypto.d.ts` now declares the five functions and `class TabAccount { free(): void; ufvk: string; orchardSk: Uint8Array }`. Note the size of `ztab_crypto_bg.wasm` for Task 11's skill update.

- [ ] **Step 3: Write the failing tests**

`crypto/test/wasm.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CryptoError,
  deriveAddress,
  deriveTabAccount,
  inspectPczt,
  loadWasm,
  signPczt,
  validateRecipient,
} from '../src/index.ts';

const expected = JSON.parse(
  readFileSync(new URL('../rust/tests/fixtures/expected.json', import.meta.url), 'utf8'),
) as { ufvk: string; orchardSkHex: string; addresses: Record<string, string> };
const spendSeed = Buffer.from(
  readFileSync(new URL('../rust/tests/fixtures/spend_seed.hex', import.meta.url), 'utf8').trim(),
  'hex',
);
const sweep = new Uint8Array(
  readFileSync(new URL('../../watcher/tests/fixtures/sweep.proved.pczt', import.meta.url)),
);
const RECIPIENT =
  'utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp';

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    return (e as CryptoError).code;
  }
  throw new Error('did not throw');
}

beforeAll(async () => {
  await loadWasm(new Uint8Array(readFileSync(new URL('../pkg/ztab_crypto_bg.wasm', import.meta.url))));
});

describe('keys', () => {
  it('derives the fixture account', () => {
    const account = deriveTabAccount('test', new Uint8Array(spendSeed));
    expect(account.ufvk).toBe(expected.ufvk);
    expect(Buffer.from(account.orchardSk).toString('hex')).toBe(expected.orchardSkHex);
  });

  it('derives the watcher participant addresses', () => {
    for (const [index, address] of Object.entries(expected.addresses)) {
      expect(deriveAddress('test', expected.ufvk, Number(index))).toBe(address);
    }
  });

  it('maps Rust errors to codes', () => {
    expect(codeOf(() => deriveTabAccount('test', new Uint8Array(31)))).toBe('internal');
    expect(codeOf(() => deriveTabAccount('testnet' as 'test', new Uint8Array(32)))).toBe('internal');
  });
});

describe('recipient', () => {
  it('accepts an Orchard UA of the network and refuses the rest', () => {
    expect(() => validateRecipient('test', RECIPIENT)).not.toThrow();
    expect(codeOf(() => validateRecipient('main', RECIPIENT))).toBe('invalid_recipient');
    expect(codeOf(() => validateRecipient('test', 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU'))).toBe('invalid_recipient');
    expect(codeOf(() => validateRecipient('test', 'nonsense'))).toBe('invalid_recipient');
  });
});

describe('pczt', () => {
  it('inspects the proved sweep', () => {
    expect(inspectPczt('test', sweep)).toEqual({
      outputs: [{ address: RECIPIENT, zat: 29_990_000 }],
      feeZat: 10_000,
      totalInZat: 30_000_000,
      txid: '659513d7a836783c8ab08445069de601c5c25b7f422e30ab8f116f5ff0e0f978',
    });
    expect(codeOf(() => inspectPczt('test', sweep.subarray(0, 4000)))).toBe('invalid_pczt');
  });

  it('refuses to sign a mismatch and reports a foreign key', () => {
    const foreignSk = Buffer.from(expected.orchardSkHex, 'hex');
    const seed = new Uint8Array(32);
    const ok = { recipient: RECIPIENT, totalZat: 29_990_000, feeZat: 10_000 };
    expect(codeOf(() => signPczt('test', sweep, foreignSk, seed, { ...ok, totalZat: 1 }))).toBe('pczt_mismatch');
    expect(codeOf(() => signPczt('test', sweep, foreignSk, seed, { ...ok, recipient: expected.addresses['0'] }))).toBe('pczt_mismatch');
    expect(codeOf(() => signPczt('test', sweep, foreignSk, seed, ok))).toBe('sign_failed');
  });
});
```

The `tm…` string is any syntactically valid testnet transparent address; if the checksum does not validate it still fails as `invalid_recipient` ("not a Zcash address"), which is what the test asserts.

- [ ] **Step 4: Run it to verify it fails**

Run: `cd crypto && pnpm test`
Expected: FAIL, `deriveTabAccount` is not exported from `../src/index.ts`.

- [ ] **Step 5: Implement the wrappers**

Append to `crypto/src/wasm.ts`:
```ts
import type { Network, PcztSummary, SignExpectation, TabAccount } from './types.ts';

export function deriveTabAccount(network: Network, spendSeed: Uint8Array): TabAccount {
  const account = call(() => wasm.deriveTabAccount(network, spendSeed));
  try {
    return { ufvk: account.ufvk, orchardSk: account.orchardSk };
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

export function inspectPczt(network: Network, pczt: Uint8Array): PcztSummary {
  return JSON.parse(call(() => wasm.inspectPczt(network, pczt))) as PcztSummary;
}

/**
 * Signs the watcher's proved PCZT. Refuses (pczt_mismatch) before signing unless every
 * value-carrying output pays `expected.recipient` and the sums match. `rngSeed` must be 32
 * fresh bytes from `crypto.getRandomValues` for every call.
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
```
(Move the `import type` line up with the other imports.)

In `crypto/src/index.ts` extend the `wasm.ts` export line:
```ts
export {
  deriveAddress,
  deriveTabAccount,
  inspectPczt,
  loadWasm,
  signPczt,
  validateRecipient,
  wasmVersion,
} from './wasm.ts';
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd crypto && pnpm test && pnpm typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add crypto/rust/src/lib.rs crypto/pkg crypto/src crypto/test
git commit -m "crypto: wasm-bindgen exports and typed TypeScript wrappers"
```

---

### Task 8: HKDF keys, base64url, link fragments (TypeScript)

**Files:**
- Create: `crypto/src/random.ts`, `crypto/src/base64url.ts`, `crypto/src/hkdf.ts`, `crypto/src/fragment.ts`, `crypto/test/fixtures/hkdf.json`
- Modify: `crypto/src/index.ts`
- Test: `crypto/test/hkdf.test.ts`, `crypto/test/fragment.test.ts`

**Interfaces:**
- Produces: `createMaster(): Uint8Array`, `randomBytes(n)`, `toBase64Url(bytes)`, `fromBase64Url(text): Uint8Array | null`, `hkdf32(master, tabId, info)`, `importBlobKey(raw): Promise<BlobKey>`, `deriveTabKeys(master, tabId, mode, participantsCount): Promise<TabKeys>`, `BlobKey { raw, key }`, `TabKeys { spendSeed, admin, group?, participants? }`, `Fragment` union, `encodeFragment(f): string`, `parseFragment(text): Fragment`.

- [ ] **Step 1: Fixture**

`crypto/test/fixtures/hkdf.json`:
```json
{
  "masterHex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "tabId": "0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70",
  "spendSeedHex": "527580e4f6f7b702a2dc77a0bc917720cc182c61410ca078523753b0e38d08db",
  "adminKeyHex": "6520dc5f78da4a75a29312b191c11a032cd26818ce3a74631d798f2d65fdf0df",
  "groupKeyHex": "aa5c8f2dbd9185d73f5d7a22ea883d665221e36d076c195252f0f8a36e6b9e01",
  "participantKeyHex": {
    "0": "3688efa0c994d62a5d2e6d6ee347faa65d9051a50bfe665e5f28362b17f0e99d",
    "1": "8f5a3c475de1bca24172838d8f7f274eeb25241a44a471dc8c8ca332763a2b36"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`crypto/test/hkdf.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CryptoError, deriveTabKeys, hkdf32, importBlobKey } from '../src/index.ts';

const v = JSON.parse(readFileSync(new URL('./fixtures/hkdf.json', import.meta.url), 'utf8')) as {
  masterHex: string;
  tabId: string;
  spendSeedHex: string;
  adminKeyHex: string;
  groupKeyHex: string;
  participantKeyHex: Record<string, string>;
};
const master = new Uint8Array(Buffer.from(v.masterHex, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('hkdf32', () => {
  it('matches the vectors verified against the Rust hkdf crate', async () => {
    expect(hex(await hkdf32(master, v.tabId, 'ztab/v1/spend'))).toBe(v.spendSeedHex);
    expect(hex(await hkdf32(master, v.tabId, 'ztab/v1/admin'))).toBe(v.adminKeyHex);
  });

  it('is bound to the tab id', async () => {
    expect(hex(await hkdf32(master, '00000000-0000-4000-8000-000000000000', 'ztab/v1/spend'))).not.toBe(v.spendSeedHex);
  });
});

describe('deriveTabKeys', () => {
  it('derives the group mode set', async () => {
    const keys = await deriveTabKeys(master, v.tabId, 'group', 3);
    expect(hex(keys.spendSeed)).toBe(v.spendSeedHex);
    expect(hex(keys.admin.raw)).toBe(v.adminKeyHex);
    expect(hex(keys.group!.raw)).toBe(v.groupKeyHex);
    expect(keys.participants).toBeUndefined();
    expect(keys.admin.key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    expect(keys.admin.key.extractable).toBe(false);
  });

  it('derives the individual mode set', async () => {
    const keys = await deriveTabKeys(master, v.tabId, 'individual', 2);
    expect(keys.group).toBeUndefined();
    expect(keys.participants!.map((k) => hex(k.raw))).toEqual([v.participantKeyHex['0'], v.participantKeyHex['1']]);
  });

  it('refuses a bad participant count or master length', async () => {
    await expect(deriveTabKeys(master, v.tabId, 'individual', 0)).rejects.toMatchObject({ code: 'internal' });
    await expect(deriveTabKeys(master, v.tabId, 'individual', 1.5)).rejects.toMatchObject({ code: 'internal' });
    await expect(deriveTabKeys(new Uint8Array(16), v.tabId, 'group', 2)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('importBlobKey', () => {
  it('copies the raw bytes and yields a non-extractable AES-GCM key', async () => {
    const raw = new Uint8Array(Buffer.from(v.groupKeyHex, 'hex'));
    const key = await importBlobKey(raw);
    raw.fill(0);
    expect(hex(key.raw)).toBe(v.groupKeyHex);
    expect(key.key.extractable).toBe(false);
    await expect(importBlobKey(new Uint8Array(31))).rejects.toMatchObject({ code: 'internal' });
  });
});
```

`crypto/test/fragment.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CryptoError, encodeFragment, fromBase64Url, parseFragment, toBase64Url } from '../src/index.ts';

const bytes = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    return (e as CryptoError).code;
  }
  throw new Error('did not throw');
}

describe('base64url', () => {
  it('round-trips without padding or +/', () => {
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text).not.toContain('=');
    expect(fromBase64Url(text)).toEqual(bytes);
    expect(fromBase64Url('')).toEqual(new Uint8Array(0));
  });

  it('returns null for padding, +/ and impossible lengths', () => {
    expect(fromBase64Url(toBase64Url(bytes) + '=')).toBeNull();
    expect(fromBase64Url('ab+c')).toBeNull();
    expect(fromBase64Url('a')).toBeNull();
  });
});

describe('fragments', () => {
  it('encodes and parses the three link forms', () => {
    const admin = encodeFragment({ kind: 'admin', master: bytes });
    expect(admin.startsWith('#a=')).toBe(true);
    expect(parseFragment(admin)).toEqual({ kind: 'admin', master: bytes });
    expect(parseFragment(admin.slice(1))).toEqual({ kind: 'admin', master: bytes });
    expect(parseFragment(encodeFragment({ kind: 'group', key: bytes }))).toEqual({ kind: 'group', key: bytes });
    expect(parseFragment(encodeFragment({ kind: 'participant', index: 7, key: bytes }))).toEqual({ kind: 'participant', index: 7, key: bytes });
  });

  it('rejects malformed fragments as invalid_fragment', () => {
    const b64 = toBase64Url(bytes);
    for (const bad of ['', '#', '#x=' + b64, '#a=' + b64 + '=', '#a=' + b64.slice(0, 40), '#a=ab+c' + b64.slice(4), '#p=' + b64, '#p=07.' + b64, '#p=-1.' + b64, '#p=4294967296.' + b64, '#p=1.' + b64.slice(0, 10)]) {
      expect(codeOf(() => parseFragment(bad)), bad).toBe('invalid_fragment');
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd crypto && pnpm test`
Expected: FAIL, missing exports.

- [ ] **Step 4: Implement**

`crypto/src/random.ts`:
```ts
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** The tab's master key (watcher-spec §4): 32 random bytes, lives only in the admin link. */
export function createMaster(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}
```

`crypto/src/base64url.ts`:
```ts
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url without padding; `null` for anything else. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
```

`crypto/src/hkdf.ts`:
```ts
import { CryptoError } from './errors.ts';
import type { TabMode } from './types.ts';

const encoder = new TextEncoder();

export const INFO = {
  spend: 'ztab/v1/spend',
  admin: 'ztab/v1/admin',
  group: 'ztab/v1/group',
  participant: (index: number) => `ztab/v1/participant/${index}`,
} as const;

/** An AES-256-GCM blob key: the raw bytes (for links) and the non-extractable CryptoKey. */
export interface BlobKey {
  readonly raw: Uint8Array<ArrayBuffer>;
  readonly key: CryptoKey;
}

export interface TabKeys {
  spendSeed: Uint8Array<ArrayBuffer>;
  admin: BlobKey;
  /** Only in `group` mode. */
  group?: BlobKey;
  /** Only in `individual` mode, indexed by participant. */
  participants?: BlobKey[];
}

/** HKDF-SHA256, salt = the tab id as UTF-8, 32 bytes out (watcher-spec §4). */
export async function hkdf32(master: Uint8Array, tabId: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  if (master.length !== 32) throw new CryptoError('internal', 'master must be 32 bytes');
  const base = await crypto.subtle.importKey('raw', master.slice(), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(tabId), info: encoder.encode(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function importBlobKey(raw: Uint8Array): Promise<BlobKey> {
  if (raw.length !== 32) throw new CryptoError('internal', 'blob key must be 32 bytes');
  const copy = raw.slice();
  const key = await crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { raw: copy, key };
}

export async function deriveTabKeys(
  master: Uint8Array,
  tabId: string,
  mode: TabMode,
  participantsCount: number,
): Promise<TabKeys> {
  if (!Number.isInteger(participantsCount) || participantsCount < 1) {
    throw new CryptoError('internal', 'participantsCount must be a positive integer');
  }
  const keys: TabKeys = {
    spendSeed: await hkdf32(master, tabId, INFO.spend),
    admin: await importBlobKey(await hkdf32(master, tabId, INFO.admin)),
  };
  if (mode === 'group') {
    keys.group = await importBlobKey(await hkdf32(master, tabId, INFO.group));
  } else {
    keys.participants = [];
    for (let i = 0; i < participantsCount; i++) {
      keys.participants.push(await importBlobKey(await hkdf32(master, tabId, INFO.participant(i))));
    }
  }
  return keys;
}
```

`crypto/src/fragment.ts`:
```ts
import { fromBase64Url, toBase64Url } from './base64url.ts';
import { CryptoError } from './errors.ts';

/** The part of a ZTab link after `#` (watcher-spec §4). Never sent to any server. */
export type Fragment =
  | { kind: 'admin'; master: Uint8Array }
  | { kind: 'group'; key: Uint8Array }
  | { kind: 'participant'; index: number; key: Uint8Array };

export function encodeFragment(fragment: Fragment): string {
  switch (fragment.kind) {
    case 'admin':
      return `#a=${toBase64Url(fragment.master)}`;
    case 'group':
      return `#g=${toBase64Url(fragment.key)}`;
    case 'participant':
      return `#p=${fragment.index}.${toBase64Url(fragment.key)}`;
  }
}

/** Accepts the fragment with or without its leading `#`. */
export function parseFragment(text: string): Fragment {
  const bad = (message: string) => new CryptoError('invalid_fragment', message);
  const body = text.startsWith('#') ? text.slice(1) : text;
  const m = /^([agp])=(.*)$/s.exec(body);
  if (!m) throw bad('the link carries no ZTab key');
  const key32 = (encoded: string): Uint8Array<ArrayBuffer> => {
    const bytes = fromBase64Url(encoded);
    if (!bytes || bytes.length !== 32) throw bad('the key is not 32 base64url bytes');
    return bytes;
  };
  if (m[1] === 'p') {
    const p = /^(0|[1-9]\d{0,9})\.([A-Za-z0-9_-]+)$/.exec(m[2]);
    if (!p) throw bad('malformed participant key');
    const index = Number(p[1]);
    if (index > 0xffff_ffff) throw bad('participant index out of range');
    return { kind: 'participant', index, key: key32(p[2]) };
  }
  const bytes = key32(m[2]);
  return m[1] === 'a' ? { kind: 'admin', master: bytes } : { kind: 'group', key: bytes };
}
```

Add to `crypto/src/index.ts`:
```ts
export { createMaster, randomBytes } from './random.ts';
export { fromBase64Url, toBase64Url } from './base64url.ts';
export { INFO, deriveTabKeys, hkdf32, importBlobKey } from './hkdf.ts';
export type { BlobKey, TabKeys } from './hkdf.ts';
export { encodeFragment, parseFragment } from './fragment.ts';
export type { Fragment } from './fragment.ts';
```

- [ ] **Step 5: Run the tests and the type check**

Run: `cd crypto && pnpm test && pnpm typecheck`
Expected: all green. If `tsc` rejects `master.slice()` as a `BufferSource`, the lib typing predates TS 5.7 generics; replace with `new Uint8Array(master)` (also a copy).

- [ ] **Step 6: Commit**

```bash
git add crypto/src crypto/test
git commit -m "crypto: HKDF tab keys, base64url and link fragments on WebCrypto"
```

---

### Task 9: Blob sealing, package README

**Files:**
- Create: `crypto/src/blob.ts`, `crypto/README.md`
- Modify: `crypto/src/index.ts`
- Test: `crypto/test/blob.test.ts`

**Interfaces:**
- Produces: `sealBlob(key: BlobKey, value: unknown): Promise<Uint8Array>`, `openBlob<T>(key: BlobKey, blob: Uint8Array): Promise<T>`, `BLOB_VERSION = 1`.

- [ ] **Step 1: Write the failing tests**

`crypto/test/blob.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CryptoError, importBlobKey, openBlob, sealBlob } from '../src/index.ts';

const keyA = await importBlobKey(Uint8Array.from({ length: 32 }, (_, i) => i));
const keyB = await importBlobKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const tab = { title: 'Dinner', currency: 'EUR', participants: [{ name: 'Bob', shareZat: 1234567 }] };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    expect((e as CryptoError).message).toBe('the blob cannot be opened with this key');
    return (e as CryptoError).code;
  }
  throw new Error('did not throw');
}

describe('blobs', () => {
  it('round-trips JSON with a version byte and a fresh nonce', async () => {
    const one = await sealBlob(keyA, tab);
    const two = await sealBlob(keyA, tab);
    expect(one[0]).toBe(1);
    expect(one.length).toBe(1 + 12 + JSON.stringify(tab).length + 16);
    expect(Buffer.from(one.subarray(1, 13)).equals(Buffer.from(two.subarray(1, 13)))).toBe(false);
    expect(await openBlob(keyA, one)).toEqual(tab);
    expect(await openBlob(keyA, two)).toEqual(tab);
  });

  it('fails closed with a fixed message', async () => {
    const blob = await sealBlob(keyA, tab);
    expect(await codeOf(openBlob(keyB, blob))).toBe('decrypt_failed');
    const tampered = blob.slice();
    tampered[20] ^= 1;
    expect(await codeOf(openBlob(keyA, tampered))).toBe('decrypt_failed');
    const wrongVersion = blob.slice();
    wrongVersion[0] = 2;
    expect(await codeOf(openBlob(keyA, wrongVersion))).toBe('decrypt_failed');
    expect(await codeOf(openBlob(keyA, blob.subarray(0, 20)))).toBe('decrypt_failed');
    expect(await codeOf(openBlob(keyA, new Uint8Array(0)))).toBe('decrypt_failed');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd crypto && pnpm test`
Expected: FAIL, `sealBlob` not exported.

- [ ] **Step 3: Implement blob.ts**

`crypto/src/blob.ts`:
```ts
import { CryptoError } from './errors.ts';
import type { BlobKey } from './hkdf.ts';
import { randomBytes } from './random.ts';

/** Blob layout: version(1) || nonce(12) || AES-256-GCM ciphertext || tag(16). */
export const BLOB_VERSION = 1;
const NONCE = 12;
const TAG = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sealBlob(key: BlobKey, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key.key, plaintext),
  );
  const out = new Uint8Array(1 + NONCE + ciphertext.length);
  out[0] = BLOB_VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + NONCE);
  return out;
}

/** Fails closed: any defect (version, length, key, tampering) is the same `decrypt_failed`. */
export async function openBlob<T = unknown>(key: BlobKey, blob: Uint8Array): Promise<T> {
  const fail = () => new CryptoError('decrypt_failed', 'the blob cannot be opened with this key');
  if (blob.length < 1 + NONCE + TAG || blob[0] !== BLOB_VERSION) throw fail();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(1, 1 + NONCE) },
      key.key,
      blob.slice(1 + NONCE),
    );
  } catch {
    throw fail();
  }
  try {
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw fail();
  }
}
```

Add to `crypto/src/index.ts`:
```ts
export { BLOB_VERSION, openBlob, sealBlob } from './blob.ts';
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd crypto && pnpm test && pnpm typecheck`
Expected: all green.

- [ ] **Step 5: README**

`crypto/README.md`:
```markdown
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

Closing: `inspectPczt` builds the confirmation screen from the PCZT itself; `signPczt` re-checks recipient, total and fee against what Alice confirmed and refuses before signing on any difference. See `scripts/sign-stdin.ts` for the full sequence.

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
```

- [ ] **Step 6: Commit**

```bash
git add crypto/src crypto/test crypto/README.md
git commit -m "crypto: AES-GCM tab blobs and package README"
```

---

### Task 10: External signer for the watcher live test, fixture dump

**Files:**
- Create: `crypto/scripts/sign-stdin.ts`
- Modify: `watcher/tests/common/mod.rs` (add `sign_for_test`, `dump_sweep_fixture`), `watcher/tests/testnet_live.rs` (around line 1049, the `sign_like_browser` call), `watcher/tests/fixtures/README.md`
- Test: `crypto/test/sign-stdin.test.ts`

**Interfaces:**
- Consumes: `@ztab/crypto` exports from Tasks 7–9; `common::sign_like_browser(pczt_b64, &usk)`.
- Produces: stdin/stdout JSON protocol: request `{ network, spendSeedHex, pcztB64, recipient, totalZat, feeZat }`, reply `{ ufvk, txid, signedPcztB64 }`; env `ZTAB_TEST_SIGNER_CMD` (shell command, cwd `watcher/`), env `ZTAB_TEST_DUMP_DIR` (directory that receives `spend_seed.hex`, `sweep.proved.pczt`, `expected.json`).

- [ ] **Step 1: The signer script**

`crypto/scripts/sign-stdin.ts`:
```ts
// Signs a watcher PCZT the way the PWA does. Used by the watcher's live test through
// ZTAB_TEST_SIGNER_CMD so the end-to-end proof runs through this package.
//   stdin : {"network":"test","spendSeedHex":"…","pcztB64":"…","recipient":"utest1…","totalZat":n,"feeZat":n}
//   stdout: {"ufvk":"…","txid":"…","signedPcztB64":"…"}
// Run with Node 24 (type stripping): node crypto/scripts/sign-stdin.ts < request.json
import { readFileSync } from 'node:fs';
import { CryptoError, deriveTabAccount, inspectPczt, loadWasm, signPczt, type Network } from '../src/index.ts';

interface Request {
  network: Network;
  spendSeedHex: string;
  pcztB64: string;
  recipient: string;
  totalZat: number;
  feeZat: number;
}

const req = JSON.parse(readFileSync(0, 'utf8')) as Request;

try {
  await loadWasm(new Uint8Array(readFileSync(new URL('../pkg/ztab_crypto_bg.wasm', import.meta.url))));
  const spendSeed = new Uint8Array(Buffer.from(req.spendSeedHex, 'hex'));
  const account = deriveTabAccount(req.network, spendSeed);
  spendSeed.fill(0);
  const pczt = new Uint8Array(Buffer.from(req.pcztB64, 'base64url'));
  const summary = inspectPczt(req.network, pczt);
  const signed = signPczt(req.network, pczt, account.orchardSk, crypto.getRandomValues(new Uint8Array(32)), {
    recipient: req.recipient,
    totalZat: req.totalZat,
    feeZat: req.feeZat,
  });
  account.orchardSk.fill(0);
  process.stdout.write(
    JSON.stringify({ ufvk: account.ufvk, txid: summary.txid, signedPcztB64: Buffer.from(signed).toString('base64url') }),
  );
} catch (e) {
  // The watcher test shows this line; the code is what matters.
  const code = e instanceof CryptoError ? e.code : 'internal';
  process.stderr.write(`${code}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Write the failing script test**

`crypto/test/sign-stdin.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/sign-stdin.ts', import.meta.url).pathname;
const sweep = readFileSync(new URL('../../watcher/tests/fixtures/sweep.proved.pczt', import.meta.url));
const RECIPIENT =
  'utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp';

function run(request: object) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(request), encoding: 'utf8' });
}

describe('scripts/sign-stdin.ts', () => {
  it('derives the UFVK, then fails with sign_failed for a seed that owns nothing in the PCZT', () => {
    const r = run({
      network: 'test',
      spendSeedHex: readFileSync(new URL('../rust/tests/fixtures/spend_seed.hex', import.meta.url), 'utf8').trim(),
      pcztB64: sweep.toString('base64url'),
      recipient: RECIPIENT,
      totalZat: 29_990_000,
      feeZat: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('sign_failed');
    expect(r.stdout).toBe('');
  });

  it('refuses a mismatch before signing', () => {
    const r = run({
      network: 'test',
      spendSeedHex: '00'.repeat(32),
      pcztB64: sweep.toString('base64url'),
      recipient: RECIPIENT,
      totalZat: 1,
      feeZat: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('pczt_mismatch');
  });
});
```

- [ ] **Step 3: Run the tests and the type check**

Run: `cd crypto && pnpm test && pnpm typecheck`
Expected: both script cases pass with the stated stderr lines; `tsc` clean. If Node refuses to run the `.ts` file, the cause is non-erasable syntax or a missing `.ts` extension in an import; fix the source, not the runner.

- [ ] **Step 4: The watcher hook**

Append to `watcher/tests/common/mod.rs`:
```rust
/// Inputs the live test has when it signs the closing PCZT.
pub struct SignRequest<'a> {
    pub network: &'a zcash_protocol::consensus::Network,
    pub spend_seed: &'a [u8; 32],
    pub usk: &'a zcash_keys::keys::UnifiedSpendingKey,
    pub ufvk: &'a str,
    pub pczt_b64: &'a str,
    pub recipient: &'a str,
    pub total_zat: u64,
    pub fee_zat: u64,
}

/// Signs like the browser. With `ZTAB_TEST_SIGNER_CMD` set, the command (run through
/// `sh -c` from the `watcher/` directory) is the `@ztab/crypto` signer: it reads one JSON
/// request on stdin and writes `{"ufvk","txid","signedPcztB64"}` on stdout, and the UFVK it
/// derived must equal the one this test registered. Without the variable, signs in-process.
pub fn sign_for_test(req: &SignRequest<'_>) -> String {
    use std::io::Write;
    use std::process::{Command, Stdio};
    use zcash_protocol::consensus::Network;
    let Ok(cmd) = std::env::var("ZTAB_TEST_SIGNER_CMD") else {
        return sign_like_browser(req.pczt_b64, req.usk);
    };
    let network = match req.network {
        Network::TestNetwork => "test",
        Network::MainNetwork => "main",
    };
    let input = serde_json::json!({
        "network": network,
        "spendSeedHex": hex::encode(req.spend_seed),
        "pcztB64": req.pczt_b64,
        "recipient": req.recipient,
        "totalZat": req.total_zat,
        "feeZat": req.fee_zat,
    });
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn ZTAB_TEST_SIGNER_CMD");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "external signer failed: {}", out.status);
    let reply: serde_json::Value = serde_json::from_slice(&out.stdout).expect("signer reply is JSON");
    assert_eq!(
        reply["ufvk"].as_str().unwrap(),
        req.ufvk,
        "the browser module derived a different UFVK from the same seed"
    );
    reply["signedPcztB64"].as_str().unwrap().to_string()
}

/// Writes a public fixture for `crypto/`: the throwaway tab's seed, its proved sweep PCZT and
/// what the PCZT must inspect as. The tab's funds are swept by this test, so the seed is
/// worthless afterwards and may be committed.
pub fn dump_sweep_fixture(
    dir: &Path,
    spend_seed: &[u8; 32],
    ufvk: &str,
    addresses: &[String],
    pczt_b64: &str,
    recipient: &str,
    summary: &serde_json::Value,
) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("spend_seed.hex"), hex::encode(spend_seed)).unwrap();
    std::fs::write(dir.join("sweep.proved.pczt"), URL_SAFE_NO_PAD.decode(pczt_b64).unwrap()).unwrap();
    let expected = serde_json::json!({
        "network": "test",
        "ufvk": ufvk,
        "addresses": addresses,
        "recipient": recipient,
        "outputZat": summary["output_zat"],
        "feeZat": summary["fee_zat"],
        "totalInZat": summary["inputs_zat"],
        "txid": summary["txid"],
    });
    std::fs::write(dir.join("expected.json"), serde_json::to_string_pretty(&expected).unwrap()).unwrap();
}
```

`Path` is already imported at the top of `common/mod.rs` (`use std::{collections::HashMap, path::Path};`). `hex`, `base64`, `serde_json` are watcher dependencies.

In `watcher/tests/testnet_live.rs` replace the line
```rust
    let signed_b64 = common::sign_like_browser(offer["pczt_b64"].as_str().unwrap(), &usk);
```
with
```rust
    if let Ok(dir) = std::env::var("ZTAB_TEST_DUMP_DIR") {
        common::dump_sweep_fixture(
            std::path::Path::new(&dir),
            &tab_seed,
            &ufvk,
            &addresses,
            offer["pczt_b64"].as_str().unwrap(),
            payer.address(),
            s,
        );
        eprintln!("sweep fixture dumped to {dir}");
    }
    let signed_b64 = common::sign_for_test(&common::SignRequest {
        network: &network,
        spend_seed: &tab_seed,
        usk: &usk,
        ufvk: &ufvk,
        pczt_b64: offer["pczt_b64"].as_str().unwrap(),
        recipient: payer.address(),
        total_zat: s["output_zat"].as_u64().unwrap(),
        fee_zat: s["fee_zat"].as_u64().unwrap(),
    });
```
(`payer.address()` returns `&str` in the existing harness.)

- [ ] **Step 5: Compile the watcher tests and run the offline suite**

Run: `cd watcher && cargo test --no-run && cargo test`
Expected: compiles; offline suite unchanged and green (the live test is `#[ignore]`).

- [ ] **Step 6: Document the variables**

Append to `watcher/tests/fixtures/README.md`:
```markdown
## Signing through the browser module

`full_tab_lifecycle_on_testnet` signs the closing PCZT in-process by default. Set
`ZTAB_TEST_SIGNER_CMD` to sign through `@ztab/crypto` instead (the command runs with
`sh -c` from `watcher/`; it gets one JSON request on stdin and must print
`{"ufvk","txid","signedPcztB64"}`):

```sh
export ZTAB_TEST_SIGNER_CMD="$HOME/.nvm/versions/node/v24.18.0/bin/node ../crypto/scripts/sign-stdin.ts"
```

The test also asserts that the module derives the same UFVK from the tab seed.

Set `ZTAB_TEST_DUMP_DIR` to a directory to receive `spend_seed.hex`, `sweep.proved.pczt` and
`expected.json` for that run's tab: a public fixture for `crypto/rust/tests/fixtures/tab/`
(the tab is a throwaway whose funds the test sweeps back to the payer).
```

- [ ] **Step 7: Commit**

```bash
git add crypto/scripts crypto/test/sign-stdin.test.ts watcher/tests
git commit -m "crypto: stdin signer for the watcher live test; watcher: external signer hook and fixture dump"
```

---

### Task 11: Live proof on testnet, positive signing fixtures, skill update

**Files:**
- Create: `crypto/rust/tests/fixtures/tab/{spend_seed.hex,sweep.proved.pczt,expected.json}`, `crypto/rust/tests/fixtures/README.md`
- Modify: `crypto/rust/tests/pczt.rs`, `crypto/test/wasm.test.ts`, `.claude/skills/ztab-zcash-stack/reference/pczt-and-wasm.md`, `.claude/skills/ztab-zcash-stack/reference/timings-and-status.md`

**Interfaces:**
- Consumes: everything above. Produces the spec §1 success criterion.

- [ ] **Step 1: Run the live test through the module (needs the payer seed, ~5–15 min)**

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
export ZTAB_TEST_SEED_HEX=$(cat ~/.config/ztab/testnet-payer-seed.hex)
export ZTAB_TEST_SIGNER_CMD="node ../crypto/scripts/sign-stdin.ts"
export ZTAB_TEST_DUMP_DIR="$PWD/crypto/rust/tests/fixtures/tab"
cd watcher && cargo test --test testnet_live full_tab_lifecycle -- --ignored --nocapture
```
Expected: the test passes; its log shows `sweep fixture dumped to …` and the broadcast `200`, then the sweep mined. Record the timings it prints. If the external signer fails, its stderr line (`<code>: <message>`) is in the test output; fix and rerun (each run costs 0.0002 TAZ in fees).

- [ ] **Step 2: Write the failing positive tests**

Append to `crypto/rust/tests/pczt.rs`:
```rust
mod real_tab {
    use super::*;
    use pczt::roles::verifier::Verifier;
    use ztab_crypto::keys::derive_tab_account;

    fn tab(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/tests/fixtures/tab/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn signs_a_real_watcher_sweep_with_the_tab_key() {
        let exp: serde_json::Value = serde_json::from_slice(&tab("expected.json")).unwrap();
        let seed = hex::decode(String::from_utf8(tab("spend_seed.hex")).unwrap().trim()).unwrap();
        let account = derive_tab_account(Network::TestNetwork, &seed).unwrap();
        assert_eq!(account.ufvk, exp["ufvk"].as_str().unwrap());

        let proved = tab("sweep.proved.pczt");
        let summary = inspect(Network::TestNetwork, &proved).unwrap();
        assert_eq!(summary.txid, exp["txid"].as_str().unwrap());
        assert_eq!(summary.fee_zat, exp["feeZat"].as_u64().unwrap());
        assert_eq!(summary.outputs.iter().map(|o| o.zat).sum::<u64>(), exp["outputZat"].as_u64().unwrap());

        let expected = Expected {
            recipient: exp["recipient"].as_str().unwrap().to_string(),
            total_zat: exp["outputZat"].as_u64().unwrap(),
            fee_zat: exp["feeZat"].as_u64().unwrap(),
        };
        let signed = sign(Network::TestNetwork, &proved, &account.orchard_sk[..], &[4u8; 32], &expected).unwrap();

        // Every action now carries a spend authorization, and the transaction is unchanged.
        let mut unsigned = 0;
        Verifier::new(parse(&signed).unwrap())
            .with_ironwood::<std::convert::Infallible, _>(|b| {
                unsigned = b.actions().iter().filter(|a| a.spend().spend_auth_sig().is_none()).count();
                Ok(())
            })
            .unwrap();
        assert_eq!(unsigned, 0);
        assert_eq!(inspect(Network::TestNetwork, &signed).unwrap(), summary);
        // Signatures are randomized: a different rng seed gives different bytes, same effects.
        let again = sign(Network::TestNetwork, &proved, &account.orchard_sk[..], &[5u8; 32], &expected).unwrap();
        assert_ne!(again, signed);
    }
}
```

Append to `crypto/test/wasm.test.ts` inside `describe('pczt', …)`:
```ts
  it('signs the real tab fixture end to end', () => {
    const exp = JSON.parse(readFileSync(new URL('../rust/tests/fixtures/tab/expected.json', import.meta.url), 'utf8')) as {
      ufvk: string; recipient: string; outputZat: number; feeZat: number; txid: string;
    };
    const seed = new Uint8Array(Buffer.from(readFileSync(new URL('../rust/tests/fixtures/tab/spend_seed.hex', import.meta.url), 'utf8').trim(), 'hex'));
    const proved = new Uint8Array(readFileSync(new URL('../rust/tests/fixtures/tab/sweep.proved.pczt', import.meta.url)));
    const account = deriveTabAccount('test', seed);
    expect(account.ufvk).toBe(exp.ufvk);
    const summary = inspectPczt('test', proved);
    expect(summary.txid).toBe(exp.txid);
    const signed = signPczt('test', proved, account.orchardSk, crypto.getRandomValues(new Uint8Array(32)), {
      recipient: exp.recipient, totalZat: exp.outputZat, feeZat: exp.feeZat,
    });
    expect(signed.length).toBeGreaterThan(proved.length);
    expect(inspectPczt('test', signed)).toEqual(summary);
  });
```

- [ ] **Step 3: Run both suites**

Run: `(cd crypto/rust && cargo test) && (cd crypto && pnpm test && pnpm typecheck)`
Expected: all green, including the two new positive tests.

- [ ] **Step 4: Fixture README**

`crypto/rust/tests/fixtures/README.md`:
```markdown
# Fixtures

- `spend_seed.hex`, `expected.json`: a deterministic tab. The seed is
  `HKDF-SHA256(master = 00…1f, salt = "0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70", info = "ztab/v1/spend")`,
  the same vectors as `crypto/test/fixtures/hkdf.json`; the UFVK and the addresses at indices
  0, 1, 7 were derived natively with the pinned crates. The seed owns nothing on any network.
- `tab/`: one real throwaway tab from a run of the watcher's `full_tab_lifecycle_on_testnet`
  with `ZTAB_TEST_DUMP_DIR` set (see `watcher/tests/fixtures/README.md`). `sweep.proved.pczt`
  is the watcher's proved closing PCZT for that tab; `spend_seed.hex` signs it; `expected.json`
  is what `inspect` must report. The tab's funds were swept back to the payer in that run, so
  the seed is public and worthless. Regenerate all three together, never one of them.
- Watcher PCZTs used read-only: `../../watcher/tests/fixtures/sweep*.pczt` (no key for them
  exists any more; they exercise inspection and the negative signing paths).
```

- [ ] **Step 5: Update the skill**

In `.claude/skills/ztab-zcash-stack/reference/pczt-and-wasm.md`, under "Browser side", add after the build recipe:
```markdown
## Reference implementation (2026-10-1x): `crypto/` (`@ztab/crypto`)
wasm-bindgen 0.2.129 with `--target web` works on the cohort (`zcash_keys` with `orchard`,
`pczt` signer, `zcash_primitives` without default features); module size <SIZE> MB; the only
imports are wasm-bindgen's `wbg.*` shims. Build: `crypto/build.sh` (Docker, named volumes make
rebuilds fast). The signing rule above is `crypto/rust/src/pczt_ops.rs::sign`; the
expectation check (`check_expectation`) runs before any signature. Live proof:
`watcher/tests/testnet_live.rs::full_tab_lifecycle_on_testnet` with `ZTAB_TEST_SIGNER_CMD`
pointing at `crypto/scripts/sign-stdin.ts` (passed on <DATE>: sign <SIGN_MS> ms in Node, sweep
mined after <MINED_S> s).
```
Replace `<SIZE>`, `<DATE>`, `<SIGN_MS>`, `<MINED_S>` with the measured values from Steps 1–2 (size from `ls -la crypto/pkg`, timing from the live test log; if the signer time was not measured, time `pnpm test` for the real-tab case and say so).

In `reference/timings-and-status.md` add one line to the measured timings: "Browser-module path (Node, wasm): identical sweep timings to the in-process signer; signing itself <SIGN_MS> ms."

- [ ] **Step 6: Commit**

```bash
git add crypto/rust/tests crypto/test .claude/skills/ztab-zcash-stack/reference
git commit -m "crypto: real-tab signing fixtures from the testnet run; skill: wasm-bindgen facts"
```

- [ ] **Step 7: Final check of the whole branch**

Run from the repo root:
```sh
(cd crypto/rust && cargo test) && (cd watcher && cargo test) && pnpm test && pnpm typecheck && git status --short
```
Expected: every suite green, working tree clean, `crypto/pkg/*.wasm` tracked (`git ls-files crypto/pkg`).
