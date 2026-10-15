# Closing a tab: PCZT on the server, signature in the browser (verified end to end 2026-10-15)

## Server side (devtool equivalents of the watcher calls)
```bash
zcash-devtool pczt -w <wallet> create-max --address <payer UA> --memo "..." --output created.pczt   # create_pczt_from_proposal
zcash-devtool pczt -w <wallet> prove created.pczt --output proved.pczt                              # Prover role, 1.4 s, needs no spending key
# -> hand proved.pczt (12 KB) to the browser
zcash-devtool pczt -w <wallet> send signed.pczt                                                     # extract_and_store_transaction_from_pczt + broadcast
```
`pczt inspect proved.pczt` shows amounts, recipient address, txid and version (V6 after NU6.3): that is the confirmation screen content.

## Browser side
`pczt` 0.10.0-pre.1 with features `signer, orchard` + `orchard 0.16` + `rand 0.10` (`std_rng` only, no getrandom) compiles to `wasm32-unknown-unknown` on **stable** Rust and runs with **zero imports**. Signer inputs: proved PCZT bytes, the tab's 32-byte Orchard spending key, a 32-byte RNG seed from `crypto.getRandomValues`. Measured in Node: parse + `Signer::new` 8 ms, `sign_ironwood` ~20 ms. Reference implementation: `tools/pczt-wasm/` (`src/lib.rs` exports `alloc`, `probe_parse`, `probe_sign`; `sign.mjs` is the host harness; `examples/derive.rs` derives the key natively from a mnemonic).

Sign only actions whose spend carries a ZIP 32 derivation (dummy spends are already signed by the IO finalizer). Collect indices with `Verifier::new(pczt).with_ironwood(|bundle| ...)`, then `Signer::sign_ironwood(&mut rng, index, &SpendAuthorizingKey::from(&sk))`, `finish().serialize()`.

## Build recipe (the only non-obvious part)
`pczt` pulls `secp256k1-sys` (C) through `zcash_script`/`bip32`/`zcash_transparent` even for shielded-only features. Apple clang has no wasm32 target. Build in Docker:
```bash
docker run --rm -v "$PWD":/w -w /w rust:1.98-bookworm sh -c '
  apt-get update -qq && apt-get install -y -qq clang lld llvm >/dev/null;
  rustup target add wasm32-unknown-unknown;
  CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=/usr/bin/llvm-ar \
  cargo build --release --target wasm32-unknown-unknown'
```
Result: ~1.07 MB module at opt-level "s". WebZjs (ChainSafe) is stale (last commit 2026-04, NU6.1 fork) and is not a route.

## ZIP 321 request for a participant (syntax per ZIP 321; wallet deep-link behaviour still to be checked by hand)
```
zcash:utest1...<participant diversified UA>?amount=0.01234567&message=Dinner%20at%20Luigi%27s%20%E2%80%94%20your%20share&label=ZTab
```
- Amount: decimal ZEC with a period, ≤ 8 fractional digits, no grouping.
- `message` and `label` are percent-encoded; `memo` would be base64url without padding (≤ 512 bytes) and is only valid with a shielded address.
- Ironwood changes nothing here: the address is a normal UA with an Orchard receiver; the sending wallet picks the Ironwood pool.
- Render the same string as a QR for desktop; on mobile use it as the `href`.
