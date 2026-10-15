// Each test binary uses a subset of this harness.
#![allow(dead_code)]
use std::{collections::HashMap, path::Path};
use ztab_watcher::config::Config;

/// Testnet UFVK of the spike's view-only wallet; it is a viewing key, not a secret.
pub const FIXTURE_UFVK: &str = match str::from_utf8(
    include_str!("../fixtures/fixture-ufvk.txt")
        .as_bytes()
        .trim_ascii(),
) {
    Ok(s) => s,
    Err(_) => panic!("fixture UFVK is not UTF-8"),
};
pub const FIXTURE_BIRTHDAY: u32 = 4_503_583;
/// The spike's funding transaction (block 4503718), sent *by* the fixture account: a
/// 0.3 TAZ output to another wallet (outgoing) plus 0.5998 TAZ change (account-internal).
pub const FIXTURE_FUNDING_TXID: &str =
    "f129d39ec195a077bd443c5aaf481e8d66d008eac8502ccfae5d1bbf0f341daa";
/// An external payment of 0.2999 TAZ to the fixture account's index-0 address (block 4503742).
pub const FIXTURE_INDEX0_PAYMENT_TXID: &str =
    "659513d7a836783c8ab08445069de601c5c25b7f422e30ab8f116f5ff0e0f978";
/// A 0.1 TAZ self-send by the fixture account to its own index-1 address (block 4503710).
pub const FIXTURE_INDEX1_SELF_SEND_TXID: &str =
    "f98c69c25ccf4f3367ae524ed6e0342b5f31e36800ebf072086a612b8520b4a4";

/// Raw bytes of a fixture transaction saved as `tests/fixtures/<first 8 hex>.rawtx`.
pub fn fixture_rawtx(txid: &str) -> Vec<u8> {
    std::fs::read(fixture_rawtx_path(txid)).unwrap()
}

pub fn fixture_rawtx_path(txid: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{}.rawtx", &txid[..8]))
}

pub fn testnet_config(tmp: &Path) -> Config {
    let m: HashMap<String, String> = [
        ("ZTAB_API_TOKEN", "test-token"),
        ("ZTAB_DATA_DIR", tmp.to_str().unwrap()),
        ("ZTAB_NETWORK", "test"),
        ("ZTAB_LIGHTWALLETD_URL", "https://testnet.zec.rocks:443"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    Config::from_map(&m).unwrap()
}

/// Builds `AppState` exactly like `main.rs` on a leaked tempdir, serves the router on an
/// ephemeral localhost port, and returns the state with the bound address.
pub async fn spawn_state_and_server() -> (ztab_watcher::http::AppState, std::net::SocketAddr) {
    use std::sync::Arc;
    use ztab_watcher::{
        http::{router, AppState, HealthState},
        meta::MetaStore,
        remote,
        wallet::WalletStore,
    };
    let tmp = tempfile::tempdir().unwrap();
    let cfg = Arc::new(testnet_config(tmp.path()));
    std::mem::forget(tmp); // keep the data dir alive for the life of the test process
    let wallet = Arc::new(WalletStore::open(&cfg).unwrap());
    let meta = Arc::new(MetaStore::open(&cfg).unwrap());
    let client = Arc::new(tokio::sync::Mutex::new(
        remote::connect(&cfg).await.unwrap(),
    ));
    let state = AppState {
        cfg,
        wallet,
        meta,
        client,
        health: Arc::new(HealthState::default()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (state, addr)
}

/// Registers the fixture account as a tab with `participants` participants. The fixture
/// birthday is older than `tip - 1000`, so this bypasses `POST /v1/tabs` and its birthday
/// check, doing what the handler does after validation.
pub async fn register_fixture_tab(
    state: &ztab_watcher::http::AppState,
    participants: u32,
) -> uuid::Uuid {
    use ztab_watcher::meta::{TabRow, TabState};
    let tab_id = uuid::Uuid::new_v4();
    let account = {
        let mut client = state.client.lock().await;
        state
            .wallet
            .import_tab_account(&mut client, tab_id, FIXTURE_UFVK, FIXTURE_BIRTHDAY)
            .await
            .unwrap()
    };
    state
        .meta
        .insert_tab(&TabRow {
            tab_id,
            account_uuid: account.expose_uuid(),
            ufvk: FIXTURE_UFVK.to_string(),
            birthday: FIXTURE_BIRTHDAY,
            participants_count: participants,
            state: TabState::Open,
            created_at: time::OffsetDateTime::now_utc(),
        })
        .unwrap();
    // Persist the participant addresses, as registration does.
    state
        .wallet
        .participant_addresses(account, participants)
        .unwrap();
    tab_id
}

/// Fixed tab id used by `import_fixture_tab_offline`.
pub fn fixture_tab_id() -> uuid::Uuid {
    uuid::Uuid::from_u128(0x2a7b_0000_0000_4000_8000_0000_0000_f129)
}

/// `AppState` on a leaked tempdir whose lightwalletd client is lazy and points at a closed
/// local port, so it is never dialed by tests that stay offline.
pub async fn offline_state() -> ztab_watcher::http::AppState {
    use std::sync::Arc;
    use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
    use ztab_watcher::{
        http::{AppState, HealthState},
        meta::MetaStore,
        wallet::WalletStore,
    };
    let tmp = tempfile::tempdir().unwrap();
    let cfg = Arc::new(testnet_config(tmp.path()));
    std::mem::forget(tmp);
    let wallet = Arc::new(WalletStore::open(&cfg).unwrap());
    let meta = Arc::new(MetaStore::open(&cfg).unwrap());
    let channel = tonic::transport::Channel::from_static("http://127.0.0.1:1").connect_lazy();
    AppState {
        cfg,
        wallet,
        meta,
        client: Arc::new(tokio::sync::Mutex::new(CompactTxStreamerClient::new(
            channel,
        ))),
        health: Arc::new(HealthState::default()),
    }
}

/// Registers the fixture account as tab `fixture_tab_id()` from the saved birthday tree
/// state (`tests/fixtures/birthday_treestate.bin`, refreshed by the ignored live test
/// `fetch_mempool_fixtures`), without network access.
pub async fn import_fixture_tab_offline(state: &ztab_watcher::http::AppState, participants: u32) {
    use prost::Message;
    use zcash_client_backend::proto::service::TreeState;
    use ztab_watcher::meta::{TabRow, TabState};
    let bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/birthday_treestate.bin"),
    )
    .unwrap();
    let chain_state = TreeState::decode(&bytes[..])
        .unwrap()
        .to_chain_state()
        .unwrap();
    let tab_id = fixture_tab_id();
    let account = state
        .wallet
        .import_tab_account_from_chain_state(tab_id, FIXTURE_UFVK, chain_state)
        .unwrap();
    state
        .meta
        .insert_tab(&TabRow {
            tab_id,
            account_uuid: account.expose_uuid(),
            ufvk: FIXTURE_UFVK.to_string(),
            birthday: FIXTURE_BIRTHDAY,
            participants_count: participants,
            state: TabState::Open,
            created_at: time::OffsetDateTime::now_utc(),
        })
        .unwrap();
    state
        .wallet
        .participant_addresses(account, participants)
        .unwrap();
}
