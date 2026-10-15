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
