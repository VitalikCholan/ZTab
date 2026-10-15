# ZTab Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust HTTP service that registers tabs by viewing key, hands out per-participant addresses, reports payment facts from blocks and mempool, and runs the PCZT sweep (create + prove on the server, sign in the browser, extract + broadcast on the server) on post-NU7 Zcash testnet.

**Architecture:** One `tokio` process. A shared `WalletDb` (`zcash_client_sqlite`) holds one view-only account per tab; two background loops (block sync, mempool stream) feed it; an `axum` HTTP API reads facts by joining the wallet database's own tables with a small `ztab.sqlite` of watcher metadata. The sweep is a thin wrapper over `propose_send_max_transfer` + `create_pczt_from_proposal` + the `pczt` Prover and TransactionExtractor roles.

**Tech Stack:** Rust stable 1.98+, NU7 pre-release librustzcash cohort (exact pins in `.claude/skills/ztab-zcash-stack/reference/crates.md`), `axum 0.8`, `tokio 1`, `tonic 0.14`, `rusqlite 0.37` (bundled), `serde`/`serde_json`, `tracing`, `anyhow`/`thiserror`.

**Spec:** `docs/superpowers/specs/2026-10-15-ztab-watcher-design.md`. Read it and the skill `.claude/skills/ztab-zcash-stack/SKILL.md` before any task.

## Global Constraints

- Crate versions: exactly the cohort in `reference/crates.md`; `=`-pinned; never mix `pre.1` with `pre.2`; crates.io only, no git deps.
- Network: `ZTAB_NETWORK=test` → `Network::TestNetwork`; server `https://testnet.zec.rocks:443` for development and tests.
- Every incoming note is an **Ironwood** note; the sweep proves with `create_ironwood_proof`; signatures come from the browser via `sign_ironwood`.
- Confirmations from config: `ZTAB_CONFIRMATIONS_PAID` default 3, `ZTAB_CONFIRMATIONS_SWEEP` default 10, `ZTAB_BLOCK_INTERVAL_SECONDS` default 25. No block-time constants in code.
- Mempool sightings are hints and never become "confirmed" facts; receipt of a payment triggers no on-chain action.
- The watcher never receives, logs or stores spending keys, mnemonics or seeds. `info`-level logs carry no addresses, UFVKs or amounts.
- HTTP listens on `ZTAB_LISTEN` (default `127.0.0.1:8787`); every request except `/v1/health` needs `Authorization: Bearer <ZTAB_API_TOKEN>`.
- JSON: snake_case, zatoshi as integers, heights as integers, timestamps RFC 3339 UTC.
- Rust: `cargo fmt`, `cargo clippy -- -D warnings`, `#![forbid(unsafe_code)]` in the crate root.

## Review Focus

1. A `POST /v1/tabs` with the same `tab_id` but a different `ufvk` must return `409`, never silently rebind the tab (Task 5 test `register_rejects_ufvk_change`).
2. A reorg that drops the block holding a participant's note must make `confirmed_zat` go back to 0 on the next `GET` instead of leaving a stale "paid" (Task 7 test `reorg_truncate_clears_confirmed_facts`, simulated with `truncate_to_height`).
3. A mempool stream that closes on every new block must be re-subscribed; a closed stream is not "mempool empty" (Task 8 test `mempool_loop_resubscribes_after_stream_end`).
4. A `broadcast` with a PCZT whose txid differs from the last `sweep` for that tab must return `409`, so a stale or foreign PCZT can never be transmitted under a tab (Task 9 test `broadcast_rejects_mismatched_pczt`).
5. `GET /v1/tabs/{id}` while lightwalletd is unreachable must still answer from the database with `stale: true` and a `lag_seconds`, not time out (Task 10 test `get_tab_is_served_from_db_when_offline`).

---

## File Structure

```
watcher/
  Cargo.toml
  src/
    main.rs            # config load, tracing init, spawn loops, serve HTTP
    config.rs          # Config from env (Task 1)
    error.rs           # WatcherError + IntoResponse mapping (Task 1)
    rng.rs             # OsRng shim for rand 0.10 (Task 1)
    remote.rs          # lightwalletd client factory, TLS/Tor (Task 2)
    wallet.rs          # WalletStore: open WalletDb, import tab account, addresses (Task 3, 4)
    meta.rs            # MetaStore: ztab.sqlite tables tabs, mempool_sightings, sweeps (Task 3)
    facts.rs           # payment facts query: wallet db joins + sightings (Task 6)
    sync.rs            # SyncLoop: subtree roots, chain tip, download, scan, rewind (Task 7)
    mempool.rs         # MempoolLoop: GetMempoolStream, decrypt, sightings (Task 8)
    sweep.rs           # SweepService: propose, pczt create, prove, extract, send (Task 9)
    http/
      mod.rs           # Router, auth layer, AppState (Task 5)
      tabs.rs          # POST /v1/tabs, GET /v1/tabs/{id} (Task 5, 6)
      sweep.rs         # POST sweep, POST broadcast, GET sweep (Task 9)
      health.rs        # GET /v1/health (Task 10)
  tests/
    common/mod.rs      # test harness: temp dirs, Config for testnet, fixture UFVK (Task 2)
    testnet_live.rs    # integration tests against testnet.zec.rocks, #[ignore] by default (Task 11)
```

Rules for every task: the engineer runs `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test` before each commit. Unit tests live next to the code (`#[cfg(test)] mod tests`); tests that hit the network live in `tests/testnet_live.rs` and are `#[ignore]`d, run with `cargo test --test testnet_live -- --ignored`.

---

### Task 1: Crate skeleton, config, errors, rng shim

**Files:**
- Create: `watcher/Cargo.toml`, `watcher/src/main.rs`, `watcher/src/config.rs`, `watcher/src/error.rs`, `watcher/src/rng.rs`

**Interfaces:**
- Produces: `Config { network: Network, lightwalletd_url: String, connection: Connection, confirmations_paid: u32, confirmations_sweep: u32, block_interval_seconds: u64, data_dir: PathBuf, listen: SocketAddr, api_token: String }`, `Config::from_env() -> Result<Config, WatcherError>`, `enum Connection { Direct, Tor }`, `WatcherError` (thiserror) with variants `Config(String)`, `Wallet(String)`, `Remote(String)`, `NotFound(String)`, `Conflict(String)`, `Unprocessable(String)`, `Internal(anyhow::Error)`, and `crate::rng::OsRng`.

- [ ] **Step 1: Write Cargo.toml with the cohort**

```toml
[package]
name = "ztab-watcher"
version = "0.1.0"
edition = "2021"
rust-version = "1.98"

[dependencies]
zcash_client_backend = { version = "=0.25.0-pre.1", features = ["lightwalletd-tonic-tls-webpki-roots", "orchard", "pczt", "tor"] }
zcash_client_sqlite  = { version = "=0.23.0-pre.1", features = ["orchard", "transparent-inputs"] }
zcash_keys           = { version = "=0.17.0-pre.1", features = ["orchard", "sapling"] }
zcash_primitives     = "=0.31.0-pre.1"
zcash_proofs         = { version = "=0.31.0-pre.1", features = ["bundled-prover"] }
zcash_protocol       = "=0.11.0-pre.0"
zcash_address        = "=0.14.0-pre.1"
zcash_transparent    = "=0.11.0-pre.1"
pczt                 = { version = "=0.10.0-pre.1", features = ["io-finalizer", "orchard", "prover", "signer", "spend-finalizer", "tx-extractor"] }
zip321               = "=0.10.0-pre.1"
orchard = "0.16.0"
sapling-crypto = "0.9"
zip32 = "0.3"
shardtree = "0.8"
incrementalmerkletree = "0.9"
rand = { version = "0.10", default-features = false, features = ["std", "sys_rng"] }
rusqlite = { version = "0.37", features = ["bundled", "time"] }
tonic = { version = "0.14", features = ["tls-webpki-roots"] }
prost = "0.14"
tokio = { version = "1", features = ["full"] }
tokio-stream = "0.1"
futures-util = "0.3"
axum = "0.8"
tower-http = { version = "0.6", features = ["trace"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
base64 = "0.22"
hex = "0.4"
time = { version = "0.3", features = ["formatting", "parsing"] }
anyhow = "1"
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
uuid = { version = "1", features = ["v4", "serde"] }

[dev-dependencies]
tempfile = "3"
reqwest = { version = "0.12", features = ["json"] }
```

- [ ] **Step 2: Write the failing config test** in `src/config.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn defaults_apply_for_testnet() {
        let cfg = Config::from_map(&env(&[("ZTAB_API_TOKEN", "t"), ("ZTAB_DATA_DIR", "/tmp/x")])).unwrap();
        assert_eq!(cfg.confirmations_paid, 3);
        assert_eq!(cfg.confirmations_sweep, 10);
        assert_eq!(cfg.block_interval_seconds, 25);
        assert_eq!(cfg.lightwalletd_url, "https://testnet.zec.rocks:443");
        assert!(matches!(cfg.network, zcash_protocol::consensus::Network::TestNetwork));
    }

    #[test]
    fn missing_token_is_an_error() {
        let err = Config::from_map(&env(&[("ZTAB_DATA_DIR", "/tmp/x")])).unwrap_err();
        assert!(err.to_string().contains("ZTAB_API_TOKEN"));
    }

    #[test]
    fn mainnet_defaults_to_75s_blocks_and_tor() {
        let cfg = Config::from_map(&env(&[("ZTAB_API_TOKEN", "t"), ("ZTAB_DATA_DIR", "/tmp/x"), ("ZTAB_NETWORK", "main"), ("ZTAB_LIGHTWALLETD_URL", "https://zec.rocks:443")])).unwrap();
        assert_eq!(cfg.block_interval_seconds, 75);
        assert!(matches!(cfg.connection, Connection::Tor));
    }
}
```

- [ ] **Step 3: Run it, expect compile failure** (`cargo test config` → "cannot find `Config`").

- [ ] **Step 4: Implement `config.rs`, `error.rs`, `rng.rs`, minimal `main.rs`**

```rust
// src/rng.rs
//! rand 0.10 removed `rand::rngs::OsRng`; this is the drop-in used by every call that
//! needs a `CryptoRng`.
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
pub type OsRng = UnwrapErr<SysRng>;
#[allow(non_upper_case_globals)]
pub const OsRng: OsRng = UnwrapErr(SysRng);
```

```rust
// src/error.rs
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};

#[derive(Debug, thiserror::Error)]
pub enum WatcherError {
    #[error("config: {0}")] Config(String),
    #[error("wallet: {0}")] Wallet(String),
    #[error("remote: {0}")] Remote(String),
    #[error("not found: {0}")] NotFound(String),
    #[error("conflict: {0}")] Conflict(String),
    #[error("unprocessable: {0}")] Unprocessable(String),
    #[error(transparent)] Internal(#[from] anyhow::Error),
}

impl IntoResponse for WatcherError {
    fn into_response(self) -> Response {
        let status = match &self {
            WatcherError::NotFound(_) => StatusCode::NOT_FOUND,
            WatcherError::Conflict(_) => StatusCode::CONFLICT,
            WatcherError::Unprocessable(_) | WatcherError::Config(_) => StatusCode::UNPROCESSABLE_ENTITY,
            WatcherError::Remote(_) => StatusCode::BAD_GATEWAY,
            WatcherError::Wallet(_) | WatcherError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        tracing::warn!(error = %self, "request failed");
        (status, Json(serde_json::json!({ "error": self.to_string() }))).into_response()
    }
}
```

```rust
// src/config.rs
use std::{collections::HashMap, net::SocketAddr, path::PathBuf};
use zcash_protocol::consensus::Network;
use crate::error::WatcherError;

#[derive(Clone, Debug)]
pub enum Connection { Direct, Tor }

#[derive(Clone, Debug)]
pub struct Config {
    pub network: Network,
    pub lightwalletd_url: String,
    pub connection: Connection,
    pub confirmations_paid: u32,
    pub confirmations_sweep: u32,
    pub block_interval_seconds: u64,
    pub data_dir: PathBuf,
    pub listen: SocketAddr,
    pub api_token: String,
}

impl Config {
    pub fn from_env() -> Result<Self, WatcherError> {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(m: &HashMap<String, String>) -> Result<Self, WatcherError> {
        let get = |k: &str| m.get(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let network = match get("ZTAB_NETWORK").as_deref().unwrap_or("test") {
            "test" => Network::TestNetwork,
            "main" => Network::MainNetwork,
            other => return Err(WatcherError::Config(format!("ZTAB_NETWORK must be test or main, got {other}"))),
        };
        let is_main = matches!(network, Network::MainNetwork);
        let parse_u = |k: &str, d: u64| -> Result<u64, WatcherError> {
            get(k).map_or(Ok(d), |v| v.parse::<u64>().map_err(|_| WatcherError::Config(format!("{k} must be an integer"))))
        };
        Ok(Config {
            network,
            lightwalletd_url: get("ZTAB_LIGHTWALLETD_URL").unwrap_or_else(|| "https://testnet.zec.rocks:443".into()),
            connection: match get("ZTAB_CONNECTION").as_deref() {
                Some("tor") => Connection::Tor,
                Some("direct") => Connection::Direct,
                None => if is_main { Connection::Tor } else { Connection::Direct },
                Some(o) => return Err(WatcherError::Config(format!("ZTAB_CONNECTION must be direct or tor, got {o}"))),
            },
            confirmations_paid: parse_u("ZTAB_CONFIRMATIONS_PAID", 3)? as u32,
            confirmations_sweep: parse_u("ZTAB_CONFIRMATIONS_SWEEP", 10)? as u32,
            block_interval_seconds: parse_u("ZTAB_BLOCK_INTERVAL_SECONDS", if is_main { 75 } else { 25 })?,
            data_dir: PathBuf::from(get("ZTAB_DATA_DIR").ok_or_else(|| WatcherError::Config("ZTAB_DATA_DIR is required".into()))?),
            listen: get("ZTAB_LISTEN").unwrap_or_else(|| "127.0.0.1:8787".into()).parse().map_err(|_| WatcherError::Config("ZTAB_LISTEN must be host:port".into()))?,
            api_token: get("ZTAB_API_TOKEN").ok_or_else(|| WatcherError::Config("ZTAB_API_TOKEN is required".into()))?,
        })
    }
}
```

```rust
// src/main.rs (minimal for Task 1; later tasks add modules and spawn loops)
#![forbid(unsafe_code)]
mod config;
mod error;
mod rng;

use config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let cfg = Config::from_env()?;
    tracing::info!(listen = %cfg.listen, network = ?cfg.network, "ztab-watcher starting");
    Ok(())
}
```

- [ ] **Step 5: Run tests, expect 3 passes** (`cargo test config`).

- [ ] **Step 6: Commit** — `git add watcher && git commit -m "watcher: crate skeleton, config from env, error type, rand 0.10 OsRng shim"`

---

### Task 2: lightwalletd client and test harness

**Files:**
- Create: `watcher/src/remote.rs`, `watcher/tests/common/mod.rs`
- Modify: `watcher/src/main.rs` (add `mod remote;`)

**Interfaces:**
- Produces: `pub type LwdClient = zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient<tonic::transport::Channel>;` `pub async fn connect(cfg: &Config) -> Result<LwdClient, WatcherError>`; `pub async fn latest_height(client: &mut LwdClient) -> Result<(BlockHeight, BlockHash), WatcherError>`.
- Test harness: `common::testnet_config(tmp: &Path) -> Config` (testnet, direct, token `test-token`), `common::FIXTURE_UFVK: &str` (a testnet UFVK committed in the repo; not a secret), `common::FIXTURE_BIRTHDAY: u32`.

- [ ] **Step 1: Write the failing live test** `tests/testnet_live.rs`

```rust
mod common;
use ztab_watcher::remote;

#[tokio::test]
#[ignore = "needs network: cargo test --test testnet_live -- --ignored"]
async fn connects_and_reads_tip_on_nu7_testnet() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let (height, _hash) = remote::latest_height(&mut client).await.unwrap();
    assert!(u32::from(height) >= 4_465_026, "testnet must already be past NU7 activation");
}
```

This requires the crate to expose a library target: add `src/lib.rs` with `pub mod config; pub mod error; pub mod rng; pub mod remote;` and make `main.rs` use `ztab_watcher::*`. Keep `main.rs` as the only binary.

- [ ] **Step 2: Run it ignored, expect compile failure** (`cargo test --test testnet_live -- --ignored`).

- [ ] **Step 3: Implement `remote.rs`**

```rust
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient};
use zcash_protocol::consensus::BlockHeight;
use zcash_primitives::block::BlockHash;
use crate::{config::{Config, Connection}, error::WatcherError};

pub type LwdClient = CompactTxStreamerClient<Channel>;

pub async fn connect(cfg: &Config) -> Result<LwdClient, WatcherError> {
    match cfg.connection {
        Connection::Direct => connect_direct(&cfg.lightwalletd_url).await,
        Connection::Tor => connect_tor(cfg).await,
    }
}

async fn connect_direct(url: &str) -> Result<LwdClient, WatcherError> {
    let uri: tonic::transport::Uri = url.parse().map_err(|e| WatcherError::Config(format!("ZTAB_LIGHTWALLETD_URL: {e}")))?;
    let host = uri.host().ok_or_else(|| WatcherError::Config("lightwalletd url has no host".into()))?.to_string();
    let mut channel = Channel::builder(uri.clone());
    if uri.scheme_str() == Some("https") {
        let tls = ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots();
        channel = channel.tls_config(tls).map_err(|e| WatcherError::Remote(e.to_string()))?;
    }
    let channel = channel.connect().await.map_err(|e| WatcherError::Remote(format!("connect {url}: {e}")))?;
    Ok(CompactTxStreamerClient::new(channel))
}

async fn connect_tor(cfg: &Config) -> Result<LwdClient, WatcherError> {
    // zcash_client_backend::tor::Client bootstraps a Tor client in data_dir/tor and dials the
    // endpoint over it; mirror zcash-devtool `remote.rs::connect_over_tor`.
    let tor_dir = cfg.data_dir.join("tor");
    std::fs::create_dir_all(&tor_dir).map_err(|e| WatcherError::Config(e.to_string()))?;
    let tor = zcash_client_backend::tor::Client::create(&tor_dir, |_| {}).await.map_err(|e| WatcherError::Remote(format!("tor bootstrap: {e}")))?;
    let endpoint: tonic::transport::Endpoint = cfg.lightwalletd_url.parse().map_err(|e| WatcherError::Config(format!("ZTAB_LIGHTWALLETD_URL: {e}")))?;
    tor.connect_to_lightwalletd(endpoint).await.map_err(|e| WatcherError::Remote(format!("tor connect: {e}")))
}

pub async fn latest_height(client: &mut LwdClient) -> Result<(BlockHeight, BlockHash), WatcherError> {
    let latest = client.get_latest_block(service::ChainSpec::default()).await.map_err(|e| WatcherError::Remote(e.to_string()))?.into_inner();
    let height = BlockHeight::from_u32(u32::try_from(latest.height).map_err(|_| WatcherError::Remote("tip height overflow".into()))?);
    let hash: [u8; 32] = latest.hash.as_slice().try_into().map_err(|_| WatcherError::Remote("tip hash is not 32 bytes".into()))?;
    Ok((height, BlockHash(hash)))
}
```

If `tor::Client::create` or `connect_to_lightwalletd` differ in the pinned crate, open `~/.cargo/registry/src/*/zcash_client_backend-0.25.0-pre.1/src/tor.rs` and use the function that exists; the Tor path is not exercised by tests on testnet.

- [ ] **Step 4: Write `tests/common/mod.rs`**

```rust
use std::{collections::HashMap, path::Path};
use ztab_watcher::config::Config;

/// Testnet UFVK of the spike's view-only wallet; it is a viewing key, not a secret.
pub const FIXTURE_UFVK: &str = include_str!("../fixtures/fixture-ufvk.txt").trim_ascii();  // viewing key only, not a secret
pub const FIXTURE_BIRTHDAY: u32 = 4_503_583;

pub fn testnet_config(tmp: &Path) -> Config {
    let m: HashMap<String, String> = [
        ("ZTAB_API_TOKEN", "test-token"),
        ("ZTAB_DATA_DIR", tmp.to_str().unwrap()),
        ("ZTAB_NETWORK", "test"),
        ("ZTAB_LIGHTWALLETD_URL", "https://testnet.zec.rocks:443"),
    ].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    Config::from_map(&m).unwrap()
}
```

Replace the placeholder string with the real UFVK before committing (it is in the session memory `spike-results-2026-10-15` and in the spike scratchpad file `zingo-ufvk.txt`; it starts with `uviewtest1`).

- [ ] **Step 5: Run the live test, expect PASS** (`cargo test --test testnet_live -- --ignored connects_and_reads_tip`).

- [ ] **Step 6: Commit** — `git commit -m "watcher: lightwalletd client (direct TLS, tor) and testnet test harness"`

---

### Task 3: WalletStore and MetaStore (open databases, register a tab)

**Files:**
- Create: `watcher/src/wallet.rs`, `watcher/src/meta.rs`
- Modify: `watcher/src/lib.rs`

**Interfaces:**
- Produces:
  - `WalletStore::open(cfg: &Config) -> Result<WalletStore, WatcherError>` (creates `data_dir/wallet.sqlite` + `data_dir/blocks/`, runs `init_wallet_db`, opens `FsBlockDb`).
  - `WalletStore::db(&self) -> MutexGuard<WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>>` and `WalletStore::cache(&self) -> MutexGuard<FsBlockDb>` and `WalletStore::blocks_dir(&self) -> &Path`.
  - `WalletStore::import_tab_account(&self, client: &mut LwdClient, tab_id: Uuid, ufvk: &str, birthday: u32) -> Result<AccountUuid, WatcherError>`.
  - `MetaStore::open(cfg: &Config) -> Result<MetaStore, WatcherError>` (`data_dir/ztab.sqlite`), `MetaStore::insert_tab(&self, tab: &TabRow) -> Result<(), WatcherError>`, `MetaStore::get_tab(&self, tab_id: Uuid) -> Result<Option<TabRow>, WatcherError>`.
  - `TabRow { tab_id: Uuid, account_uuid: Uuid, ufvk: String, birthday: u32, participants_count: u32, state: TabState, created_at: OffsetDateTime }`, `enum TabState { Open, Sweeping, Closed, Abandoned }` with `as_str`/`parse`.

- [ ] **Step 1: Write the failing MetaStore unit test** in `src/meta.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn insert_and_get_tab_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MetaStore::open_at(&tmp.path().join("ztab.sqlite")).unwrap();
        let row = TabRow {
            tab_id: Uuid::new_v4(), account_uuid: Uuid::new_v4(), ufvk: "uviewtest1abc".into(),
            birthday: 4_503_583, participants_count: 4, state: TabState::Open,
            created_at: time::OffsetDateTime::now_utc().replace_nanosecond(0).unwrap(),
        };
        store.insert_tab(&row).unwrap();
        let got = store.get_tab(row.tab_id).unwrap().unwrap();
        assert_eq!(got.ufvk, row.ufvk);
        assert_eq!(got.participants_count, 4);
        assert_eq!(got.state, TabState::Open);
        assert!(store.get_tab(Uuid::new_v4()).unwrap().is_none());
    }

    #[test]
    fn insert_same_tab_twice_is_a_constraint_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MetaStore::open_at(&tmp.path().join("ztab.sqlite")).unwrap();
        let row = TabRow { tab_id: Uuid::new_v4(), account_uuid: Uuid::new_v4(), ufvk: "u".into(), birthday: 1, participants_count: 1, state: TabState::Open, created_at: time::OffsetDateTime::now_utc() };
        store.insert_tab(&row).unwrap();
        assert!(store.insert_tab(&row).is_err());
    }
}
```

- [ ] **Step 2: Run, expect compile failure.**

- [ ] **Step 3: Implement `meta.rs`**

```rust
use std::{path::Path, sync::Mutex};
use rusqlite::{params, Connection, OptionalExtension};
use time::OffsetDateTime;
use uuid::Uuid;
use crate::{config::Config, error::WatcherError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TabState { Open, Sweeping, Closed, Abandoned }

impl TabState {
    pub fn as_str(self) -> &'static str { match self { Self::Open => "open", Self::Sweeping => "sweeping", Self::Closed => "closed", Self::Abandoned => "abandoned" } }
    pub fn parse(s: &str) -> Option<Self> { match s { "open" => Some(Self::Open), "sweeping" => Some(Self::Sweeping), "closed" => Some(Self::Closed), "abandoned" => Some(Self::Abandoned), _ => None } }
}

#[derive(Clone, Debug)]
pub struct TabRow {
    pub tab_id: Uuid, pub account_uuid: Uuid, pub ufvk: String, pub birthday: u32,
    pub participants_count: u32, pub state: TabState, pub created_at: OffsetDateTime,
}

pub struct MetaStore { conn: Mutex<Connection> }

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tabs (
  tab_id TEXT PRIMARY KEY, account_uuid TEXT NOT NULL UNIQUE, ufvk TEXT NOT NULL,
  birthday INTEGER NOT NULL, participants_count INTEGER NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mempool_sightings (
  txid TEXT NOT NULL, tab_id TEXT NOT NULL, participant_index INTEGER NOT NULL,
  value_zat INTEGER NOT NULL, first_seen_at TEXT NOT NULL,
  PRIMARY KEY (txid, tab_id, participant_index)
);
CREATE TABLE IF NOT EXISTS sweeps (
  tab_id TEXT PRIMARY KEY, txid TEXT NOT NULL, pczt_b64 TEXT NOT NULL,
  expiry_height INTEGER NOT NULL, created_at TEXT NOT NULL, broadcast_at TEXT
);
"#;

impl MetaStore {
    pub fn open(cfg: &Config) -> Result<Self, WatcherError> { Self::open_at(&cfg.data_dir.join("ztab.sqlite")) }

    pub fn open_at(path: &Path) -> Result<Self, WatcherError> {
        if let Some(p) = path.parent() { std::fs::create_dir_all(p).map_err(|e| WatcherError::Wallet(e.to_string()))?; }
        let conn = Connection::open(path).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").map_err(|e| WatcherError::Wallet(e.to_string()))?;
        conn.execute_batch(SCHEMA).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn insert_tab(&self, t: &TabRow) -> Result<(), WatcherError> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO tabs (tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![t.tab_id.to_string(), t.account_uuid.to_string(), t.ufvk, t.birthday, t.participants_count, t.state.as_str(), rfc3339(t.created_at)],
        ).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn get_tab(&self, tab_id: Uuid) -> Result<Option<TabRow>, WatcherError> {
        self.conn.lock().unwrap().query_row(
            "SELECT tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at FROM tabs WHERE tab_id = ?1",
            params![tab_id.to_string()],
            |r| Ok(TabRow {
                tab_id: r.get::<_, String>(0)?.parse().unwrap(), account_uuid: r.get::<_, String>(1)?.parse().unwrap(),
                ufvk: r.get(2)?, birthday: r.get(3)?, participants_count: r.get(4)?,
                state: TabState::parse(&r.get::<_, String>(5)?).unwrap_or(TabState::Open),
                created_at: parse_rfc3339(&r.get::<_, String>(6)?),
            }),
        ).optional().map_err(|e| WatcherError::Wallet(e.to_string()))
    }

    pub fn set_tab_state(&self, tab_id: Uuid, state: TabState) -> Result<(), WatcherError> {
        self.conn.lock().unwrap().execute("UPDATE tabs SET state = ?2 WHERE tab_id = ?1", params![tab_id.to_string(), state.as_str()]).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn open_tabs(&self) -> Result<Vec<TabRow>, WatcherError> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT tab_id FROM tabs WHERE state IN ('open','sweeping')").map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let ids: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| WatcherError::Wallet(e.to_string()))?.collect::<Result<_, _>>().map_err(|e| WatcherError::Wallet(e.to_string()))?;
        drop(st); drop(conn);
        ids.iter().filter_map(|s| s.parse().ok()).map(|id| self.get_tab(id)).filter_map(|r| r.transpose()).collect()
    }
}

pub fn rfc3339(t: OffsetDateTime) -> String { t.format(&time::format_description::well_known::Rfc3339).unwrap() }
pub fn parse_rfc3339(s: &str) -> OffsetDateTime { OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).unwrap_or(OffsetDateTime::UNIX_EPOCH) }
```

- [ ] **Step 4: Run, expect 2 passes.**

- [ ] **Step 5: Write the failing WalletStore live test** in `tests/testnet_live.rs`

```rust
#[tokio::test]
#[ignore]
async fn import_tab_account_creates_view_only_account() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let store = ztab_watcher::wallet::WalletStore::open(&cfg).unwrap();
    let account = store.import_tab_account(&mut client, uuid::Uuid::new_v4(), common::FIXTURE_UFVK, common::FIXTURE_BIRTHDAY).await.unwrap();
    use zcash_client_backend::data_api::{Account, WalletRead};
    let db = store.db();
    let acct = db.get_account(account).unwrap().expect("account exists");
    assert!(acct.ufvk().is_some());
    assert_eq!(u32::from(db.get_account_birthday(account).unwrap()), common::FIXTURE_BIRTHDAY);
}
```

- [ ] **Step 6: Implement `wallet.rs`**

```rust
use std::{path::{Path, PathBuf}, sync::{Mutex, MutexGuard}};
use uuid::Uuid;
use zcash_client_backend::{data_api::{chain::ChainState, AccountBirthday, AccountPurpose, WalletWrite}, proto::service};
use zcash_client_sqlite::{chain::init::init_blockmeta_db, wallet::init::init_wallet_db, util::SystemClock, AccountUuid, FsBlockDb, WalletDb};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};
use crate::{config::Config, error::WatcherError, remote::LwdClient, rng::OsRng};

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

pub struct WalletStore {
    network: Network,
    db: Mutex<Db>,
    cache: Mutex<FsBlockDb>,
    blocks_dir: PathBuf,
}

impl WalletStore {
    pub fn open(cfg: &Config) -> Result<Self, WatcherError> {
        std::fs::create_dir_all(&cfg.data_dir).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let blocks_root = cfg.data_dir.clone();
        std::fs::create_dir_all(blocks_root.join("blocks")).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let mut cache = FsBlockDb::for_path(&blocks_root).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        init_blockmeta_db(&mut cache).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        let mut db = WalletDb::for_path(cfg.data_dir.join("wallet.sqlite"), cfg.network, SystemClock, OsRng).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        init_wallet_db(&mut db, None).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        Ok(Self { network: cfg.network, db: Mutex::new(db), cache: Mutex::new(cache), blocks_dir: blocks_root.join("blocks") })
    }

    pub fn network(&self) -> Network { self.network }
    pub fn db(&self) -> MutexGuard<'_, Db> { self.db.lock().unwrap() }
    pub fn cache(&self) -> MutexGuard<'_, FsBlockDb> { self.cache.lock().unwrap() }
    pub fn blocks_dir(&self) -> &Path { &self.blocks_dir }

    pub fn parse_ufvk(&self, ufvk: &str) -> Result<UnifiedFullViewingKey, WatcherError> {
        UnifiedFullViewingKey::decode(&self.network, ufvk).map_err(|e| WatcherError::Unprocessable(format!("ufvk: {e}")))
    }

    /// Builds the birthday from the tree state at `birthday - 1` (mirrors zcash-devtool
    /// `init::get_wallet_birthday`) and imports a view-only account named after the tab.
    pub async fn import_tab_account(&self, client: &mut LwdClient, tab_id: Uuid, ufvk: &str, birthday: u32) -> Result<AccountUuid, WatcherError> {
        let ufvk = self.parse_ufvk(ufvk)?;
        let sapling = self.network.activation_height(NetworkUpgrade::Sapling).expect("sapling height");
        let birthday_height = BlockHeight::from_u32(birthday).max(sapling);
        let tree_state = client.get_tree_state(service::BlockId { height: u64::from(birthday_height) - 1, hash: vec![] }).await
            .map_err(|e| WatcherError::Remote(format!("get_tree_state: {e}")))?.into_inner();
        let chain_state: ChainState = tree_state.to_chain_state().map_err(|e| WatcherError::Remote(format!("tree state: {e}")))?;
        let account_birthday = AccountBirthday::from_parts(chain_state, None);
        let mut db = self.db();
        let (account_id, _ufvk) = db.import_account_ufvk(&tab_id.to_string(), &ufvk, &account_birthday, AccountPurpose::ViewOnly, None)
            .map_err(|e| WatcherError::Wallet(format!("import_account_ufvk: {e:?}")))?;
        Ok(account_id)
    }
}
```

If `import_account_ufvk` returns something other than `(AccountUuid, UnifiedFullViewingKey)` in the pinned crate, adapt to the actual signature in `zcash_client_sqlite-0.23.0-pre.1/src/lib.rs` (search `fn import_account_ufvk`). `AccountUuid` exposes `.expose_uuid()` for storage in `MetaStore`.

- [ ] **Step 7: Run the live test, expect PASS.** Then commit — `git commit -m "watcher: wallet and meta stores, view-only tab account import"`

---

### Task 4: Participant addresses by diversifier index

**Files:**
- Modify: `watcher/src/wallet.rs`

**Interfaces:**
- Produces: `WalletStore::participant_addresses(&self, account: AccountUuid, count: u32) -> Result<Vec<(u32, String)>, WatcherError>` — index `i` ↦ encoded unified address with an Orchard receiver only, stored in the wallet's `addresses` table so received notes get an `address_id`.
- Produces: `WalletStore::index_for_address_id(&self, address_id: i64) -> Result<Option<u32>, WatcherError>` (reads `addresses.diversifier_index_be`).

- [ ] **Step 1: Write the failing live test**

```rust
#[tokio::test]
#[ignore]
async fn participant_addresses_are_deterministic_orchard_only_uas() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let store = ztab_watcher::wallet::WalletStore::open(&cfg).unwrap();
    let account = store.import_tab_account(&mut client, uuid::Uuid::new_v4(), common::FIXTURE_UFVK, common::FIXTURE_BIRTHDAY).await.unwrap();
    let first = store.participant_addresses(account, 3).unwrap();
    let again = store.participant_addresses(account, 3).unwrap();
    assert_eq!(first, again, "addresses must be deterministic per index");
    assert_eq!(first.len(), 3);
    assert!(first.iter().all(|(_, a)| a.starts_with("utest1")));
    assert_ne!(first[0].1, first[1].1);
    // index 0 of the fixture UFVK is the spike wallet's first address
    assert_eq!(first[0].1, "utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp");
}
```

- [ ] **Step 2: Run, expect failure (method missing).**

- [ ] **Step 3: Implement**

```rust
use zcash_keys::keys::{ReceiverRequirement, UnifiedAddressRequest};
use zip32::DiversifierIndex;

impl WalletStore {
    pub fn participant_addresses(&self, account: AccountUuid, count: u32) -> Result<Vec<(u32, String)>, WatcherError> {
        let request = UnifiedAddressRequest::unsafe_custom(ReceiverRequirement::Require, ReceiverRequirement::Omit, ReceiverRequirement::Omit);
        let mut db = self.db();
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let ua = db.get_address_for_index(account, DiversifierIndex::from(i), request)
                .map_err(|e| WatcherError::Wallet(format!("get_address_for_index({i}): {e:?}")))?
                .ok_or_else(|| WatcherError::Wallet(format!("no orchard address at index {i}")))?;
            out.push((i, ua.encode(&self.network)));
        }
        Ok(out)
    }

    pub fn index_for_address_id(&self, address_id: i64) -> Result<Option<u32>, WatcherError> {
        let db = self.db();
        let conn = db.conn();  // rusqlite::Connection behind WalletDb; see note below
        let be: Option<Vec<u8>> = conn.query_row("SELECT diversifier_index_be FROM addresses WHERE id = ?1", [address_id], |r| r.get(0))
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(be.map(|b| { let mut n = [0u8; 11]; n.copy_from_slice(&b[..11]); u32::from_be_bytes([n[7], n[8], n[9], n[10]]) }))
    }
}
```

`UnifiedAddressRequest::unsafe_custom(orchard, sapling, p2pkh)` is the constructor in `zcash_keys 0.17`; if the name differs, use the one in `zcash_keys-0.17.0-pre.1/src/keys.rs` that takes three `ReceiverRequirement`s. For the raw connection, `WalletDb` in `zcash_client_sqlite` exposes the connection through `WalletDb::conn()` only in tests; if it is not public, open a second read-only `rusqlite::Connection` to `wallet.sqlite` inside `WalletStore` (`Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)`) and use it for all raw reads in Task 6 as well. Diversifier index is stored big-endian in 11 bytes; the last 4 bytes hold `i` for `i < 2^32`.

- [ ] **Step 4: Run the live test, expect PASS.** Commit — `git commit -m "watcher: per-participant Orchard-only addresses by diversifier index"`

---

### Task 5: HTTP skeleton, auth, POST /v1/tabs

**Files:**
- Create: `watcher/src/http/mod.rs`, `watcher/src/http/tabs.rs`
- Modify: `watcher/src/lib.rs`, `watcher/src/main.rs`

**Interfaces:**
- Produces: `AppState { cfg: Arc<Config>, wallet: Arc<WalletStore>, meta: Arc<MetaStore>, client: Arc<tokio::sync::Mutex<LwdClient>>, health: Arc<HealthState> }` where `HealthState { tip_height: AtomicU32, synced_height: AtomicU32, mempool_subscribed: AtomicBool, last_ok_at: Mutex<Option<OffsetDateTime>> }`; `pub fn router(state: AppState) -> axum::Router`.
- `POST /v1/tabs` body `RegisterTab { tab_id: Uuid, ufvk: String, birthday: u32, participants_count: u32 }` → `201 { tab_id, addresses: [{ index, address }] }`; idempotent for same `(tab_id, ufvk)`; `409` for same `tab_id` with a different `ufvk`; `422` if `participants_count` is 0 or > 64, if `ufvk` does not parse, or if `birthday < tip − 1000`.

- [ ] **Step 1: Write failing router tests** in `src/http/tabs.rs` (unit, no network: use a `MetaStore` and a fake `WalletStore`? No — `WalletStore` needs no network to open, only `import_tab_account` does. Make `import` injectable: `tabs::register` calls `state.register_tab(...)`, and the unit test exercises validation paths that fail before any network call.)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_rejects_bad_counts() {
        assert!(validate_register(&RegisterTab { tab_id: uuid::Uuid::new_v4(), ufvk: "u".into(), birthday: 1, participants_count: 0 }, 5000).is_err());
        assert!(validate_register(&RegisterTab { tab_id: uuid::Uuid::new_v4(), ufvk: "u".into(), birthday: 1, participants_count: 65 }, 5000).is_err());
    }
    #[test]
    fn validate_rejects_old_birthday() {
        let r = RegisterTab { tab_id: uuid::Uuid::new_v4(), ufvk: "u".into(), birthday: 1000, participants_count: 2 };
        assert!(matches!(validate_register(&r, 5000), Err(WatcherError::Unprocessable(_))));
        assert!(validate_register(&RegisterTab { birthday: 4500, ..r }, 5000).is_ok());
    }
}
```

- [ ] **Step 2: Run, expect compile failure.**

- [ ] **Step 3: Implement `http/mod.rs` and `http/tabs.rs`**

```rust
// src/http/mod.rs
pub mod tabs;
use std::sync::{atomic::{AtomicBool, AtomicU32}, Arc};
use axum::{extract::{Request, State}, http::{header, StatusCode}, middleware::{self, Next}, response::Response, routing::{get, post}, Router};
use tokio::sync::Mutex as AsyncMutex;
use crate::{config::Config, meta::MetaStore, remote::LwdClient, wallet::WalletStore};

#[derive(Default)]
pub struct HealthState {
    pub tip_height: AtomicU32,
    pub synced_height: AtomicU32,
    pub mempool_subscribed: AtomicBool,
    pub last_ok_at: std::sync::Mutex<Option<time::OffsetDateTime>>,
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub wallet: Arc<WalletStore>,
    pub meta: Arc<MetaStore>,
    pub client: Arc<AsyncMutex<LwdClient>>,
    pub health: Arc<HealthState>,
}

async fn auth(State(state): State<AppState>, req: Request, next: Next) -> Result<Response, StatusCode> {
    if req.uri().path() == "/v1/health" { return Ok(next.run(req).await); }
    let expected = format!("Bearer {}", state.cfg.api_token);
    match req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        Some(v) if v == expected => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/tabs", post(tabs::register))
        .route("/v1/tabs/{tab_id}", get(tabs::get_tab))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
```

```rust
// src/http/tabs.rs
use axum::{extract::{Path, State}, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::{error::WatcherError, meta::{TabRow, TabState}, remote};
use super::AppState;

#[derive(Deserialize)]
pub struct RegisterTab { pub tab_id: Uuid, pub ufvk: String, pub birthday: u32, pub participants_count: u32 }

#[derive(Serialize)]
pub struct AddressOut { pub index: u32, pub address: String }

#[derive(Serialize)]
pub struct RegisterOut { pub tab_id: Uuid, pub addresses: Vec<AddressOut> }

pub fn validate_register(r: &RegisterTab, tip: u32) -> Result<(), WatcherError> {
    if r.participants_count == 0 || r.participants_count > 64 {
        return Err(WatcherError::Unprocessable("participants_count must be 1..=64".into()));
    }
    if r.birthday + 1000 < tip {
        return Err(WatcherError::Unprocessable(format!("birthday {} is older than tip-1000 ({})", r.birthday, tip.saturating_sub(1000))));
    }
    Ok(())
}

pub async fn register(State(state): State<AppState>, Json(body): Json<RegisterTab>) -> Result<(StatusCode, Json<RegisterOut>), WatcherError> {
    if let Some(existing) = state.meta.get_tab(body.tab_id)? {
        if existing.ufvk != body.ufvk { return Err(WatcherError::Conflict("tab_id already registered with a different ufvk".into())); }
        let account = crate::wallet::account_uuid(existing.account_uuid);
        let addresses = state.wallet.participant_addresses(account, existing.participants_count)?;
        return Ok((StatusCode::CREATED, Json(RegisterOut { tab_id: body.tab_id, addresses: addresses.into_iter().map(|(index, address)| AddressOut { index, address }).collect() })));
    }
    state.wallet.parse_ufvk(&body.ufvk)?;
    let mut client = state.client.lock().await;
    let (tip, _) = remote::latest_height(&mut client).await?;
    validate_register(&body, u32::from(tip))?;
    let account = state.wallet.import_tab_account(&mut client, body.tab_id, &body.ufvk, body.birthday).await?;
    drop(client);
    state.meta.insert_tab(&TabRow {
        tab_id: body.tab_id, account_uuid: account.expose_uuid(), ufvk: body.ufvk.clone(), birthday: body.birthday,
        participants_count: body.participants_count, state: TabState::Open, created_at: time::OffsetDateTime::now_utc(),
    })?;
    let addresses = state.wallet.participant_addresses(account, body.participants_count)?;
    tracing::info!(tab = %body.tab_id, participants = body.participants_count, "tab registered");
    Ok((StatusCode::CREATED, Json(RegisterOut { tab_id: body.tab_id, addresses: addresses.into_iter().map(|(index, address)| AddressOut { index, address }).collect() })))
}

pub async fn get_tab(State(_state): State<AppState>, Path(_tab_id): Path<Uuid>) -> Result<Json<serde_json::Value>, WatcherError> {
    Err(WatcherError::NotFound("implemented in Task 6".into()))
}
```

Add to `wallet.rs`: `pub fn account_uuid(u: Uuid) -> AccountUuid { AccountUuid::from_uuid(u) }`.

- [ ] **Step 4: Wire `main.rs`**

```rust
#![forbid(unsafe_code)]
use std::sync::Arc;
use ztab_watcher::{config::Config, http::{router, AppState, HealthState}, meta::MetaStore, remote, wallet::WalletStore};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let cfg = Arc::new(Config::from_env()?);
    let wallet = Arc::new(WalletStore::open(&cfg)?);
    let meta = Arc::new(MetaStore::open(&cfg)?);
    let client = Arc::new(tokio::sync::Mutex::new(remote::connect(&cfg).await?));
    let state = AppState { cfg: cfg.clone(), wallet, meta, client, health: Arc::new(HealthState::default()) };
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    tracing::info!(listen = %cfg.listen, "ztab-watcher listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
```

- [ ] **Step 5: Add the live register test** to `tests/testnet_live.rs` (spawn the router on an ephemeral port with `axum::serve`, call it with `reqwest`): register once → `201` with 3 `utest1` addresses; register again with same body → `201` and identical addresses; register same `tab_id` with a different `ufvk` (change one character after the HRP) → `409`; `participants_count: 0` → `422`; no `Authorization` header → `401`. Name the ufvk-change test `register_rejects_ufvk_change`.

- [ ] **Step 6: Run unit + live tests, expect PASS.** Commit — `git commit -m "watcher: HTTP router with bearer auth, POST /v1/tabs"`

---

### Task 6: Payment facts and GET /v1/tabs/{id}

**Files:**
- Create: `watcher/src/facts.rs`
- Modify: `watcher/src/http/tabs.rs`, `watcher/src/meta.rs` (sightings read)

**Interfaces:**
- Produces: `facts::tab_facts(wallet: &WalletStore, meta: &MetaStore, cfg: &Config, tab: &TabRow, tip: u32) -> Result<TabFacts, WatcherError>` with
  ```rust
  pub struct Payment { pub txid: String, pub value_zat: u64, pub mined_height: Option<u32>, pub confirmations: u32, pub transparent_source: bool, pub first_seen_at: String }
  pub struct StatusFacts { pub confirmed_zat: u64, pub mempool_zat: u64, pub best_confirmations: u32, pub transparent_source: bool }
  pub struct ParticipantFacts { pub index: u32, pub address: String, pub payments: Vec<Payment>, pub status_facts: StatusFacts }
  pub struct TabFacts { pub tab_id: Uuid, pub state: TabState, pub synced_height: u32, pub tip_height: u32, pub stale: bool, pub participants: Vec<ParticipantFacts> }
  ```
- `MetaStore::sightings_for_tab(&self, tab_id: Uuid) -> Result<Vec<Sighting>, WatcherError>`, `Sighting { txid: String, participant_index: u32, value_zat: u64, first_seen_at: String }`; `MetaStore::upsert_sighting(&self, s: &Sighting, tab_id: Uuid)`; `MetaStore::transparent_source(&self, txid: &str) -> Result<Option<bool>, WatcherError>` and `set_transparent_source(txid, bool)` backed by a new table `tx_sources (txid TEXT PRIMARY KEY, transparent_source INTEGER NOT NULL)` added to `SCHEMA`.

- [ ] **Step 1: Write the failing unit test for the fact aggregation** (pure function over rows, no DB):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn row(idx: u32, value: u64, mined: Option<u32>, txid: &str) -> NoteRow { NoteRow { participant_index: idx, value_zat: value, mined_height: mined, txid: txid.into() } }

    #[test]
    fn aggregates_confirmed_and_mempool_separately() {
        let notes = vec![row(0, 100, Some(90), "aa"), row(0, 50, None, "bb"), row(1, 70, Some(99), "cc")];
        let sightings = vec![Sighting { txid: "dd".into(), participant_index: 1, value_zat: 30, first_seen_at: "t".into() }];
        let facts = aggregate(2, &notes, &sightings, &Default::default(), 100);
        let p0 = &facts[0]; let p1 = &facts[1];
        assert_eq!(p0.status_facts.confirmed_zat, 100);   // mined at 90, tip 100 -> 11 confs
        assert_eq!(p0.status_facts.mempool_zat, 50);      // wallet knows tx bb but unmined
        assert_eq!(p0.status_facts.best_confirmations, 11);
        assert_eq!(p1.status_facts.confirmed_zat, 70);
        assert_eq!(p1.status_facts.mempool_zat, 30);      // from sightings only
        assert_eq!(p1.status_facts.best_confirmations, 2);
    }

    #[test]
    fn mempool_sighting_is_dropped_once_the_note_is_mined() {
        let notes = vec![row(0, 100, Some(90), "aa")];
        let sightings = vec![Sighting { txid: "aa".into(), participant_index: 0, value_zat: 100, first_seen_at: "t".into() }];
        let facts = aggregate(1, &notes, &sightings, &Default::default(), 100);
        assert_eq!(facts[0].status_facts.mempool_zat, 0);
        assert_eq!(facts[0].payments.len(), 1);
    }

    #[test]
    fn transparent_source_flag_propagates() {
        let notes = vec![row(0, 100, Some(90), "aa")];
        let mut sources = std::collections::HashMap::new(); sources.insert("aa".to_string(), true);
        let facts = aggregate(1, &notes, &[], &sources, 100);
        assert!(facts[0].status_facts.transparent_source);
        assert!(facts[0].payments[0].transparent_source);
    }
}
```

- [ ] **Step 2: Run, expect compile failure.**

- [ ] **Step 3: Implement `facts.rs`**

```rust
use std::collections::HashMap;
use serde::Serialize;
use uuid::Uuid;
use crate::{config::Config, error::WatcherError, meta::{MetaStore, Sighting, TabRow, TabState}, wallet::WalletStore};

#[derive(Serialize, Clone, Debug)] pub struct Payment { pub txid: String, pub value_zat: u64, pub mined_height: Option<u32>, pub confirmations: u32, pub transparent_source: bool, pub first_seen_at: String }
#[derive(Serialize, Clone, Debug, Default)] pub struct StatusFacts { pub confirmed_zat: u64, pub mempool_zat: u64, pub best_confirmations: u32, pub transparent_source: bool }
#[derive(Serialize, Clone, Debug)] pub struct ParticipantFacts { pub index: u32, pub address: String, pub payments: Vec<Payment>, pub status_facts: StatusFacts }
#[derive(Serialize, Clone, Debug)] pub struct TabFacts { pub tab_id: Uuid, pub state: TabState, pub synced_height: u32, pub tip_height: u32, pub stale: bool, pub participants: Vec<ParticipantFacts> }

/// One received note of the tab's account, joined with its transaction and address.
pub struct NoteRow { pub participant_index: u32, pub value_zat: u64, pub mined_height: Option<u32>, pub txid: String }

pub fn aggregate(count: u32, notes: &[NoteRow], sightings: &[Sighting], sources: &HashMap<String, bool>, tip: u32) -> Vec<ParticipantFacts> {
    (0..count).map(|i| {
        let mut payments = Vec::new();
        let mut sf = StatusFacts::default();
        let mut known_txids = std::collections::HashSet::new();
        for n in notes.iter().filter(|n| n.participant_index == i) {
            known_txids.insert(n.txid.clone());
            let ts = sources.get(&n.txid).copied().unwrap_or(false);
            let confirmations = n.mined_height.map_or(0, |h| tip.saturating_sub(h) + 1);
            match n.mined_height {
                Some(_) => { sf.confirmed_zat += n.value_zat; sf.best_confirmations = sf.best_confirmations.max(confirmations); sf.transparent_source |= ts; }
                None => { sf.mempool_zat += n.value_zat; }
            }
            payments.push(Payment { txid: n.txid.clone(), value_zat: n.value_zat, mined_height: n.mined_height, confirmations, transparent_source: ts, first_seen_at: String::new() });
        }
        for s in sightings.iter().filter(|s| s.participant_index == i && !known_txids.contains(&s.txid)) {
            sf.mempool_zat += s.value_zat;
            payments.push(Payment { txid: s.txid.clone(), value_zat: s.value_zat, mined_height: None, confirmations: 0, transparent_source: false, first_seen_at: s.first_seen_at.clone() });
        }
        ParticipantFacts { index: i, address: String::new(), payments, status_facts: sf }
    }).collect()
}

/// Reads this tab's received notes straight from the wallet database.
/// Pools: 3 = Orchard, 4 = Ironwood (we accept both; after NU6.3 only Ironwood arrives).
pub fn note_rows(wallet: &WalletStore, account_uuid: Uuid) -> Result<Vec<NoteRow>, WatcherError> {
    let conn = wallet.read_conn();
    let mut st = conn.prepare(
        "SELECT a.diversifier_index_be, r.value, t.mined_height, t.txid
           FROM v_received_outputs r
           JOIN accounts acc ON acc.id = r.account_id
           JOIN transactions t ON t.id_tx = r.transaction_id
           JOIN addresses a ON a.id = r.address_id
          WHERE acc.uuid = ?1 AND r.pool IN (3, 4) AND r.is_change = 0",
    ).map_err(|e| WatcherError::Wallet(e.to_string()))?;
    let rows = st.query_map([account_uuid.as_bytes().to_vec()], |r| {
        let be: Vec<u8> = r.get(0)?; let value: i64 = r.get(1)?; let mined: Option<i64> = r.get(2)?; let txid: Vec<u8> = r.get(3)?;
        let idx = u32::from_be_bytes([be[7], be[8], be[9], be[10]]);
        let mut t = txid.clone(); t.reverse();
        Ok(NoteRow { participant_index: idx, value_zat: value as u64, mined_height: mined.map(|m| m as u32), txid: hex::encode(t) })
    }).map_err(|e| WatcherError::Wallet(e.to_string()))?;
    rows.collect::<Result<_, _>>().map_err(|e| WatcherError::Wallet(e.to_string()))
}

pub fn tab_facts(wallet: &WalletStore, meta: &MetaStore, _cfg: &Config, tab: &TabRow, tip: u32, synced: u32, stale: bool) -> Result<TabFacts, WatcherError> {
    let notes = note_rows(wallet, tab.account_uuid)?;
    let sightings = meta.sightings_for_tab(tab.tab_id)?;
    let sources = meta.transparent_sources(notes.iter().map(|n| n.txid.as_str()))?;
    let addresses = wallet.participant_addresses(crate::wallet::account_uuid(tab.account_uuid), tab.participants_count)?;
    let mut participants = aggregate(tab.participants_count, &notes, &sightings, &sources, tip);
    for (p, (_, addr)) in participants.iter_mut().zip(addresses) { p.address = addr; }
    Ok(TabFacts { tab_id: tab.tab_id, state: tab.state, synced_height: synced, tip_height: tip, stale, participants })
}
```

`WalletStore::read_conn()` is the read-only `rusqlite::Connection` to `wallet.sqlite` introduced in Task 4's note (`OpenFlags::SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` is fine; WAL mode lets readers coexist with the writer). `accounts.uuid` is stored as a 16-byte BLOB; verify with `sqlite3 wallet.sqlite 'select typeof(uuid) from accounts'` on the Task 3 test database and adjust the parameter to `account_uuid.to_string()` if it is TEXT. `transactions.txid` is stored in internal byte order; the hex txid shown to users is the byte-reversed form, hence the `reverse()`.

- [ ] **Step 4: Implement `get_tab`** in `http/tabs.rs`:

```rust
pub async fn get_tab(State(state): State<AppState>, Path(tab_id): Path<Uuid>) -> Result<Json<crate::facts::TabFacts>, WatcherError> {
    let tab = state.meta.get_tab(tab_id)?.ok_or_else(|| WatcherError::NotFound(format!("tab {tab_id}")))?;
    let tip = state.health.tip_height.load(std::sync::atomic::Ordering::Relaxed);
    let synced = state.health.synced_height.load(std::sync::atomic::Ordering::Relaxed);
    let stale = state.health.last_ok_at.lock().unwrap().map_or(true, |t| (time::OffsetDateTime::now_utc() - t).whole_seconds() > 3 * state.cfg.block_interval_seconds as i64);
    Ok(Json(crate::facts::tab_facts(&state.wallet, &state.meta, &state.cfg, &tab, tip, synced, stale)?))
}
```

- [ ] **Step 5: Add `sightings_for_tab`, `upsert_sighting`, `transparent_sources`, `set_transparent_source` to `meta.rs`** with the `tx_sources` table in `SCHEMA` (straightforward `INSERT OR REPLACE` / `SELECT`; `transparent_sources` takes an iterator of txids and returns a `HashMap<String, bool>` of the ones it knows).

- [ ] **Step 6: Run unit tests, expect PASS; add a live test** `get_tab_returns_empty_facts_for_fresh_tab` (register → GET → 200, every participant has `confirmed_zat == 0`, `stale == true` because no loop has run yet). Commit — `git commit -m "watcher: payment facts from wallet db and mempool sightings, GET /v1/tabs/{id}"`

---

### Task 7: SyncLoop (blocks, subtree roots, chain tip, reorg rewind)

**Files:**
- Create: `watcher/src/sync.rs`
- Modify: `watcher/src/main.rs` (spawn), `watcher/src/http/mod.rs` (health updates)

**Interfaces:**
- Produces: `pub async fn run_sync_loop(state: AppState) -> !` — every `block_interval_seconds / 2` seconds (min 5 s) runs one `sync_once(&state).await`; on error logs and backs off exponentially up to 60 s. `pub async fn sync_once(state: &AppState) -> Result<SyncReport, WatcherError>` with `SyncReport { tip: u32, scanned_to: u32, rewound_to: Option<u32> }`; updates `health.tip_height`, `health.synced_height`, `health.last_ok_at`.
- Produces: `pub async fn refresh_transparent_sources(state: &AppState, txids: &[String]) -> Result<(), WatcherError>` — for each mined note txid without a `tx_sources` row, `GetTransaction`, parse with `Transaction::read(&raw.data[..], BranchId::for_height(&network, height))`, set `transparent_source = !tx.transparent_bundle().map_or(true, |b| b.vin.is_empty())`.

- [ ] **Step 1: Write the failing live test** (`tests/testnet_live.rs`)

```rust
#[tokio::test]
#[ignore]
async fn sync_once_scans_fixture_tab_to_tip_and_finds_its_notes() {
    let (state, _server) = common::spawn_state_and_server().await;   // helper: builds AppState on temp dirs, serves router on an ephemeral port
    let tab_id = common::register_fixture_tab(&state, 2).await;         // helper: POST /v1/tabs with FIXTURE_UFVK/BIRTHDAY
    let report = ztab_watcher::sync::sync_once(&state).await.unwrap();
    assert!(report.scanned_to >= report.tip - 2);
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let facts = ztab_watcher::facts::tab_facts(&state.wallet, &state.meta, &state.cfg, &tab, report.tip, report.scanned_to, false).unwrap();
    // The fixture wallet received the spike's payments at diversifier index 0 and 1.
    assert!(facts.participants[0].status_facts.confirmed_zat > 0);
    assert!(facts.participants[1].status_facts.confirmed_zat > 0);
    assert!(facts.participants[0].status_facts.best_confirmations >= 10);
}

#[tokio::test]
#[ignore]
async fn reorg_truncate_clears_confirmed_facts() {
    let (state, _server) = common::spawn_state_and_server().await;
    let tab_id = common::register_fixture_tab(&state, 2).await;
    let report = ztab_watcher::sync::sync_once(&state).await.unwrap();
    { use zcash_client_backend::data_api::WalletWrite; let mut db = state.wallet.db();
      db.truncate_to_height(zcash_protocol::consensus::BlockHeight::from_u32(common::FIXTURE_BIRTHDAY)).unwrap(); }
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let facts = ztab_watcher::facts::tab_facts(&state.wallet, &state.meta, &state.cfg, &tab, report.tip, common::FIXTURE_BIRTHDAY, false).unwrap();
    assert_eq!(facts.participants[0].status_facts.confirmed_zat, 0, "truncated notes must not count as confirmed");
    let report2 = ztab_watcher::sync::sync_once(&state).await.unwrap();
    let facts2 = ztab_watcher::facts::tab_facts(&state.wallet, &state.meta, &state.cfg, &tab, report2.tip, report2.scanned_to, false).unwrap();
    assert!(facts2.participants[0].status_facts.confirmed_zat > 0, "rescan restores them");
}
```

Add the two helpers to `tests/common/mod.rs` (`spawn_state_and_server` builds `AppState` exactly like `main.rs` but on a `tempdir`, binds `127.0.0.1:0`, spawns `axum::serve`, returns the state and the bound address; `register_fixture_tab` POSTs with `reqwest`).

- [ ] **Step 2: Run, expect failure (module missing).**

- [ ] **Step 3: Implement `sync.rs`** — a port of zcash-devtool `commands/wallet/sync.rs` without the TUI. Required pieces, in order inside `sync_once`:

```rust
use std::{sync::atomic::Ordering, time::Duration};
use futures_util::TryStreamExt;
use prost::Message;
use tokio::io::AsyncWriteExt;
use zcash_client_backend::{
    data_api::{chain::{error::Error as ChainError, scan_cached_blocks, ChainState, CommitmentTreeRoot}, scanning::{ScanPriority, ScanRange}, WalletCommitmentTrees, WalletRead, WalletWrite},
    proto::service::{self, BlockId},
};
use zcash_client_sqlite::chain::BlockMeta;
use zcash_protocol::consensus::BlockHeight;
use crate::{error::WatcherError, http::AppState, remote};

const BATCH_SIZE: u32 = 1_000;
const REORG_REWIND_MARGIN: u32 = 10;

pub struct SyncReport { pub tip: u32, pub scanned_to: u32, pub rewound_to: Option<u32> }

pub async fn run_sync_loop(state: AppState) -> ! {
    let base = Duration::from_secs((state.cfg.block_interval_seconds / 2).max(5));
    let mut backoff = base;
    loop {
        match sync_once(&state).await {
            Ok(r) => { tracing::debug!(tip = r.tip, scanned_to = r.scanned_to, "sync ok"); backoff = base; }
            Err(e) => { tracing::warn!(error = %e, "sync failed"); backoff = (backoff * 2).min(Duration::from_secs(60)); }
        }
        tokio::time::sleep(backoff).await;
    }
}

pub async fn sync_once(state: &AppState) -> Result<SyncReport, WatcherError> {
    let mut client = state.client.lock().await;
    update_subtree_roots(&mut client, state).await?;
    let (tip, _tip_hash) = remote::latest_height(&mut client).await?;
    { state.wallet.db().update_chain_tip(tip).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?; }
    state.health.tip_height.store(u32::from(tip), Ordering::Relaxed);

    let mut rewound_to = None;
    // Loop until no scan range is left; `scan_range_batch` returns true when ranges changed.
    loop {
        let ranges = state.wallet.db().suggest_scan_ranges().map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        let Some(range) = ranges.into_iter().next() else { break };
        // Limit each batch to BATCH_SIZE blocks.
        let range = range.truncate_end(range.block_range().start + BATCH_SIZE).unwrap_or(range);
        let metas = download_blocks(&mut client, state, &range).await?;
        let chain_state = download_chain_state(&mut client, range.block_range().start - 1).await?;
        match scan_batch(state, &chain_state, &range, tip)? {
            ScanOutcome::Rewound(h) => { rewound_to = Some(u32::from(h)); }
            ScanOutcome::Done => {}
        }
        delete_cached_blocks(state, &metas);
    }
    let scanned_to = state.wallet.db().block_max_scanned().map_err(|e| WatcherError::Wallet(format!("{e:?}")))?.map_or(0, |m| u32::from(m.block_height()));
    state.health.synced_height.store(scanned_to, Ordering::Relaxed);
    *state.health.last_ok_at.lock().unwrap() = Some(time::OffsetDateTime::now_utc());
    drop(client);
    refresh_transparent_sources_for_open_tabs(state).await?;
    Ok(SyncReport { tip: u32::from(tip), scanned_to, rewound_to })
}

enum ScanOutcome { Done, Rewound(BlockHeight) }

fn scan_batch(state: &AppState, chain_state: &ChainState, range: &ScanRange, tip: BlockHeight) -> Result<ScanOutcome, WatcherError> {
    let network = state.wallet.network();
    let cache = state.wallet.cache();
    let mut db = state.wallet.db();
    match scan_cached_blocks(&network, &*cache, &mut *db, range.block_range().start, chain_state, range.len()) {
        Ok(_) => Ok(ScanOutcome::Done),
        Err(ChainError::Scan(err)) if err.is_continuity_error() => {
            let requested = err.at_height().saturating_sub(REORG_REWIND_MARGIN);
            let rewound = db.truncate_to_height(requested).map_err(|e| WatcherError::Wallet(format!("truncate: {e:?}")))?;
            cache.truncate_to_height(rewound).map_err(|e| WatcherError::Wallet(format!("cache truncate: {e:?}")))?;
            db.update_chain_tip(tip).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
            tracing::warn!(at = u32::from(err.at_height()), rewound_to = u32::from(rewound), "reorg: rewound wallet");
            Ok(ScanOutcome::Rewound(rewound))
        }
        Err(e) => Err(WatcherError::Wallet(format!("scan: {e:?}"))),
    }
}
```

`update_subtree_roots`, `download_blocks`, `download_chain_state`, `delete_cached_blocks` are the devtool functions verbatim (they are in the session's spike clone and in zcash-devtool `main`; copy them, replacing `anyhow` with `WatcherError::Remote`/`Wallet` and `fsblockdb_root` with `state.wallet.blocks_dir().parent()`). `ScanRange::truncate_end` exists in `zcash_client_backend::data_api::scanning`; if the pinned version lacks it, use `split_at(start + BATCH_SIZE)` as devtool does. `WalletRead::block_max_scanned` returns `Option<BlockMetadata>`.

`refresh_transparent_sources_for_open_tabs`: for every open tab, `facts::note_rows`, collect mined txids without a `tx_sources` row, `GetTransaction` each (`service::TxFilter { hash: txid_bytes_internal_order, ..Default::default() }`), parse, store the flag.

- [ ] **Step 4: Spawn the loop in `main.rs`** — `tokio::spawn(ztab_watcher::sync::run_sync_loop(state.clone()));` before `axum::serve`.

- [ ] **Step 5: Run the two live tests, expect PASS.** The first sync of the fixture tab scans ~133+ blocks; budget 30 s. Commit — `git commit -m "watcher: block sync loop with subtree roots, reorg rewind and transparent-source detection"`

---

### Task 8: MempoolLoop

**Files:**
- Create: `watcher/src/mempool.rs`
- Modify: `watcher/src/main.rs` (spawn)

**Interfaces:**
- Produces: `pub async fn run_mempool_loop(state: AppState) -> !`; `pub async fn mempool_pass(state: &AppState) -> Result<MempoolPass, WatcherError>` where one pass = subscribe to `GetMempoolStream`, process every `RawTransaction` until the stream ends (new block), return `MempoolPass { seen: usize, matched: usize }`; `pub fn record_sightings(state: &AppState, raw: &[u8], now: OffsetDateTime) -> Result<usize, WatcherError>` (pure function from raw tx bytes to sightings; unit-testable with a canned transaction).

- [ ] **Step 1: Write the failing unit test** with a canned raw transaction: take `raw` of the spike's funding tx `f129d39e…` (the live test harness can fetch and save it to `tests/fixtures/f129d39e.rawtx` once; commit the file, ~9 KB). The test: register the fixture tab in a temp `AppState` without network (construct `AppState` with a client connected lazily — add `common::offline_state()` that builds `AppState` with `client` pointing at `http://127.0.0.1:1` which is never dialed because tests here call only `record_sightings`), then:

```rust
#[tokio::test]
async fn record_sightings_attributes_note_to_participant_index() {
    let state = common::offline_state().await;
    // import_tab_account needs tree state; use a saved ChainState fixture instead:
    common::import_fixture_tab_offline(&state, 2).await;   // helper: AccountBirthday from tests/fixtures/birthday_treestate.bin
    let raw = std::fs::read("tests/fixtures/f129d39e.rawtx").unwrap();
    let n = ztab_watcher::mempool::record_sightings(&state, &raw, time::OffsetDateTime::now_utc()).unwrap();
    assert_eq!(n, 1);
    let s = state.meta.sightings_for_tab(common::fixture_tab_id()).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].participant_index, 0);
    assert_eq!(s[0].value_zat, 30_000_000);
}
```

`import_fixture_tab_offline` serializes the `TreeState` protobuf returned by `GetTreeState(birthday−1)` into `tests/fixtures/birthday_treestate.bin` the first time it runs online (guard with `if !exists { fetch; save }`), then decodes it with `prost::Message::decode` and calls `WalletStore::import_tab_account_from_chain_state(tab_id, ufvk, ChainState)` — add that lower-level method to `WalletStore` (Task 3's `import_tab_account` becomes a thin wrapper over it).

- [ ] **Step 2: Run, expect compile failure.**

- [ ] **Step 3: Implement `mempool.rs`**

```rust
use std::{collections::HashMap, time::Duration};
use futures_util::StreamExt;
use time::OffsetDateTime;
use zcash_client_backend::{data_api::{Account, WalletRead}, decrypt_transaction, proto::service, wallet::Note};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Parameters};
use zcash_client_sqlite::AccountUuid;
use crate::{error::WatcherError, http::AppState, meta::Sighting};

pub struct MempoolPass { pub seen: usize, pub matched: usize }

pub async fn run_mempool_loop(state: AppState) -> ! {
    let mut backoff = Duration::from_secs(1);
    loop {
        match mempool_pass(&state).await {
            Ok(p) => { tracing::debug!(seen = p.seen, matched = p.matched, "mempool pass ended (new block)"); backoff = Duration::from_secs(1); }
            Err(e) => { tracing::warn!(error = %e, "mempool stream failed"); state.health.mempool_subscribed.store(false, std::sync::atomic::Ordering::Relaxed); backoff = (backoff * 2).min(Duration::from_secs(60)); tokio::time::sleep(backoff).await; }
        }
    }
}

pub async fn mempool_pass(state: &AppState) -> Result<MempoolPass, WatcherError> {
    // Own connection: the shared client is held by sync/sweep for seconds at a time.
    let mut client = crate::remote::connect(&state.cfg).await?;
    let mut stream = client.get_mempool_stream(service::Empty {}).await.map_err(|e| WatcherError::Remote(e.to_string()))?.into_inner();
    state.health.mempool_subscribed.store(true, std::sync::atomic::Ordering::Relaxed);
    let (mut seen, mut matched) = (0, 0);
    while let Some(item) = stream.next().await {
        let raw = item.map_err(|e| WatcherError::Remote(e.to_string()))?;
        seen += 1;
        matched += record_sightings(state, &raw.data, OffsetDateTime::now_utc())?;
    }
    state.health.mempool_subscribed.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(MempoolPass { seen, matched })
}

/// Trial-decrypts `raw` with every open tab's UFVK; stores one sighting per matched output.
pub fn record_sightings(state: &AppState, raw: &[u8], now: OffsetDateTime) -> Result<usize, WatcherError> {
    let network = state.wallet.network();
    let tip = BlockHeight::from_u32(state.health.tip_height.load(std::sync::atomic::Ordering::Relaxed).max(1));
    let tx = Transaction::read(raw, BranchId::for_height(&network, tip)).map_err(|e| WatcherError::Unprocessable(format!("tx parse: {e}")))?;
    let open = state.meta.open_tabs()?;
    let mut ufvks = HashMap::new();
    let mut by_account = HashMap::new();
    {
        let db = state.wallet.db();
        for tab in &open {
            let acct = AccountUuid::from_uuid(tab.account_uuid);
            if let Some(a) = db.get_account(acct).map_err(|e| WatcherError::Wallet(format!("{e:?}")))? {
                if let Some(ufvk) = a.ufvk() { ufvks.insert(acct, ufvk.clone()); by_account.insert(acct, tab.clone()); }
            }
        }
    }
    let decrypted = decrypt_transaction(&network, None, Some(tip), &tx, &ufvks);
    let mut count = 0;
    let txid = tx.txid().to_string();
    for out in decrypted.orchard_outputs().iter().chain(decrypted.ironwood_outputs().iter()) {
        let tab = &by_account[out.account()];
        let recipient = out.note().recipient();
        let index = state.wallet.index_for_orchard_address(AccountUuid::from_uuid(tab.account_uuid), &recipient)?;
        let Some(index) = index else { continue };
        state.meta.upsert_sighting(&Sighting { txid: txid.clone(), participant_index: index, value_zat: out.note().value().inner(), first_seen_at: crate::meta::rfc3339(now) }, tab.tab_id)?;
        count += 1;
    }
    Ok(count)
}
```

`DecryptedTransaction` accessor names (`orchard_outputs`, `ironwood_outputs`) must be checked in `zcash_client_backend-0.25.0-pre.1/src/decrypt.rs`; the Ironwood bundle is decrypted "under the Ironwood note-encryption domain" per the 0.24 changelog. `WalletStore::index_for_orchard_address(account, &orchard::Address)` compares the note's recipient with the diversified addresses of indices `0..participants_count` (cache the `orchard::Address` per index in a `HashMap<(AccountUuid, u32), orchard::Address>` filled by `participant_addresses`). Memos are never stored.

- [ ] **Step 4: Live test `mempool_loop_resubscribes_after_stream_end`**: call `mempool_pass` twice in a row against testnet; both must return `Ok` (the first returns when a block arrives, within ~1 min); assert `health.mempool_subscribed` flips to `true` during a pass (spawn the pass, poll the atomic for 5 s).

- [ ] **Step 5: Spawn in `main.rs`; run unit + live tests, expect PASS.** Commit — `git commit -m "watcher: mempool stream loop with trial decryption and sightings"`

---

### Task 9: SweepService and sweep endpoints

**Files:**
- Create: `watcher/src/sweep.rs`, `watcher/src/http/sweep.rs`
- Modify: `watcher/src/http/mod.rs` (routes), `watcher/src/meta.rs` (sweeps table helpers)

**Interfaces:**
- Produces: `sweep::create_proved_pczt(state: &AppState, tab: &TabRow, recipient: &str, memo: Option<&str>) -> Result<SweepOffer, WatcherError>` with `SweepOffer { pczt_b64: String, summary: SweepSummary }`, `SweepSummary { inputs_zat: u64, output_zat: u64, fee_zat: u64, expiry_height: u32, txid: String }`; `sweep::broadcast_signed(state: &AppState, tab: &TabRow, pczt_b64: &str) -> Result<String, WatcherError>` (returns txid); `sweep::sweep_status(state, tab) -> Result<SweepStatus, WatcherError>` with `SweepStatus { state: TabState, txid: Option<String>, mined_height: Option<u32>, confirmations: u32 }`.
- HTTP: `POST /v1/tabs/{id}/sweep {recipient_address, memo?}` → `200 SweepOffer`; `POST /v1/tabs/{id}/broadcast {pczt_b64}` → `200 {txid}`; `GET /v1/tabs/{id}/sweep` → `SweepStatus`.
- `MetaStore::put_sweep(tab_id, txid, pczt_b64, expiry_height)`, `get_sweep(tab_id) -> Option<SweepRow>`, `mark_broadcast(tab_id)`.

- [ ] **Step 1: Write the failing unit test for PCZT matching** in `src/sweep.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_pczt_must_match_offered_txid() {
        let proved = std::fs::read("tests/fixtures/sweep.proved.pczt").unwrap();   // from the spike (already spent on testnet, harmless)
        let signed = std::fs::read("tests/fixtures/sweep.signed.pczt").unwrap();
        let other = std::fs::read("tests/fixtures/sweep2.proved.pczt").unwrap();
        let offered = pczt_txid(&proved).unwrap();
        assert_eq!(pczt_txid(&signed).unwrap(), offered);
        assert_ne!(pczt_txid(&other).unwrap(), offered);
    }
}
```

Copy the three PCZT files from the spike scratchpad (`sweep.proved.pczt`, `pczt-wasm/old.wasm-signed.pczt` as `sweep.signed.pczt`, `sweep2.proved.pczt`) into `watcher/tests/fixtures/`; they are not secrets (no keys inside) and their transactions are already mined.

- [ ] **Step 2: Run, expect compile failure.**

- [ ] **Step 3: Implement `sweep.rs`**

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{wallet::{create_pczt_from_proposal, extract_and_store_transaction_from_pczt, input_selection::LockedInputPolicy, propose_send_max_transfer, ConfirmationsPolicy}, MaxSpendMode, WalletRead},
    fees::StandardFeeRule, proto::service,
};
use zcash_client_sqlite::{util::SystemClock, AccountUuid};
use zcash_primitives::transaction::builder::BundlePadding;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{memo::MemoBytes, ShieldedPool};
use pczt::{roles::{prover::Prover, tx_extractor::TransactionExtractor}, Pczt};
use crate::{error::WatcherError, http::AppState, meta::{TabRow, TabState}, rng::OsRng};

#[derive(serde::Serialize)] pub struct SweepSummary { pub inputs_zat: u64, pub output_zat: u64, pub fee_zat: u64, pub expiry_height: u32, pub txid: String }
#[derive(serde::Serialize)] pub struct SweepOffer { pub pczt_b64: String, pub summary: SweepSummary }
#[derive(serde::Serialize)] pub struct SweepStatus { pub state: TabState, pub txid: Option<String>, pub mined_height: Option<u32>, pub confirmations: u32 }

pub fn pczt_txid(bytes: &[u8]) -> Result<String, WatcherError> {
    let pczt = Pczt::parse(bytes).map_err(|e| WatcherError::Unprocessable(format!("pczt: {e:?}")))?;
    // The txid is derivable from the (unsigned) effects; TransactionExtractor exposes it without signatures.
    let extractor = TransactionExtractor::new(pczt);
    Ok(extractor.txid().map_err(|e| WatcherError::Unprocessable(format!("pczt txid: {e:?}")))?.to_string())
}
```

If `TransactionExtractor::txid()` does not exist in `pczt 0.10.0-pre.1`, compute the txid the way zcash-devtool `pczt inspect` does (it printed `TxID:` for an unsigned PCZT in the spike): open `commands/pczt/inspect.rs` in the spike clone and copy that path (`pczt::roles::verifier` + `zcash_primitives::transaction::txid::TxIdDigester` over the PCZT's effects).

```rust
pub fn create_proved_pczt(state: &AppState, tab: &TabRow, recipient: &str, memo: Option<&str>) -> Result<SweepOffer, WatcherError> {
    if tab.state != TabState::Open { return Err(WatcherError::Conflict(format!("tab state is {}", tab.state.as_str()))); }
    let network = state.wallet.network();
    let recipient = ZcashAddress::try_from_encoded(recipient).map_err(|e| WatcherError::Unprocessable(format!("recipient: {e}")))?;
    let memo = memo.map(|m| MemoBytes::from_bytes(m.as_bytes())).transpose().map_err(|e| WatcherError::Unprocessable(format!("memo: {e}")))?;
    let account = AccountUuid::from_uuid(tab.account_uuid);
    let policy = ConfirmationsPolicy::new(state.cfg.confirmations_sweep, state.cfg.confirmations_sweep);  // trusted, untrusted
    let mut db = state.wallet.db();
    let proposal = propose_send_max_transfer(&mut *db, &network, account, &[ShieldedPool::Orchard, ShieldedPool::Ironwood], &StandardFeeRule::Zip317, recipient, memo, MaxSpendMode::Everything, policy, &LockedInputPolicy::Exclude, None)
        .map_err(|e| match e { e if format!("{e:?}").contains("InsufficientFunds") => WatcherError::Conflict("no spendable funds yet; wait for confirmations".into()), e => WatcherError::Wallet(format!("propose: {e:?}")) })?;
    let step = proposal.steps().first();
    let inputs_zat: u64 = step.shielded_inputs().map_or(0, |i| i.notes().iter().map(|n| n.note_value().inner()).sum());
    let fee_zat = u64::from(step.balance().fee_required());
    let pczt = create_pczt_from_proposal(&mut *db, &network, &SystemClock, &mut OsRng, account, zcash_client_backend::wallet::OvkPolicy::Sender, &proposal, None, BundlePadding::DEFAULT)
        .map_err(|e| WatcherError::Wallet(format!("create_pczt: {e:?}")))?;
    drop(db);
    let mut prover = Prover::new(pczt);
    if prover.requires_ironwood_proof() || prover.requires_orchard_proof() {
        let pk = orchard::circuit::ProvingKey::build(prover.orchard_circuit_version().map_err(|e| WatcherError::Wallet(format!("{e:?}")))?);
        if prover.requires_orchard_proof() { prover = prover.create_orchard_proof(OsRng, &pk).map_err(|e| WatcherError::Wallet(format!("orchard proof: {e:?}")))?; }
        if prover.requires_ironwood_proof() { prover = prover.create_ironwood_proof(OsRng, &pk).map_err(|e| WatcherError::Wallet(format!("ironwood proof: {e:?}")))?; }
    }
    let local = LocalTxProver::bundled();
    let pczt = prover.create_sapling_proofs(OsRng, &local, &local).map_err(|e| WatcherError::Wallet(format!("sapling proofs: {e:?}")))?.finish();
    let bytes = pczt.serialize().map_err(|e| WatcherError::Wallet(format!("serialize: {e:?}")))?;
    let txid = pczt_txid(&bytes)?;
    let expiry_height = Pczt::parse(&bytes).ok().and_then(|p| p.global().expiry_height()).unwrap_or(0);
    let summary = SweepSummary { inputs_zat, output_zat: inputs_zat - fee_zat, fee_zat, expiry_height, txid: txid.clone() };
    let pczt_b64 = B64.encode(&bytes);
    state.meta.put_sweep(tab.tab_id, &txid, &pczt_b64, expiry_height)?;
    Ok(SweepOffer { pczt_b64, summary })
}

pub async fn broadcast_signed(state: &AppState, tab: &TabRow, pczt_b64: &str) -> Result<String, WatcherError> {
    let offered = state.meta.get_sweep(tab.tab_id)?.ok_or_else(|| WatcherError::Conflict("no sweep offered for this tab".into()))?;
    let bytes = B64.decode(pczt_b64).map_err(|e| WatcherError::Unprocessable(format!("pczt_b64: {e}")))?;
    if pczt_txid(&bytes)? != offered.txid { return Err(WatcherError::Conflict("signed PCZT does not match the offered sweep".into())); }
    let pczt = Pczt::parse(&bytes).map_err(|e| WatcherError::Unprocessable(format!("pczt: {e:?}")))?;
    let txid = {
        let local = LocalTxProver::bundled();
        let (spend_vk, output_vk) = local.verifying_keys();
        let mut db = state.wallet.db();
        extract_and_store_transaction_from_pczt::<_, ()>(&mut *db, &SystemClock, &mut OsRng, pczt, Some((&spend_vk, &output_vk)), None)
            .map_err(|e| WatcherError::Unprocessable(format!("extract: {e:?}")))?
    };
    let raw = { let db = state.wallet.db(); let tx = db.get_transaction(txid).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?.ok_or_else(|| WatcherError::Wallet("extracted tx not stored".into()))?; let mut v = vec![]; tx.write(&mut v).map_err(|e| WatcherError::Wallet(e.to_string()))?; v };
    let mut client = state.client.lock().await;
    let resp = client.send_transaction(service::RawTransaction { data: raw, height: 0 }).await.map_err(|e| WatcherError::Remote(format!("send: {e}")))?.into_inner();
    if resp.error_code != 0 { return Err(WatcherError::Remote(format!("lightwalletd rejected tx: {} {}", resp.error_code, resp.error_message))); }
    state.meta.mark_broadcast(tab.tab_id)?;
    state.meta.set_tab_state(tab.tab_id, TabState::Sweeping)?;
    tracing::info!(tab = %tab.tab_id, "sweep broadcast");
    Ok(txid.to_string())
}

pub fn sweep_status(state: &AppState, tab: &TabRow) -> Result<SweepStatus, WatcherError> {
    let Some(sweep) = state.meta.get_sweep(tab.tab_id)? else { return Ok(SweepStatus { state: tab.state, txid: None, mined_height: None, confirmations: 0 }) };
    let tip = state.health.tip_height.load(std::sync::atomic::Ordering::Relaxed);
    let mined = state.wallet.mined_height_of(&sweep.txid)?;   // SELECT mined_height FROM transactions WHERE txid = ?
    let confirmations = mined.map_or(0, |h| tip.saturating_sub(h) + 1);
    if tab.state == TabState::Sweeping && confirmations >= state.cfg.confirmations_sweep { state.meta.set_tab_state(tab.tab_id, TabState::Closed)?; }
    if tab.state == TabState::Sweeping && mined.is_none() && tip > sweep.expiry_height { state.meta.set_tab_state(tab.tab_id, TabState::Open)?; }
    let tab = state.meta.get_tab(tab.tab_id)?.unwrap();
    Ok(SweepStatus { state: tab.state, txid: Some(sweep.txid), mined_height: mined, confirmations })
}
```

Names to verify against the pinned crates before writing: `ConfirmationsPolicy::new(trusted, untrusted)` (constructor name in `data_api/wallet.rs` or `proposal.rs`), `Prover::requires_orchard_proof/requires_ironwood_proof/orchard_circuit_version` (devtool `prove.rs` lines 196–234 show the exact calls), `proposal.steps()`, `step.balance().fee_required()`, `pczt.global().expiry_height()`. The spike's `create-max` on a 1-note Ironwood account produced a 2-action V6 transaction with fee 10000 zat.

- [ ] **Step 4: Implement `http/sweep.rs`** (three handlers that load the tab, call the service, map to JSON) and add routes: `.route("/v1/tabs/{tab_id}/sweep", post(sweep::offer).get(sweep::status)).route("/v1/tabs/{tab_id}/broadcast", post(sweep::broadcast))`.

- [ ] **Step 5: Live tests** in `tests/testnet_live.rs`:
  - `sweep_rejects_when_notes_are_immature`: register a fresh tab (new UFVK is needed: derive one from a random seed with `UnifiedSpendingKey::from_seed` in the test), pay nothing → `POST /sweep` → `409`.
  - `broadcast_rejects_mismatched_pczt`: register the fixture tab, `POST /sweep` → 200 (the fixture wallet holds mature notes), then `POST /broadcast` with `tests/fixtures/sweep2.proved.pczt` base64 → `409`.
  - Full happy path is Task 11 (needs funds and the signer).

- [ ] **Step 6: Run tests, expect PASS.** Commit — `git commit -m "watcher: PCZT sweep offer, broadcast with txid check, sweep status"`

---

### Task 10: Health endpoint and offline behaviour

**Files:**
- Create: `watcher/src/http/health.rs`
- Modify: `watcher/src/http/mod.rs`

**Interfaces:**
- `GET /v1/health` → `{ tip_height, synced_height, mempool_subscribed, lag_seconds, network }` (no auth). `lag_seconds` = seconds since `last_ok_at`, `null` if never.

- [ ] **Step 1: Write the failing test** `get_tab_is_served_from_db_when_offline` (live, but it points `ZTAB_LIGHTWALLETD_URL` at `https://127.0.0.1:1` after registering the fixture tab through a real connection: build the state online, register, then swap `state.client` for a client that fails — simplest: construct a second `AppState` sharing `wallet`/`meta` with `client` built from `remote::connect` to the dead URL wrapped in `tokio::time::timeout(2s)` → expect the connect itself to fail, so instead keep the shared client but hold its mutex locked in the test for the duration of the `GET`). Assert: the `GET` returns 200 within 500 ms with `stale: true`. This proves `get_tab` never touches the client.

- [ ] **Step 2: Implement `health.rs`**

```rust
use axum::{extract::State, Json};
use super::AppState;
pub async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let o = std::sync::atomic::Ordering::Relaxed;
    let lag = state.health.last_ok_at.lock().unwrap().map(|t| (time::OffsetDateTime::now_utc() - t).whole_seconds());
    Json(serde_json::json!({
        "tip_height": state.health.tip_height.load(o), "synced_height": state.health.synced_height.load(o),
        "mempool_subscribed": state.health.mempool_subscribed.load(o), "lag_seconds": lag,
        "network": match state.cfg.network { zcash_protocol::consensus::Network::MainNetwork => "main", _ => "test" },
    }))
}
```

Add `.route("/v1/health", get(health::health))` (the auth layer already exempts it).

- [ ] **Step 3: Run tests, expect PASS.** Commit — `git commit -m "watcher: health endpoint, stale facts served from db while offline"`

---

### Task 11: End-to-end testnet scenario (the spec's success criterion)

**Files:**
- Modify: `watcher/tests/testnet_live.rs`, `watcher/tests/common/mod.rs`
- Create: `watcher/tests/fixtures/README.md` (how the fixture wallet is funded; the seed lives in the env var `ZTAB_TEST_SEED_HEX`, never in the repo)

**Interfaces:**
- Consumes everything above. The test "pays" with `zcash_client_backend` directly from a funded fixture wallet (its own `WalletDb` in a temp dir, restored from `ZTAB_TEST_SEED_HEX` with birthday `FIXTURE_BIRTHDAY`), and "signs" the sweep with `pczt::roles::signer::Signer::sign_ironwood` using the tab's spending key derived in the test from a random seed — exactly what the browser module will do.

- [ ] **Step 1: Write the scenario**

```rust
#[tokio::test]
#[ignore = "needs ZTAB_TEST_SEED_HEX with >= 0.05 TAZ and ~12 minutes"]
async fn full_tab_lifecycle_on_testnet() {
    let seed_hex = std::env::var("ZTAB_TEST_SEED_HEX").expect("ZTAB_TEST_SEED_HEX");
    let (state, addr) = common::spawn_state_and_server().await;
    // 1. Alice's browser: random tab seed -> USK -> UFVK (what the WASM module will do)
    let tab_seed: [u8; 32] = rand::random();
    let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(&state.cfg.network, &tab_seed, zip32::AccountId::ZERO).unwrap();
    let ufvk = usk.to_unified_full_viewing_key().encode(&state.cfg.network).unwrap();
    let tip = common::tip(&state).await;
    let tab_id = uuid::Uuid::new_v4();
    let reg = common::post(&addr, "/v1/tabs", serde_json::json!({"tab_id": tab_id, "ufvk": ufvk, "birthday": tip, "participants_count": 2})).await;
    assert_eq!(reg.status(), 201);
    let addresses: Vec<String> = reg.json::<serde_json::Value>().await.unwrap()["addresses"].as_array().unwrap().iter().map(|a| a["address"].as_str().unwrap().to_string()).collect();
    // 2. Participant 1 pays 0.02 TAZ from the fixture wallet
    let payer = common::FixtureWallet::restore(&seed_hex, &state.cfg).await;
    let txid = payer.send(&addresses[1], 2_000_000, "ztab e2e").await;
    // 3. Mempool within 60 s
    let t0 = std::time::Instant::now();
    loop {
        ztab_watcher::sync::sync_once(&state).await.unwrap();
        let facts = common::get_tab(&addr, tab_id).await;
        let p1 = &facts["participants"][1]["status_facts"];
        if p1["mempool_zat"].as_u64().unwrap() + p1["confirmed_zat"].as_u64().unwrap() >= 2_000_000 { break; }
        assert!(t0.elapsed() < std::time::Duration::from_secs(60), "payment {txid} not seen within 60 s");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    // 4. Paid at 3 confirmations, sweepable at 10
    common::wait_until(&state, &addr, tab_id, |f| f["participants"][1]["status_facts"]["best_confirmations"].as_u64().unwrap() >= 10, 600).await;
    // 5. Sweep: server proves, test signs like the browser, server broadcasts
    let offer = common::post(&addr, &format!("/v1/tabs/{tab_id}/sweep"), serde_json::json!({"recipient_address": payer.address(), "memo": "ztab sweep"})).await;
    assert_eq!(offer.status(), 200);
    let offer: serde_json::Value = offer.json().await.unwrap();
    assert_eq!(offer["summary"]["output_zat"].as_u64().unwrap() + offer["summary"]["fee_zat"].as_u64().unwrap(), 2_000_000);
    let signed_b64 = common::sign_like_browser(offer["pczt_b64"].as_str().unwrap(), &usk);
    let bc = common::post(&addr, &format!("/v1/tabs/{tab_id}/broadcast"), serde_json::json!({"pczt_b64": signed_b64})).await;
    assert_eq!(bc.status(), 200);
    // 6. Closed after confirmations
    common::wait_until(&state, &addr, tab_id, |f| f["state"] == "sweeping" || f["state"] == "closed", 60).await;
    let status = common::get(&addr, &format!("/v1/tabs/{tab_id}/sweep")).await;
    assert!(status["txid"].as_str().is_some());
}
```

`common::sign_like_browser` is the Task-8-of-the-spike code: parse, `Verifier::with_ironwood` to collect indices with `zip32_derivation()`, `Signer::sign_ironwood(&mut OsRng, i, &SpendAuthorizingKey::from(usk.orchard()))`, `finish().serialize()`, base64. `FixtureWallet::send` uses `propose_standard_transfer_to_address` + `create_proposed_transactions` + `send_transaction`, after a sync of its own `WalletDb` (reuse `sync::sync_once` by building a throwaway `AppState` for the payer, or factor the sync core into `sync::sync_wallet(&WalletStore, &mut LwdClient)` and call it from both).

- [ ] **Step 2: Run it** with `ZTAB_TEST_SEED_HEX=<hex of the spike devtool wallet's seed or a new one funded from https://fauzec.com>` — `cargo test --test testnet_live full_tab_lifecycle -- --ignored --nocapture`. Expected: PASS in 8–14 minutes.

- [ ] **Step 3: Write `tests/fixtures/README.md`** (how to fund the fixture wallet: generate a seed, derive its address with the test helper, claim 1 TAZ at fauzec, wait 10 confirmations; how to refill; never commit the seed) and a `watcher/README.md` (env vars table, `cargo run`, how to run live tests, pointers to the skill).

- [ ] **Step 4: Commit** — `git commit -m "watcher: end-to-end testnet lifecycle test and README"`

---

## Self-review notes

- Spec §5.1 "after `closed` the account is excluded from mempool decryption": `open_tabs()` already filters by state `open`/`sweeping`, so Task 8 honours it.
- Spec §6 `GET /v1/tabs/{id}` field `stale` is produced in Task 6/10; `lag_seconds` in Task 10.
- Spec §9 step 7 (expiry → back to `open`) is in `sweep_status` (Task 9) and is only evaluated on request; acceptable for MVP, noted for the API's polling.
- Spec §12 logging rule: handlers log `tab` ids and counts only; `register` must not log the UFVK (Task 5 code complies).
- Names that depend on the pinned crates and are flagged for verification in-task: `import_account_ufvk` return type (T3), `UnifiedAddressRequest::unsafe_custom` (T4), `WalletDb::conn`/read-only connection (T4), `ScanRange::truncate_end` (T7), `DecryptedTransaction::{orchard_outputs, ironwood_outputs}` (T8), `TransactionExtractor::txid`, `ConfirmationsPolicy::new`, `Prover::orchard_circuit_version` (T9). Each task says where to look when a name differs.
