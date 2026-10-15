---
name: ztab-zcash-stack
description: Use when working on ZTab's Zcash side - choosing librustzcash crate versions, writing the Rust watcher, picking lightwalletd/Zebra/Zaino versions for testnet, deciding confirmation or payment-status rules, building or signing PCZTs, compiling pczt to WASM for the browser, getting TAZ, or when anything mentions NU7, Ironwood, Orchard, ZIP 315, ZIP 321 or testnet.zec.rocks
---

# ZTab Zcash stack (verified on testnet 2026-10-15)

## Overview
Zcash testnet already runs **NU7** and all shielded payments land in the **Ironwood** pool. Most training-data knowledge about versions, pools, block times and signing is stale. Check `reference/` before committing to any version, height, block count or pool name.

## What agents get wrong without this skill
| Belief | Reality |
|---|---|
| `zcash_client_backend 0.24` (or older) with mixed `zcash_primitives 0.28`, `pczt 0.6`, `rand_core 0.6` | Only the exact NU7 pre-release cohort in `reference/crates.md` builds and produces transactions testnet accepts. Stable 0.24 signs with the NU6.3 branch id and is rejected. |
| Payments arrive as Orchard notes; sign with `sign_orchard` | They are **Ironwood** notes. Scan Ironwood, prove with `create_ironwood_proof`, sign with `sign_ironwood(rng, index, &ask)`. Orchard-only signing fails at extraction with `MissingSpendAuthSig`. |
| 75 s blocks, 40-block expiry | Testnet: 25 s target (30–35 s observed), expiry 120 blocks. Mainnet keeps 75 s until NU7 activates there. Keep both in config. |
| Zebra 3.x/6.x + Zaino for the demo | Zebra **7.0.0-rc.0** + lightwalletd **0.5.5**. Zaino has no NU7 support yet. Sync from a snapshot (minutes), not genesis. |
| `wasm-pack` the signer on a Mac | `pczt` drags secp256k1 C code; Apple clang cannot target wasm32. Use the Docker recipe in `reference/pczt-and-wasm.md`. Stable Rust is enough. |
| Role methods take `(index, &key)` | Every prover/signer/extractor call now takes an rng first; wallet builder functions take `clock` and `rng` after `params`. |

## Quick reference
- Testnet server: `https://testnet.zec.rocks:443`. NU7 branch id `0x77190AD9`, testnet activation 4465026.
- Faucet: `POST https://fauzec.com/api/v1/claim {"network":"testnet","address":"utest1..."}` (1 TAZ/day).
- View-only account from UFVK with a recent birthday syncs in ~0.5 s. Mempool shows a payment within ~15 s, mined in 35 s–3 min.
- Status: mempool = hint only; **paid** = ≥ 3 confirmations; **sweepable** = ≥ 10; receipt never triggers an on-chain action.
- Closing a tab: server `create_pczt_from_proposal` + prove (1.4 s, 12 KB), browser signs in WASM (~20 ms, zero imports), server extracts + broadcasts. End-to-end verified; see `reference/pczt-and-wasm.md`.
- Working CLIs: zingo-cli (`zingolib` dev, direct mode needs `--no-default-features --features nakednet-test-mode`), zcash-devtool main + `tools/devtool-nu7.patch`.

## Files
- `reference/crates.md` — exact cohort, API changes, CLI build flags.
- `reference/network-and-infra.md` — upgrades, heights, servers, Docker images, snapshots, faucets, wallet status.
- `reference/timings-and-status.md` — measured numbers and status rules.
- `reference/pczt-and-wasm.md` — sweep flow, signer inputs, WASM build.
- `reference/privacy-invariants.md` — rules whose violation disqualifies the project. Read before touching keys, URLs, statuses or infra.
- `tools/devtool-nu7.patch`, `tools/pczt-wasm/` — the patch and the signer probe used in the verification.

## Common mistakes
- Pinning `^` ranges: the pre-releases pin each other; use `=` and bump as a set.
- Trusting `testnet.zcashexplorer.app`: it is stuck pre-NU7. Ask lightwalletd `GetLatestBlock`.
- Calling `pczt create-max` before every note has 10 confirmations: it refuses unless `--only-spendable`.
- Planning cross-chain pay-in through NEAR Intents: it delivers ZEC to transparent addresses only.
