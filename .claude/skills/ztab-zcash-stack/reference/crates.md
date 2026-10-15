# librustzcash crate cohort for post-NU7 testnet (verified building and sending 2026-10-15)

Stable `zcash_client_backend 0.24` does **not** know the NU7 testnet height. Use the pre-release cohort below. The pre-releases pin each other, so pin exactly and bump as a set (zingolib PR #2878 is the reference bump).

```toml
zcash_client_backend = { version = "=0.25.0-pre.1", features = ["lightwalletd-tonic-tls-webpki-roots", "orchard", "pczt", "tor"] }
zcash_client_sqlite  = { version = "=0.23.0-pre.1", features = ["orchard", "transparent-inputs"] }
zcash_keys           = { version = "=0.17.0-pre.1", features = ["orchard", "sapling"] }
zcash_primitives     = "=0.31.0-pre.1"
zcash_proofs         = { version = "=0.31.0-pre.1", features = ["bundled-prover"] }
zcash_protocol       = "=0.11.0-pre.0"   # sets NU7 testnet height 4465026, branch 0x77190AD9
zcash_address        = "=0.14.0-pre.1"
zcash_transparent    = "=0.11.0-pre.1"
pczt                 = { version = "=0.10.0-pre.1", features = ["io-finalizer", "orchard", "prover", "signer", "spend-finalizer", "tx-extractor"] }
zip321               = "=0.10.0-pre.1"
orchard = "0.16.0"
sapling-crypto = "0.9"
zip32 = "0.3"
shardtree = "0.8"
incrementalmerkletree = "0.9"
bip32 = "0.6"
jubjub = "0.11"
secp256k1 = "0.33"
rand = { version = "0.10", default-features = false, features = ["std", "sys_rng"] }
zcash_encoding = "0.5"
zcash_note_encryption = "0.5.1"
```

A newer consistent set (`*-pre.2`) exists on crates.io; mixing pre.1 and pre.2 fails to resolve. NU7 **mainnet** height is in none of them yet; adopt the finals before 2026-11-05 if mainnet is ever targeted.

## API changes vs 0.24 that bite (all hit while porting zcash-devtool)
- `rand 0.10` removed `rand::rngs::OsRng`. Shim: `type OsRng = rand::rand_core::UnwrapErr<rand::rngs::SysRng>; const OsRng: OsRng = UnwrapErr(SysRng);` (needs rand feature `sys_rng`).
- `create_pczt_from_proposal`, `create_proposed_transactions` take `clock: &impl Clock, rng: &mut impl CryptoRng` right after `params`. `extract_and_store_transaction_from_pczt` takes them right after `wallet_db`.
- pczt roles take an rng: `Prover::create_orchard_proof(rng, &pk)`, `create_ironwood_proof(rng, &pk)`, `create_sapling_proofs(rng, &spend_prover, &output_prover)`, `Signer::sign_orchard/sign_ironwood/sign_sapling(rng, index, &ask)`, `IoFinalizer::finalize_io(rng)`, `TransactionExtractor::extract(rng)`.
- `zcash_address::unified::Ufvk::decode` returns `(NetworkType, Revision, Ufvk)`.
- `UnifiedFullViewingKey::encode(&params)` returns `Result<String, UnifiedEncodingError>`.
- `sapling::zip32::ExtendedSpendingKey::expsk` is private: use `.expsk()`, `.expsk().ask()`, `.expsk().proof_generation_key()`; build with `ProofGenerationKey::from_parts(ak, nsk)`.
- `UnifiedAddress::from_receivers(orchard, sapling, transparent, expiry_height, expiry_time)` (5 args).
- `LocalNetwork` gained `nu7: Option<BlockHeight>`.
- `tor::http::Client::get_latest_zec_to_usd_rate(&mut rng, &exchanges)`.
- Ironwood spends must be signed with `sign_ironwood`; signing only Orchard leaves `MissingSpendAuthSig` at extraction.

## Tools that already build on this cohort
- **zingo-cli** from `zingolib` branch `dev` (toolchain 1.99.0 pinned): `cargo build --release -p zingo-cli --no-default-features --features nakednet-test-mode` (default build refuses to go online without the Nym proxy). Run: `zingo-cli --chain testnet --server https://testnet.zec.rocks:443 --data-dir <dir> [--nosync] <cmd>`; interactive `send <addr> <zat> "<memo>"` then `confirm`. Quirk: one-shot `--waitsync <cmd>` never exits; run it, kill after ~40 s, read with `--nosync`.
- **zcash-devtool** main (5a26ee8, 2026-08-28) needs `tools/devtool-nu7.patch` (bumps the cohort, fixes the API list above, adds Ironwood signing from open PR #238, prunes inspect/migration/derive-path/update-with-signature). Apply with `git apply` on a fresh clone, then `cargo build --release`.

## Non-Zcash crates that must match the cohort
- `tonic = "0.14"` and `prost = "0.14"` (what `zcash_client_backend 0.25.0-pre.1` links; a different tonic makes the generated `CompactTxStreamerClient` types incompatible).
- `rusqlite = "0.37"` with feature `bundled` (what `zcash_client_sqlite 0.23.0-pre.1` uses; `WalletDb::for_path` opens the connection itself).
- `tokio 1.x` full features, `secrecy = "0.8"`, `age`/`bip0039 0.14` only if you handle mnemonics (ZTab's tab keys are raw 32-byte seeds, not mnemonics).
- Check with `cargo tree -i tonic` / `cargo tree -i rusqlite` after adding deps: exactly one version of each must appear.
