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
# logs are JSON on stdout at info by default; RUST_LOG overrides (e.g. RUST_LOG=ztab_watcher=debug)
curl localhost:8787/v1/health
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `ZTAB_API_TOKEN` | **required** | Bearer token the API must send (`Authorization: Bearer …`). |
| `ZTAB_DATA_DIR` | **required** | Directory for the wallet DB (`wallet.sqlite`), tab metadata, the compact-block cache and Tor state. |
| `ZTAB_NETWORK` | `test` | `test` or `main`. |
| `ZTAB_LIGHTWALLETD_URL` | `https://testnet.zec.rocks:443` | lightwalletd gRPC endpoint. Must be `https://`; plaintext `http://` is accepted only for loopback or private-range hosts (127/8, ::1, 10/8, 172.16/12, 192.168/16, `localhost`). |
| `ZTAB_CONNECTION` | `direct` on testnet, `tor` on mainnet | `direct` or `tor` (embedded Arti client). |
| `ZTAB_CONFIRMATIONS_PAID` | `3` | Confirmations at which a payment counts as paid. |
| `ZTAB_CONFIRMATIONS_SWEEP` | `10` | Confirmations every note needs before a sweep can be offered. Also the depth at which a sweep moves the tab to `closed`. |
| `ZTAB_BLOCK_INTERVAL_SECONDS` | `25` on testnet, `75` on mainnet | Sets the sync-loop pace (half a block, at least 5 s) and the mempool-sighting expiry (120 blocks). |
| `ZTAB_LISTEN` | `127.0.0.1:8787` | HTTP listen address. |

## Container

```sh
docker build -f watcher/Dockerfile -t ztab-watcher:dev watcher   # cargo-chef, bookworm-slim runtime
docker run --rm -d --name ztab-watcher -e ZTAB_API_TOKEN=change-me \
  -v ztab_data:/data -p 127.0.0.1:8787:8787 ztab-watcher:dev
```

- Runs as the non-root user `watcher` (uid 10001); entrypoint `/usr/local/bin/ztab-watcher`.
- Image defaults: `ZTAB_DATA_DIR=/data` (declared `VOLUME /data`, holds the wallet DB, so keep it on a named volume) and `ZTAB_LISTEN=0.0.0.0:8787`. `ZTAB_API_TOKEN` is required; the other variables above keep their defaults (testnet, `https://testnet.zec.rocks:443`).
- `HEALTHCHECK` curls `http://127.0.0.1:8787/v1/health`, which is public (no token). It answers 200 as soon as the HTTP server binds, before the first sync, so `healthy` means up, not synced; read `synced_height` and `lag_seconds` in the body (the API's `/api/status` turns them into `ok`/`stale`).

## HTTP API

Every route except `GET /v1/health` requires the bearer token.

| Route | Purpose |
|---|---|
| `POST /v1/tabs` | Register a tab: `{tab_id, ufvk, birthday, participants_count}`. The birthday must be at least `tip - 1000`. Returns the participants' Orchard-only addresses. Idempotent. |
| `GET /v1/tabs/{id}` | Payment facts per participant, plus `state`, `active`, `synced_height`, `tip_height` and `stale`, and `balance`: `spendable_zat` (unspent notes, i.e. not spent by a mined or still-unexpired transaction, with at least `ZTAB_CONFIRMATIONS_SWEEP` confirmations), `pending_zat` (unspent notes below that, plus mempool payments not yet in the wallet), `swept_zat` (`output_zat` of the tab's mined sweeps) and `min_unspent_confirmations` (fewest confirmations over unspent mined notes, `null` when there are none). Tabs in state `open`, `sweeping` and `closed` are watched (mempool loop, fact refresh, sweep advancement) unless paused; only `abandoned` and paused tabs are skipped. |
| `PUT /v1/tabs/{id}/active` | Pause or resume a tab: `{"active": bool}`, returns 204 (404 for an unknown tab, 422 for a missing `active`). A paused tab is skipped by the mempool loop, fact refresh and sweep advancement, and `GET` reports `"active": false`; its `state` is unchanged. |
| `POST /v1/tabs/{id}/sweep` | Offer a proved PCZT that sweeps the whole tab to `recipient_address`, which must be a unified address of this network with an Orchard or Sapling receiver (transparent and TEX addresses get 422). A body with a `memo` gets 422 (`memo is not supported`). Returns 409 until every note has `ZTAB_CONFIRMATIONS_SWEEP` confirmations. Allowed from `open` and from `closed` (money paid during or after a close is swept the same way; nothing is swept automatically). `summary` carries `inputs_zat`, `output_zat`, `fee_zat`, `expiry_height`, `txid` and `pending_mempool_zat` (payments seen in the mempool but not mined, which this sweep would leave behind). The offered PCZT is not stored; only its txid and expiry height are. |
| `POST /v1/tabs/{id}/broadcast` | Takes the signed PCZT of the current offer, extracts it and broadcasts it. The tab moves to `sweeping`. Idempotent: resubmitting the PCZT of a sweep already broadcast returns 200 with its `txid`. |
| `GET /v1/tabs/{id}/sweep` | Sweep progress: `txid`, `mined_height`, `confirmations` and `state`, plus `history`: every broadcast sweep of the tab, newest first, as `{txid, output_zat, fee_zat, mined_height, confirmations}` (offers that were never broadcast are not listed). Moves `sweeping → closed` at sweep depth and `sweeping → open` after an unmined sweep expires; every sync pass applies the same advancement. |
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
