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
        sweep_locks: Default::default(),
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
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    ztab_watcher::facts::ensure_tab_addresses(&state.wallet, &state.meta, &tab).unwrap();
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
        sweep_locks: Default::default(),
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
    // Persist the participant addresses, as registration does.
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    ztab_watcher::facts::ensure_tab_addresses(&state.wallet, &state.meta, &tab).unwrap();
}

/// `ZTAB_TEST_SEED_HEX`, or `None` with a skip notice, so a plain
/// `cargo test --test testnet_live -- --ignored` run without the secret stays green.
pub fn test_seed_hex() -> Option<String> {
    let seed = std::env::var("ZTAB_TEST_SEED_HEX")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if seed.is_none() {
        eprintln!("SKIPPED: ZTAB_TEST_SEED_HEX is not set (see tests/fixtures/README.md)");
    }
    seed
}

/// Spending key of the fixture payer (participant) wallet, from `ZTAB_TEST_SEED_HEX`.
pub fn payer_usk(
    seed_hex: &str,
    network: &zcash_protocol::consensus::Network,
) -> zcash_keys::keys::UnifiedSpendingKey {
    let seed = hex::decode(seed_hex.trim()).expect("ZTAB_TEST_SEED_HEX must be hex");
    assert!(
        seed.len() >= 32,
        "ZTAB_TEST_SEED_HEX must be at least 32 bytes"
    );
    zcash_keys::keys::UnifiedSpendingKey::from_seed(network, &seed, zip32::AccountId::ZERO)
        .expect("derive payer USK")
}

/// The payer's shielded (Orchard + Sapling) default unified address: where the faucet pays
/// and where the sweep returns the funds.
pub fn payer_address(
    usk: &zcash_keys::keys::UnifiedSpendingKey,
    network: &zcash_protocol::consensus::Network,
) -> String {
    usk.to_unified_full_viewing_key()
        .default_address(zcash_keys::keys::UnifiedAddressRequest::SHIELDED)
        .expect("payer default address")
        .0
        .encode(network)
}

/// Height the fixture payer wallet scans from: ten blocks below the block that mined its
/// faucet claim (`b020fe49…`, height 4505147). A refilled or new payer seed sets
/// `ZTAB_TEST_PAYER_BIRTHDAY` instead (see `tests/fixtures/README.md`).
pub const PAYER_DEFAULT_BIRTHDAY: u32 = 4_505_137;

pub fn payer_birthday() -> u32 {
    std::env::var("ZTAB_TEST_PAYER_BIRTHDAY")
        .ok()
        .map(|v| {
            v.trim()
                .parse()
                .expect("ZTAB_TEST_PAYER_BIRTHDAY must be a height")
        })
        .unwrap_or(PAYER_DEFAULT_BIRTHDAY)
}

/// A participant's wallet: a spending account restored from `ZTAB_TEST_SEED_HEX` in its own
/// `WalletStore` on a temp dir, synced with the watcher's own sync core. It pays like any
/// Zcash wallet would; its keys never touch the watcher under test.
pub struct FixtureWallet {
    store: std::sync::Arc<ztab_watcher::wallet::WalletStore>,
    client: tokio::sync::Mutex<ztab_watcher::remote::LwdClient>,
    health: ztab_watcher::http::HealthState,
    account: zcash_client_sqlite::AccountUuid,
    usk: zcash_keys::keys::UnifiedSpendingKey,
    address: String,
    network: zcash_protocol::consensus::Network,
    _dir: tempfile::TempDir,
}

impl FixtureWallet {
    /// Restores the payer account (birthday `payer_birthday()`) and syncs it to the tip.
    pub async fn restore(seed_hex: &str, cfg: &Config) -> Self {
        use zcash_client_backend::{
            data_api::{Account, AccountBirthday, AccountPurpose, WalletWrite},
            proto::service::BlockId,
        };
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = cfg.clone();
        cfg.data_dir = dir.path().to_path_buf();
        let store = std::sync::Arc::new(ztab_watcher::wallet::WalletStore::open(&cfg).unwrap());
        let mut client = ztab_watcher::remote::connect(&cfg).await.unwrap();
        let usk = payer_usk(seed_hex, &cfg.network);
        let address = payer_address(&usk, &cfg.network);
        let chain_state = client
            .get_tree_state(BlockId {
                height: u64::from(payer_birthday() - 1),
                hash: vec![],
            })
            .await
            .unwrap()
            .into_inner()
            .to_chain_state()
            .unwrap();
        let account = store
            .db()
            .import_account_ufvk(
                "fixture payer",
                &usk.to_unified_full_viewing_key(),
                &AccountBirthday::from_parts(chain_state, None),
                AccountPurpose::Spending { derivation: None },
                None,
            )
            .unwrap()
            .id();
        let wallet = Self {
            store,
            client: tokio::sync::Mutex::new(client),
            health: Default::default(),
            account,
            usk,
            address,
            network: cfg.network,
            _dir: dir,
        };
        wallet.sync().await;
        wallet
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    /// `Some(mined height)` once this wallet holds transaction `txid` (display hex).
    pub fn transaction_mined_height(&self, txid: &str) -> Option<Option<u32>> {
        self.store.transaction_mined_height(txid).unwrap()
    }

    /// One sync pass to the current tip, retried a few times on transient server errors.
    pub async fn sync(&self) -> ztab_watcher::sync::SyncReport {
        let mut client = self.client.lock().await;
        for attempt in 1.. {
            match ztab_watcher::sync::sync_wallet(&self.store, &mut client, &self.health).await {
                Ok(r) => return r,
                Err(e) if attempt < 5 => {
                    eprintln!("payer sync attempt {attempt} failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
                Err(e) => panic!("payer sync failed: {e}"),
            }
        }
        unreachable!()
    }

    /// (total, spendable under the ZIP 315 default policy) balance in zatoshis.
    pub fn balance_zat(&self) -> (u64, u64) {
        use zcash_client_backend::data_api::{wallet::ConfirmationsPolicy, WalletRead};
        let summary = self
            .store
            .db()
            .get_wallet_summary(ConfirmationsPolicy::default())
            .unwrap();
        summary
            .and_then(|s| s.account_balances().get(&self.account).cloned())
            .map_or((0, 0), |b| {
                (u64::from(b.total()), u64::from(b.spendable_value()))
            })
    }

    /// Syncs, then pays `zat` to `to` with `memo` (ZIP 317 fee, ZIP 315 confirmations) and
    /// broadcasts it. Returns the display-hex txid.
    pub async fn send(&self, to: &str, zat: u64, memo: &str) -> String {
        use std::{convert::Infallible, str::FromStr};
        use zcash_client_backend::{
            data_api::{
                wallet::{
                    create_proposed_transactions, propose_standard_transfer_to_address,
                    ConfirmationsPolicy, SpendingKeys,
                },
                WalletRead,
            },
            fees::StandardFeeRule,
            proto::service::RawTransaction,
            wallet::OvkPolicy,
        };
        use zcash_client_sqlite::util::SystemClock;
        use zcash_protocol::{
            memo::{Memo, MemoBytes},
            value::Zatoshis,
            ShieldedPool,
        };
        self.sync().await;
        let to = zcash_keys::address::Address::decode(&self.network, to).expect("recipient");
        let memo = MemoBytes::from(Memo::from_str(memo).unwrap());
        let raw = {
            let mut db = self.store.db();
            let proposal = propose_standard_transfer_to_address::<_, _, Infallible>(
                &mut *db,
                &self.network,
                StandardFeeRule::Zip317,
                self.account,
                ConfirmationsPolicy::default(),
                &to,
                Zatoshis::from_u64(zat).unwrap(),
                Some(memo),
                None,
                ShieldedPool::Ironwood,
                None,
                None,
            )
            .expect("propose payment (is the payer funded with 10 confirmations?)");
            let prover = zcash_proofs::prover::LocalTxProver::bundled();
            let mut rng = ztab_watcher::rng::OsRng;
            let txids = create_proposed_transactions::<_, _, Infallible, _, Infallible, _>(
                &mut *db,
                &self.network,
                &SystemClock,
                &mut rng,
                &prover,
                &prover,
                &SpendingKeys::from_unified_spending_key(self.usk.clone()),
                OvkPolicy::Sender,
                &proposal,
                None,
            )
            .expect("create payment");
            assert_eq!(txids.len(), 1, "a payment is one transaction");
            let tx = db
                .get_transaction(*txids.first())
                .unwrap()
                .expect("created transaction is stored");
            let mut raw = vec![];
            tx.write(&mut raw).unwrap();
            (tx.txid().to_string(), raw)
        };
        let (txid, raw) = raw;
        let resp = self
            .client
            .lock()
            .await
            .send_transaction(RawTransaction {
                data: raw,
                height: 0,
            })
            .await
            .expect("send_transaction")
            .into_inner();
        assert_eq!(
            resp.error_code, 0,
            "payment {txid} rejected: {}",
            resp.error_message
        );
        txid
    }
}

/// Signs the tab's Ironwood spends in a proved PCZT with the tab's spend authorizing key,
/// as the browser module will, and returns the signed PCZT as URL-safe unpadded base64.
///
/// The spike's `probe_sign` picked the spends carrying a `zip32_derivation`. The watcher
/// imports tabs from a bare UFVK, so its PCZTs carry no derivation. Instead, every unsigned
/// Ironwood spend is tried: a spend whose `rk` the key does not match
/// (`WrongSpendAuthorizingKey`) is not the tab's, and the attempt leaves the PCZT unchanged.
/// Padding spends arrive already signed. At least one spend must be the tab's.
pub fn sign_like_browser(pczt_b64: &str, usk: &zcash_keys::keys::UnifiedSpendingKey) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use pczt::roles::{
        signer::{Error as SignerError, Signer},
        verifier::Verifier,
    };
    let bytes = URL_SAFE_NO_PAD.decode(pczt_b64).unwrap();
    let pczt = pczt::Pczt::parse(&bytes).unwrap();
    let mut unsigned = Vec::new();
    let pczt = Verifier::new(pczt)
        .with_ironwood::<std::convert::Infallible, _>(|bundle| {
            for (i, action) in bundle.actions().iter().enumerate() {
                if action.spend().spend_auth_sig().is_none() {
                    unsigned.push(i);
                }
            }
            Ok(())
        })
        .unwrap()
        .finish();
    let ask = orchard::keys::SpendAuthorizingKey::from(usk.orchard());
    let mut signer = Signer::new(pczt).unwrap();
    let mut signed = 0;
    for i in unsigned {
        match signer.sign_ironwood(ztab_watcher::rng::OsRng, i, &ask) {
            Ok(()) => signed += 1,
            Err(SignerError::IronwoodSign(
                orchard::pczt::SignerError::WrongSpendAuthorizingKey,
            )) => {}
            Err(e) => panic!("signing Ironwood action {i}: {e:?}"),
        }
    }
    assert!(signed > 0, "the sweep spends nothing of this tab's");
    URL_SAFE_NO_PAD.encode(signer.finish().serialize().unwrap())
}

/// The chain tip as the watcher's lightwalletd reports it.
pub async fn tip(state: &ztab_watcher::http::AppState) -> u32 {
    let mut client = state.client.lock().await;
    u32::from(
        ztab_watcher::remote::latest_height(&mut client)
            .await
            .unwrap()
            .0,
    )
}

pub async fn post(
    addr: &std::net::SocketAddr,
    path: &str,
    body: serde_json::Value,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{addr}{path}"))
        .header("Authorization", "Bearer test-token")
        .json(&body)
        .send()
        .await
        .unwrap()
}

/// GET with the bearer token; asserts 200 and returns the JSON body.
pub async fn get(addr: &std::net::SocketAddr, path: &str) -> serde_json::Value {
    let r = reqwest::Client::new()
        .get(format!("http://{addr}{path}"))
        .header("Authorization", "Bearer test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "GET {path}");
    r.json().await.unwrap()
}

pub async fn get_tab(addr: &std::net::SocketAddr, tab_id: uuid::Uuid) -> serde_json::Value {
    get(addr, &format!("/v1/tabs/{tab_id}")).await
}

/// Runs a watcher sync pass (a failed pass is logged and retried, as the service's loop
/// does), then reads `GET /v1/tabs/{id}`, every 5 s until `pred` holds; panics after
/// `timeout_secs`. Returns the facts that satisfied `pred`.
pub async fn wait_until(
    state: &ztab_watcher::http::AppState,
    addr: &std::net::SocketAddr,
    tab_id: uuid::Uuid,
    pred: impl Fn(&serde_json::Value) -> bool,
    timeout_secs: u64,
) -> serde_json::Value {
    let t0 = std::time::Instant::now();
    loop {
        if let Err(e) = ztab_watcher::sync::sync_once(state).await {
            eprintln!("watcher sync pass failed (retrying): {e}");
        }
        let facts = get_tab(addr, tab_id).await;
        if pred(&facts) {
            return facts;
        }
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(timeout_secs),
            "condition not met within {timeout_secs} s; last facts: {facts}"
        );
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

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
    let Ok(cmd) = std::env::var("ZTAB_TEST_SIGNER_CMD") else {
        return sign_like_browser(req.pczt_b64, req.usk);
    };
    let input = serde_json::json!({
        "op": "sign",
        "network": network_name(req.network),
        "spendSeedHex": hex::encode(req.spend_seed),
        "pcztB64": req.pczt_b64,
        "recipient": req.recipient,
        "totalZat": req.total_zat,
        "feeZat": req.fee_zat,
    });
    let reply = run_signer_cmd(&cmd, &input);
    assert_eq!(
        reply["ufvk"].as_str().unwrap(),
        req.ufvk,
        "the browser module derived a different UFVK from the same seed"
    );
    reply["signedPcztB64"].as_str().unwrap().to_string()
}

/// What the browser module derives from a tab seed: its UFVK and the addresses at indices
/// `0..participants`. `None` when `ZTAB_TEST_SIGNER_CMD` is unset (the in-process path).
pub fn derive_for_test(
    network: &zcash_protocol::consensus::Network,
    spend_seed: &[u8; 32],
    participants: u32,
) -> Option<(String, Vec<String>)> {
    let cmd = std::env::var("ZTAB_TEST_SIGNER_CMD").ok()?;
    let input = serde_json::json!({
        "op": "derive",
        "network": network_name(network),
        "spendSeedHex": hex::encode(spend_seed),
        "participantsCount": participants,
    });
    let reply = run_signer_cmd(&cmd, &input);
    let addresses = reply["addresses"]
        .as_array()
        .expect("addresses array")
        .iter()
        .map(|a| a.as_str().unwrap().to_string())
        .collect();
    Some((reply["ufvk"].as_str().unwrap().to_string(), addresses))
}

fn network_name(network: &zcash_protocol::consensus::Network) -> &'static str {
    use zcash_protocol::consensus::Network;
    match network {
        Network::TestNetwork => "test",
        Network::MainNetwork => "main",
    }
}

/// Runs `sh -c cmd`, sends `input` as JSON on stdin and parses the JSON reply on stdout.
fn run_signer_cmd(cmd: &str, input: &serde_json::Value) -> serde_json::Value {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(cmd)
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
    serde_json::from_slice(&out.stdout).expect("signer reply is JSON")
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
