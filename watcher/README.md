# ztab-watcher

The watcher is a Rust service that watches Zcash testnet (or mainnet) for payments to ZTab
tabs. It imports each tab as a **view-only** account from the tab's UFVK. It reports
per-participant payment facts: mempool sightings, then mined notes with their confirmation
counts. When a tab closes, it builds and proves a PCZT sweep. The browser signs that PCZT,
and the watcher checks it against the offer and broadcasts it. The watcher never receives
a spending key.

The design is in `docs/superpowers/specs/2026-10-15-ztab-watcher-design.md`. Zcash
network facts are in the project skill `.claude/skills/ztab-zcash-stack`: crate cohort,
NU7/Ironwood, servers, faucets, timings, PCZT signing and the privacy invariants. Read it
before changing crate versions, confirmation rules or anything that touches keys.

## Run

```sh
ZTAB_API_TOKEN=change-me ZTAB_DATA_DIR=./data cargo run --release
# logs are JSON on stdout; RUST_LOG=ztab_watcher=debug for more
curl localhost:8787/v1/health
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `ZTAB_API_TOKEN` | **required** | Bearer token the API must send (`Authorization: Bearer …`). |
| `ZTAB_DATA_DIR` | **required** | Directory for the wallet DB (`wallet.sqlite`), tab metadata, the compact-block cache and Tor state. |
| `ZTAB_NETWORK` | `test` | `test` or `main`. |
| `ZTAB_LIGHTWALLETD_URL` | `https://testnet.zec.rocks:443` | lightwalletd gRPC endpoint. |
| `ZTAB_CONNECTION` | `direct` on testnet, `tor` on mainnet | `direct` or `tor` (embedded Arti client). |
| `ZTAB_CONFIRMATIONS_PAID` | `3` | Confirmations at which a payment counts as paid. |
| `ZTAB_CONFIRMATIONS_SWEEP` | `10` | Confirmations every note needs before a sweep can be offered. Also the depth at which a sweep moves the tab to `closed`. |
| `ZTAB_BLOCK_INTERVAL_SECONDS` | `25` on testnet, `75` on mainnet | Sets the sync-loop pace (half a block, at least 5 s) and the mempool-sighting expiry (120 blocks). |
| `ZTAB_LISTEN` | `127.0.0.1:8787` | HTTP listen address. |

## HTTP API

Every route except `GET /v1/health` requires the bearer token.

| Route | Purpose |
|---|---|
| `POST /v1/tabs` | Register a tab: `{tab_id, ufvk, birthday, participants_count}`. The birthday must be at least `tip - 1000`. Returns the participants' Orchard-only addresses. Idempotent. |
| `GET /v1/tabs/{id}` | Payment facts per participant, plus `state`, `synced_height`, `tip_height` and `stale`. |
| `POST /v1/tabs/{id}/sweep` | Offer a proved PCZT that sweeps the whole tab to `recipient_address`. Returns 409 until every note has `ZTAB_CONFIRMATIONS_SWEEP` confirmations. |
| `POST /v1/tabs/{id}/broadcast` | Takes the signed PCZT of the current offer, extracts it and broadcasts it. The tab moves to `sweeping`. |
| `GET /v1/tabs/{id}/sweep` | Sweep progress: `txid`, `mined_height`, `confirmations` and `state`. Moves `sweeping → closed` at sweep depth. |
| `GET /v1/health` | Tip, synced height, lag and mempool subscription. |

## Tests

```sh
cargo test                                    # unit tests + offline integration tests (no network)
cargo test --test testnet_live -- --ignored   # live tests against testnet.zec.rocks (a few minutes)
```

- **Unit tests** live in `src/`. **Offline integration tests** are `tests/mempool.rs` and
  `tests/sweep.rs`, and they replay the saved fixtures in `tests/fixtures/`.
- **Live tests** are in `tests/testnet_live.rs`. All of them are `#[ignore]` and need
  network access to `testnet.zec.rocks`. Most of them watch the spike's fixture UFVK
  (`tests/fixtures/fixture-ufvk.txt`) and need no funds.
- **The end-to-end scenario** `full_tab_lifecycle_on_testnet` is the spec's success
  criterion. A funded payer wallet pays a freshly registered tab. The watcher reports the
  payment in the mempool (60 s at most), then as mined, paid at 3 confirmations and
  sweepable at 10. The test then signs the watcher's sweep like the browser does, and the
  sweep is mined. It needs `ZTAB_TEST_SEED_HEX` (a funded testnet seed that is never
  committed) and takes about 5 minutes (up to ~15 with slow blocks). Run it on its own:
  ```sh
  ZTAB_TEST_SEED_HEX=… cargo test --test testnet_live full_tab_lifecycle -- --ignored --nocapture
  ```
  Without the variable, this test and `fixture_payer_address` print `SKIPPED` and pass,
  so the plain `--ignored` run stays green.
  To create and fund the payer, see `tests/fixtures/README.md`.

Before committing, run `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`.
