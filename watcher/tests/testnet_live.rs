mod common;
use ztab_watcher::remote;

#[tokio::test]
#[ignore = "needs network: cargo test --test testnet_live -- --ignored"]
async fn connects_and_reads_tip_on_nu7_testnet() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let (height, _hash) = remote::latest_height(&mut client).await.unwrap();
    assert!(
        u32::from(height) >= 4_465_026,
        "testnet must already be past NU7 activation"
    );
}

#[tokio::test]
#[ignore]
async fn import_tab_account_creates_view_only_account() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let store = ztab_watcher::wallet::WalletStore::open(&cfg).unwrap();
    let account = store
        .import_tab_account(
            &mut client,
            uuid::Uuid::new_v4(),
            common::FIXTURE_UFVK,
            common::FIXTURE_BIRTHDAY,
        )
        .await
        .unwrap();
    use zcash_client_backend::data_api::{Account, WalletRead};
    let db = store.db();
    let acct = db.get_account(account).unwrap().expect("account exists");
    assert!(acct.ufvk().is_some());
    assert_eq!(
        u32::from(db.get_account_birthday(account).unwrap()),
        common::FIXTURE_BIRTHDAY
    );
}

#[tokio::test]
#[ignore]
async fn participant_addresses_are_deterministic_orchard_only_uas() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let store = ztab_watcher::wallet::WalletStore::open(&cfg).unwrap();
    let account = store
        .import_tab_account(
            &mut client,
            uuid::Uuid::new_v4(),
            common::FIXTURE_UFVK,
            common::FIXTURE_BIRTHDAY,
        )
        .await
        .unwrap();
    let first = store.participant_addresses(account, 3).unwrap();
    let again = store.participant_addresses(account, 3).unwrap();
    assert_eq!(first, again, "addresses must be deterministic per index");
    assert_eq!(first.len(), 3);
    assert!(first.iter().all(|(_, a)| a.starts_with("utest1")));
    assert_ne!(first[0].1, first[1].1);
    // index 0 of the fixture UFVK is the spike wallet's first address
    assert_eq!(first[0].1, "utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp");
    // address ids resolve back to indices
    let conn = store.read_conn();
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM addresses ORDER BY diversifier_index_be")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    drop(conn);
    let mut found: Vec<u32> = ids
        .iter()
        .filter_map(|id| store.index_for_address_id(*id).unwrap())
        .collect();
    found.sort();
    for i in 0..3u32 {
        assert!(found.contains(&i), "index {i} missing from {found:?}");
    }
    assert_eq!(store.index_for_address_id(i64::MAX).unwrap(), None);
}

/// The fixture birthday falls outside the tip-1000 window as testnet advances, so register
/// with a birthday close to the current tip.
async fn recent_birthday(state: &ztab_watcher::http::AppState) -> u32 {
    let mut client = state.client.lock().await;
    let (tip, _) = remote::latest_height(&mut client).await.unwrap();
    u32::from(tip) - 10
}

fn register_body(tab_id: uuid::Uuid, ufvk: &str, birthday: u32, count: u32) -> serde_json::Value {
    serde_json::json!({
        "tab_id": tab_id, "ufvk": ufvk,
        "birthday": birthday, "participants_count": count,
    })
}

#[tokio::test]
#[ignore]
async fn register_creates_idempotent_tab_with_addresses() {
    let (state, addr) = common::spawn_state_and_server().await;
    let birthday = recent_birthday(&state).await;
    let http = reqwest::Client::new();
    let url = format!("http://{addr}/v1/tabs");
    let tab_id = uuid::Uuid::new_v4();
    let post = |body: serde_json::Value| {
        http.post(&url)
            .header("Authorization", "Bearer test-token")
            .json(&body)
            .send()
    };

    let r1 = post(register_body(tab_id, common::FIXTURE_UFVK, birthday, 3))
        .await
        .unwrap();
    assert_eq!(r1.status(), 201);
    let j1: serde_json::Value = r1.json().await.unwrap();
    let addrs = j1["addresses"].as_array().unwrap();
    assert_eq!(addrs.len(), 3);
    for (i, a) in addrs.iter().enumerate() {
        assert_eq!(a["index"], i as u64);
        assert!(a["address"].as_str().unwrap().starts_with("utest1"));
    }

    let r2 = post(register_body(tab_id, common::FIXTURE_UFVK, birthday, 3))
        .await
        .unwrap();
    assert_eq!(r2.status(), 201);
    let j2: serde_json::Value = r2.json().await.unwrap();
    assert_eq!(j1["addresses"], j2["addresses"]);

    let r0 = post(register_body(
        uuid::Uuid::new_v4(),
        common::FIXTURE_UFVK,
        birthday,
        0,
    ))
    .await
    .unwrap();
    assert_eq!(r0.status(), 422);

    let noauth = http
        .post(&url)
        .json(&register_body(tab_id, common::FIXTURE_UFVK, birthday, 3))
        .send()
        .await
        .unwrap();
    assert_eq!(noauth.status(), 401);
}

#[tokio::test]
#[ignore]
async fn register_rejects_ufvk_change() {
    let (state, addr) = common::spawn_state_and_server().await;
    let birthday = recent_birthday(&state).await;
    let http = reqwest::Client::new();
    let url = format!("http://{addr}/v1/tabs");
    let tab_id = uuid::Uuid::new_v4();
    let send = |ufvk: String| {
        http.post(&url)
            .header("Authorization", "Bearer test-token")
            .json(&register_body(tab_id, &ufvk, birthday, 2))
            .send()
    };
    assert_eq!(
        send(common::FIXTURE_UFVK.to_string())
            .await
            .unwrap()
            .status(),
        201
    );
    let hrp_end = common::FIXTURE_UFVK.find('1').unwrap() + 1;
    let mut changed = common::FIXTURE_UFVK.to_string();
    let c = changed.as_bytes()[hrp_end];
    changed.replace_range(hrp_end..hrp_end + 1, if c == b'q' { "p" } else { "q" });
    assert_eq!(send(changed).await.unwrap().status(), 409);
}

#[tokio::test]
#[ignore]
async fn register_recovers_from_import_without_tab_row() {
    let (state, addr) = common::spawn_state_and_server().await;
    let birthday = recent_birthday(&state).await;
    let tab_id = uuid::Uuid::new_v4();
    {
        // Simulates a crash between import_tab_account and insert_tab.
        let mut client = state.client.lock().await;
        state
            .wallet
            .import_tab_account(&mut client, tab_id, common::FIXTURE_UFVK, birthday)
            .await
            .unwrap();
    }
    let r = reqwest::Client::new()
        .post(format!("http://{addr}/v1/tabs"))
        .header("Authorization", "Bearer test-token")
        .json(&register_body(tab_id, common::FIXTURE_UFVK, birthday, 3))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let j: serde_json::Value = r.json().await.unwrap();
    assert_eq!(j["addresses"].as_array().unwrap().len(), 3);
}

#[tokio::test]
#[ignore]
async fn concurrent_registers_of_same_tab_are_idempotent() {
    let (state, addr) = common::spawn_state_and_server().await;
    let birthday = recent_birthday(&state).await;
    let tab_id = uuid::Uuid::new_v4();
    let http = reqwest::Client::new();
    let send = || {
        http.post(format!("http://{addr}/v1/tabs"))
            .header("Authorization", "Bearer test-token")
            .json(&register_body(tab_id, common::FIXTURE_UFVK, birthday, 3))
            .send()
    };
    let (a, b) = tokio::join!(send(), send());
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!((a.status().as_u16(), b.status().as_u16()), (201, 201));
    let (ja, jb): (serde_json::Value, serde_json::Value) =
        (a.json().await.unwrap(), b.json().await.unwrap());
    assert_eq!(ja["addresses"], jb["addresses"]);
}

#[tokio::test]
#[ignore]
async fn get_tab_returns_empty_facts_for_fresh_tab() {
    let (state, addr) = common::spawn_state_and_server().await;
    let birthday = recent_birthday(&state).await;
    let http = reqwest::Client::new();
    let tab_id = uuid::Uuid::new_v4();
    let r = http
        .post(format!("http://{addr}/v1/tabs"))
        .header("Authorization", "Bearer test-token")
        .json(&register_body(tab_id, common::FIXTURE_UFVK, birthday, 3))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);

    // The facts query binds accounts.uuid as a 16-byte BLOB; prove that matches storage.
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let (ty, n): (String, i64) = state
        .wallet
        .read_conn()
        .query_row(
            "SELECT typeof(uuid), count(*) FROM accounts WHERE uuid = ?1",
            [tab.account_uuid.as_bytes().to_vec()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((ty.as_str(), n), ("blob", 1));

    let g = http
        .get(format!("http://{addr}/v1/tabs/{tab_id}"))
        .header("Authorization", "Bearer test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(g.status(), 200);
    let j: serde_json::Value = g.json().await.unwrap();
    assert_eq!(j["tab_id"], tab_id.to_string());
    assert_eq!(j["state"], "open");
    assert_eq!(j["stale"], true);
    let ps = j["participants"].as_array().unwrap();
    assert_eq!(ps.len(), 3);
    for (i, p) in ps.iter().enumerate() {
        assert_eq!(p["index"], i as u64);
        assert!(p["address"].as_str().unwrap().starts_with("utest1"));
        assert_eq!(p["status_facts"]["confirmed_zat"], 0);
        assert_eq!(p["status_facts"]["mempool_zat"], 0);
        assert!(p["payments"].as_array().unwrap().is_empty());
    }

    let missing = http
        .get(format!("http://{addr}/v1/tabs/{}", uuid::Uuid::new_v4()))
        .header("Authorization", "Bearer test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
}

#[tokio::test]
#[ignore]
async fn sync_once_scans_fixture_tab_to_tip_and_finds_its_notes() {
    let (state, _server) = common::spawn_state_and_server().await;
    let tab_id = common::register_fixture_tab(&state, 2).await;
    let started = std::time::Instant::now();
    let report = ztab_watcher::sync::sync_once(&state).await.unwrap();
    eprintln!(
        "first sync: tip {} scanned_to {} in {:?}",
        report.tip,
        report.scanned_to,
        started.elapsed()
    );
    assert!(report.scanned_to >= report.tip - 2);
    assert_eq!(
        state
            .health
            .synced_height
            .load(std::sync::atomic::Ordering::Relaxed),
        report.scanned_to
    );
    assert!(state.health.last_ok_at.lock().unwrap().is_some());
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let facts = ztab_watcher::facts::tab_facts(
        &state.wallet,
        &state.meta,
        &state.cfg,
        &tab,
        report.tip,
        report.scanned_to,
        false,
    )
    .unwrap();
    // Index 0 received external payments (blocks 4503688, 4503742, 4503782): the
    // Orchard-only UA handed out for index 0 resolves to the stored full-UA row.
    assert!(facts.participants[0].status_facts.confirmed_zat > 0);
    assert!(facts.participants[0].status_facts.best_confirmations >= 10);
    // Index 1's only note (0.1 TAZ, block 4503710) was sent by the fixture account to
    // itself; the scanner marks such notes as change, so it is not a participant payment.
    assert_eq!(facts.participants[1].status_facts.confirmed_zat, 0);
    // ...but it does resolve to diversifier index 1.
    let self_send_address_id: i64 = state
        .wallet
        .read_conn()
        .query_row(
            "SELECT r.address_id FROM v_received_outputs r
               JOIN transactions t ON t.id_tx = r.transaction_id
              WHERE t.mined_height = 4503710 AND r.address_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        state
            .wallet
            .index_for_address_id(self_send_address_id)
            .unwrap(),
        Some(1)
    );
    // Every mined payment got a transparent-source verdict.
    for p in facts.participants.iter().flat_map(|p| &p.payments) {
        assert!(
            state.meta.transparent_source(&p.txid).unwrap().is_some(),
            "no tx_sources row for {}",
            p.txid
        );
    }
}

#[tokio::test]
#[ignore]
async fn reorg_truncate_clears_confirmed_facts() {
    let (state, _server) = common::spawn_state_and_server().await;
    let tab_id = common::register_fixture_tab(&state, 2).await;
    let report = ztab_watcher::sync::sync_once(&state).await.unwrap();
    {
        use zcash_client_backend::data_api::WalletWrite;
        let mut db = state.wallet.db();
        db.truncate_to_height(zcash_protocol::consensus::BlockHeight::from_u32(
            common::FIXTURE_BIRTHDAY,
        ))
        .unwrap();
    }
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let facts = ztab_watcher::facts::tab_facts(
        &state.wallet,
        &state.meta,
        &state.cfg,
        &tab,
        report.tip,
        common::FIXTURE_BIRTHDAY,
        false,
    )
    .unwrap();
    assert_eq!(
        facts.participants[0].status_facts.confirmed_zat, 0,
        "truncated notes must not count as confirmed"
    );
    let report2 = ztab_watcher::sync::sync_once(&state).await.unwrap();
    let facts2 = ztab_watcher::facts::tab_facts(
        &state.wallet,
        &state.meta,
        &state.cfg,
        &tab,
        report2.tip,
        report2.scanned_to,
        false,
    )
    .unwrap();
    assert!(
        facts2.participants[0].status_facts.confirmed_zat > 0,
        "rescan restores them"
    );
}

/// Exercises the scanner's continuity-error path: after a sync, rewind the wallet a little
/// and corrupt the stored hash of its new last block, so the next scanned block's
/// `prev_hash` contradicts our history exactly as in a reorg.
#[tokio::test]
#[ignore]
async fn continuity_error_rewinds_and_rescans() {
    let (state, _server) = common::spawn_state_and_server().await;
    let tab_id = common::register_fixture_tab(&state, 2).await;
    let report = ztab_watcher::sync::sync_once(&state).await.unwrap();
    let truncated = {
        use zcash_client_backend::data_api::WalletWrite;
        let mut db = state.wallet.db();
        let h = db
            .truncate_to_height(zcash_protocol::consensus::BlockHeight::from_u32(
                report.scanned_to - 20,
            ))
            .unwrap();
        u32::from(h)
    };
    let conn = rusqlite::Connection::open(state.cfg.data_dir.join("wallet.sqlite")).unwrap();
    let n = conn
        .execute(
            "UPDATE blocks SET hash = zeroblob(32) WHERE height = ?1",
            [truncated],
        )
        .unwrap();
    assert_eq!(n, 1, "the rewound-to block must be stored");
    drop(conn);

    let report2 = ztab_watcher::sync::sync_once(&state).await.unwrap();
    let rewound = report2
        .rewound_to
        .expect("continuity error must trigger a rewind");
    assert!(
        rewound < truncated,
        "rewound to {rewound}, truncated at {truncated}"
    );
    assert!(report2.scanned_to >= report.tip);
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let facts = ztab_watcher::facts::tab_facts(
        &state.wallet,
        &state.meta,
        &state.cfg,
        &tab,
        report2.tip,
        report2.scanned_to,
        false,
    )
    .unwrap();
    assert!(facts.participants[0].status_facts.confirmed_zat > 0);
}

#[tokio::test]
#[ignore]
async fn sync_once_without_tabs_does_not_scan() {
    let (state, _server) = common::spawn_state_and_server().await;
    let started = std::time::Instant::now();
    let report = ztab_watcher::sync::sync_once(&state).await.unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert_eq!(report.scanned_to, report.tip);
    assert_eq!(report.rewound_to, None);
    let queued: i64 = state
        .wallet
        .read_conn()
        .query_row("SELECT count(*) FROM scan_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(queued, 0, "an empty wallet must not queue blocks");
}

/// Refreshes the offline fixtures used by `tests/mempool.rs` (raw funding tx and the
/// birthday tree state). Writes only missing files; both are public testnet data.
#[tokio::test]
#[ignore]
async fn fetch_mempool_fixtures() {
    use prost::Message;
    use zcash_client_backend::proto::service;
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = ztab_watcher::remote::connect(&cfg).await.unwrap();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for txid in [
        common::FIXTURE_FUNDING_TXID,
        common::FIXTURE_INDEX0_PAYMENT_TXID,
        common::FIXTURE_INDEX1_SELF_SEND_TXID,
    ] {
        let raw_path = common::fixture_rawtx_path(txid);
        if !raw_path.exists() {
            let internal = ztab_watcher::sync::txid_internal_bytes(txid).unwrap();
            let raw = client
                .get_transaction(service::TxFilter {
                    hash: internal.to_vec(),
                    ..Default::default()
                })
                .await
                .unwrap()
                .into_inner();
            std::fs::write(&raw_path, &raw.data).unwrap();
        }
        // v5+ transactions carry their own branch id; the argument only affects v4.
        let tx = zcash_primitives::transaction::Transaction::read(
            &common::fixture_rawtx(txid)[..],
            zcash_protocol::consensus::BranchId::Nu6_1,
        )
        .unwrap();
        assert_eq!(tx.txid().to_string(), txid);
    }
    let ts_path = dir.join("birthday_treestate.bin");
    if !ts_path.exists() {
        let ts = client
            .get_tree_state(service::BlockId {
                height: u64::from(common::FIXTURE_BIRTHDAY - 1),
                hash: vec![],
            })
            .await
            .unwrap()
            .into_inner();
        std::fs::write(&ts_path, ts.encode_to_vec()).unwrap();
    }
}

#[tokio::test]
#[ignore]
async fn mempool_loop_resubscribes_after_stream_end() {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let (state, _server) = common::spawn_state_and_server().await;
    common::register_fixture_tab(&state, 2).await;
    for pass_no in 1..=2 {
        let s = state.clone();
        let pass = tokio::spawn(async move { ztab_watcher::mempool::mempool_pass(&s).await });
        let mut subscribed = false;
        for _ in 0..50 {
            if state.health.mempool_subscribed.load(Ordering::Relaxed) {
                subscribed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(subscribed, "pass {pass_no}: not subscribed within 5 s");
        let started = std::time::Instant::now();
        let r = tokio::time::timeout(Duration::from_secs(420), pass)
            .await
            .expect("stream should end at the next block")
            .unwrap()
            .unwrap();
        eprintln!(
            "pass {pass_no}: seen {} matched {} in {:?}",
            r.seen,
            r.matched,
            started.elapsed()
        );
        assert!(!state.health.mempool_subscribed.load(Ordering::Relaxed));
    }
}

async fn post_json(
    addr: std::net::SocketAddr,
    path: &str,
    body: serde_json::Value,
) -> (reqwest::StatusCode, serde_json::Value) {
    let r = reqwest::Client::new()
        .post(format!("http://{addr}{path}"))
        .header("Authorization", "Bearer test-token")
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = r.status();
    (status, r.json().await.unwrap_or(serde_json::Value::Null))
}

/// A UFVK of a fresh random spending key: a tab that has never been paid.
fn random_ufvk() -> String {
    use zcash_keys::keys::UnifiedSpendingKey;
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let network = zcash_protocol::consensus::Network::TestNetwork;
    UnifiedSpendingKey::from_seed(&network, &seed, zip32::AccountId::ZERO)
        .unwrap()
        .to_unified_full_viewing_key()
        .encode(&network)
        .unwrap()
}

/// A sweep destination unrelated to any tab: index 0 of the fixture account.
const SWEEP_RECIPIENT: &str = "utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp";

#[tokio::test]
#[ignore]
async fn sweep_rejects_when_notes_are_immature() {
    let (state, addr) = common::spawn_state_and_server().await;
    let birthday = recent_birthday(&state).await;
    let tab_id = uuid::Uuid::new_v4();
    let (status, _) = post_json(
        addr,
        "/v1/tabs",
        register_body(tab_id, &random_ufvk(), birthday, 2),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let (status, body) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/sweep"),
        serde_json::json!({ "recipient_address": SWEEP_RECIPIENT }),
    )
    .await;
    eprintln!("unsynced sweep: {status} {body}");
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    // Synced, the tab still has nothing spendable at the sweep depth.
    ztab_watcher::sync::sync_once(&state).await.unwrap();
    let (status, body) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/sweep"),
        serde_json::json!({ "recipient_address": SWEEP_RECIPIENT }),
    )
    .await;
    eprintln!("synced sweep: {status} {body}");
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(state.meta.get_sweep(tab_id).unwrap().is_none());
}

#[tokio::test]
#[ignore]
async fn broadcast_rejects_mismatched_pczt() {
    use base64::Engine;
    let (state, addr) = common::spawn_state_and_server().await;
    let tab_id = common::register_fixture_tab(&state, 2).await;
    ztab_watcher::sync::sync_once(&state).await.unwrap();
    // `mined_height_of` (used by GET /sweep) reads display-order txids correctly.
    assert_eq!(
        state
            .wallet
            .mined_height_of(common::FIXTURE_FUNDING_TXID)
            .unwrap(),
        Some(4_503_718)
    );

    let started = std::time::Instant::now();
    let (status, offer) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/sweep"),
        serde_json::json!({ "recipient_address": SWEEP_RECIPIENT, "memo": "ztab sweep" }),
    )
    .await;
    eprintln!(
        "sweep offer: {status} in {:?}, summary {}",
        started.elapsed(),
        offer["summary"]
    );
    assert_eq!(status, reqwest::StatusCode::OK, "{offer}");
    let s = &offer["summary"];
    let (inputs, output, fee) = (
        s["inputs_zat"].as_u64().unwrap(),
        s["output_zat"].as_u64().unwrap(),
        s["fee_zat"].as_u64().unwrap(),
    );
    assert!(inputs > 0 && fee > 0);
    assert_eq!(output + fee, inputs);
    let txid = s["txid"].as_str().unwrap();
    assert_eq!(txid.len(), 64);
    // The offered PCZT is what the summary describes.
    let pczt = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(offer["pczt_b64"].as_str().unwrap())
        .unwrap();
    assert_eq!(ztab_watcher::sweep::pczt_txid(&pczt).unwrap(), txid);
    let stored = state.meta.get_sweep(tab_id).unwrap().unwrap();
    assert_eq!(stored.txid, txid);
    assert_eq!(stored.broadcast_at, None);

    // A foreign PCZT (another, already-mined sweep) is never transmitted.
    let foreign = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sweep2.proved.pczt"),
    )
    .unwrap();
    let (status, body) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/broadcast"),
        serde_json::json!({
            "pczt_b64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(foreign)
        }),
    )
    .await;
    eprintln!("foreign broadcast: {status} {body}");
    assert_eq!(status, reqwest::StatusCode::CONFLICT);

    // The unsigned offer itself matches the txid but cannot be extracted: 422, not sent.
    let (status, body) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/broadcast"),
        serde_json::json!({ "pczt_b64": offer["pczt_b64"] }),
    )
    .await;
    eprintln!("unsigned broadcast: {status} {body}");
    assert_eq!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY);

    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    assert_eq!(tab.state, ztab_watcher::meta::TabState::Open);
    assert_eq!(
        state.meta.get_sweep(tab_id).unwrap().unwrap().broadcast_at,
        None
    );
    let r = reqwest::Client::new()
        .get(format!("http://{addr}/v1/tabs/{tab_id}/sweep"))
        .header("Authorization", "Bearer test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::OK);
    let st: serde_json::Value = r.json().await.unwrap();
    assert_eq!(st["state"], "open");
    assert_eq!(st["txid"], txid);
    assert_eq!(st["mined_height"], serde_json::Value::Null);
    assert_eq!(st["confirmations"], 0);
}

#[tokio::test]
#[ignore]
async fn node_lookup_finds_the_mined_spike_sweep_but_not_an_unbroadcast_one() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = common::testnet_config(tmp.path());
    let mut client = remote::connect(&cfg).await.unwrap();
    let read = |n: &str| {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(n),
        )
        .unwrap()
    };
    // The spike's sweep was mined on testnet.
    let mined = ztab_watcher::sweep::pczt_txid(&read("sweep.proved.pczt")).unwrap();
    assert!(ztab_watcher::sweep::node_knows_tx(&mut client, &mined)
        .await
        .unwrap());
    // A txid no node has seen.
    let unknown = "00".repeat(31) + "01";
    assert!(!ztab_watcher::sweep::node_knows_tx(&mut client, &unknown)
        .await
        .unwrap());
}

#[tokio::test]
#[ignore]
async fn get_tab_is_served_from_db_when_offline() {
    let (state, addr) = common::spawn_state_and_server().await;
    let tab_id = common::register_fixture_tab(&state, 2).await;
    let http = reqwest::Client::new();

    // Health needs no auth and, before any sync, reports no lag.
    let h = http
        .get(format!("http://{addr}/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(h.status(), 200);
    let j: serde_json::Value = h.json().await.unwrap();
    for k in [
        "tip_height",
        "synced_height",
        "mempool_subscribed",
        "lag_seconds",
        "network",
    ] {
        assert!(j.get(k).is_some(), "missing {k}");
    }
    assert!(j["lag_seconds"].is_null());
    assert_eq!(j["network"], "test");

    // Hold the client: a handler that touched it would hang.
    {
        let _guard = state.client.lock().await;
        let started = std::time::Instant::now();
        let g = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            http.get(format!("http://{addr}/v1/tabs/{tab_id}"))
                .header("Authorization", "Bearer test-token")
                .send(),
        )
        .await
        .expect("get_tab must not wait on the lightwalletd client")
        .unwrap();
        assert_eq!(g.status(), 200);
        let j: serde_json::Value = g.json().await.unwrap();
        assert_eq!(j["stale"], true);
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
    }

    ztab_watcher::sync::sync_once(&state).await.unwrap();
    let j: serde_json::Value = http
        .get(format!("http://{addr}/v1/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(j["lag_seconds"].is_number());
    assert!(j["tip_height"].as_u64().unwrap() > 0);
}

/// Prints the fixture payer's address for `ZTAB_TEST_SEED_HEX` (to fund it at the faucet);
/// see `tests/fixtures/README.md`. Offline, but ignored because it needs the env var.
#[test]
#[ignore = "needs ZTAB_TEST_SEED_HEX"]
fn fixture_payer_address() {
    let Some(seed_hex) = common::test_seed_hex() else {
        return;
    };
    let network = zcash_protocol::consensus::Network::TestNetwork;
    let usk = common::payer_usk(&seed_hex, &network);
    println!("payer address: {}", common::payer_address(&usk, &network));
}

/// The spec's success criterion, end to end on public testnet: a tab is registered with a
/// browser-made UFVK, a participant pays from a real wallet, the watcher reports the payment
/// in the mempool within 60 s, then mined, "paid" at 3 confirmations and sweepable at 10;
/// the watcher proves the sweep, the test signs it as the browser will, the watcher
/// broadcasts it and the sweep is mined. Needs a funded payer (`tests/fixtures/README.md`)
/// and 8–15 minutes:
/// `ZTAB_TEST_SEED_HEX=… cargo test --test testnet_live full_tab_lifecycle -- --ignored --nocapture`
#[tokio::test]
#[ignore = "needs ZTAB_TEST_SEED_HEX with >= 0.05 TAZ and ~12 minutes"]
async fn full_tab_lifecycle_on_testnet() {
    use std::time::{Duration, Instant};
    const PAYMENT_ZAT: u64 = 2_000_000;
    let started = Instant::now();
    let Some(seed_hex) = common::test_seed_hex() else {
        return;
    };
    let (state, addr) = common::spawn_state_and_server().await;
    let mut timings: Vec<(&str, Duration)> = vec![];
    let network = state.cfg.network;

    // The service's mempool loop, subscribed before the payment goes out.
    tokio::spawn(ztab_watcher::mempool::run_mempool_loop(state.clone()));

    // 1. Alice's browser: random tab seed -> USK -> UFVK (what the WASM module will do).
    let mut tab_seed = [0u8; 32];
    let mut rng = ztab_watcher::rng::OsRng;
    rand::Rng::fill_bytes(&mut rng, &mut tab_seed);
    let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(
        &network,
        &tab_seed,
        zip32::AccountId::ZERO,
    )
    .unwrap();
    let ufvk = usk.to_unified_full_viewing_key().encode(&network).unwrap();
    let tip = common::tip(&state).await;
    let tab_id = uuid::Uuid::new_v4();
    let reg = common::post(&addr, "/v1/tabs", register_body(tab_id, &ufvk, tip, 2)).await;
    assert_eq!(reg.status(), 201);
    let addresses: Vec<String> = reg.json::<serde_json::Value>().await.unwrap()["addresses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["address"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(addresses.len(), 2);
    ztab_watcher::sync::sync_once(&state).await.unwrap();
    eprintln!("tab {tab_id} registered at birthday {tip}");

    // 2. Participant 1 pays 0.02 TAZ from the fixture wallet.
    let payer = common::FixtureWallet::restore(&seed_hex, &state.cfg).await;
    let (total, mut spendable) = payer.balance_zat();
    eprintln!(
        "payer {} balance: total {total} zat, spendable {spendable} zat",
        payer.address()
    );
    assert!(
        total >= PAYMENT_ZAT + 100_000,
        "the fixture payer needs >= 0.021 TAZ; refill it (tests/fixtures/README.md)"
    );
    // A fresh faucet note needs 10 confirmations before it can be spent.
    let wait_funds = Instant::now();
    while spendable < PAYMENT_ZAT + 100_000 {
        assert!(
            wait_funds.elapsed() < Duration::from_secs(600),
            "payer funds did not mature within 10 minutes"
        );
        tokio::time::sleep(Duration::from_secs(15)).await;
        payer.sync().await;
        spendable = payer.balance_zat().1;
    }
    let mut ready = false;
    for _ in 0..30 {
        if state
            .health
            .mempool_subscribed
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(ready, "mempool stream did not subscribe");
    let building = Instant::now();
    let txid = payer.send(&addresses[1], PAYMENT_ZAT, "ztab e2e").await;
    // Timings below count from the broadcast.
    let sent_at = Instant::now();
    timings.push(("payment built and sent", building.elapsed()));
    eprintln!(
        "payment {txid} broadcast ({:?} to sync, build and send)",
        building.elapsed()
    );

    // 3. "In the mempool" within 60 s, from the mempool stream alone (no block sync).
    loop {
        let facts = common::get_tab(&addr, tab_id).await;
        let p1 = &facts["participants"][1];
        if p1["status_facts"]["mempool_zat"].as_u64().unwrap() == PAYMENT_ZAT {
            assert_eq!(p1["payments"][0]["txid"], txid.as_str());
            assert_eq!(facts["participants"][0]["status_facts"]["mempool_zat"], 0);
            break;
        }
        assert_eq!(
            p1["status_facts"]["confirmed_zat"], 0,
            "payment {txid} was mined before the mempool sighting was reported"
        );
        assert!(
            sent_at.elapsed() < Duration::from_secs(60),
            "payment {txid} not seen in the mempool within 60 s: {facts}"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    timings.push(("mempool sighting", sent_at.elapsed()));
    eprintln!("seen in mempool after {:?}", sent_at.elapsed());

    // 4. Mined, then paid at 3 confirmations (the sweep is refused until 10), sweepable at 10.
    let facts = common::wait_until(
        &state,
        &addr,
        tab_id,
        |f| f["participants"][1]["status_facts"]["confirmed_zat"] == PAYMENT_ZAT,
        600,
    )
    .await;
    timings.push(("mined", sent_at.elapsed()));
    let p1 = &facts["participants"][1];
    assert_eq!(p1["status_facts"]["mempool_zat"], 0);
    assert_eq!(p1["payments"].as_array().unwrap().len(), 1);
    assert_eq!(p1["status_facts"]["transparent_source"], false);
    eprintln!(
        "mined at {} after {:?}",
        p1["payments"][0]["mined_height"],
        sent_at.elapsed()
    );
    let mined_height = p1["payments"][0]["mined_height"].as_u64().unwrap();
    common::wait_until(
        &state,
        &addr,
        tab_id,
        |f| {
            f["participants"][1]["status_facts"]["best_confirmations"]
                .as_u64()
                .unwrap()
                >= 3
        },
        600,
    )
    .await;
    timings.push(("3 confirmations (paid)", sent_at.elapsed()));
    eprintln!("paid (3 confirmations) after {:?}", sent_at.elapsed());
    let (status, body) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/sweep"),
        serde_json::json!({ "recipient_address": payer.address() }),
    )
    .await;
    eprintln!("early sweep: {status} {body}");
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    common::wait_until(
        &state,
        &addr,
        tab_id,
        |f| {
            f["participants"][1]["status_facts"]["best_confirmations"]
                .as_u64()
                .unwrap()
                >= 10
        },
        900,
    )
    .await;
    timings.push(("10 confirmations (sweepable)", sent_at.elapsed()));
    eprintln!("10 confirmations after {:?}", sent_at.elapsed());

    // 5. Sweep: the watcher proves, the test signs like the browser, the watcher broadcasts.
    let offer = common::post(
        &addr,
        &format!("/v1/tabs/{tab_id}/sweep"),
        serde_json::json!({"recipient_address": payer.address(), "memo": "ztab sweep"}),
    )
    .await;
    assert_eq!(offer.status(), 200);
    let offer: serde_json::Value = offer.json().await.unwrap();
    let s = &offer["summary"];
    eprintln!("sweep offer: {s}");
    assert_eq!(s["inputs_zat"], PAYMENT_ZAT);
    assert_eq!(
        s["output_zat"].as_u64().unwrap() + s["fee_zat"].as_u64().unwrap(),
        PAYMENT_ZAT
    );
    let sweep_txid = s["txid"].as_str().unwrap().to_string();
    let signed_b64 = common::sign_like_browser(offer["pczt_b64"].as_str().unwrap(), &usk);
    let bc = common::post(
        &addr,
        &format!("/v1/tabs/{tab_id}/broadcast"),
        serde_json::json!({ "pczt_b64": signed_b64 }),
    )
    .await;
    let bc_status = bc.status();
    let bc_body: serde_json::Value = bc.json().await.unwrap_or_default();
    eprintln!("broadcast: {bc_status} {bc_body}");
    assert_eq!(bc_status, 200);
    let swept_at = Instant::now();
    assert_eq!(common::get_tab(&addr, tab_id).await["state"], "sweeping");
    // A second sweep while this one is pending is refused.
    let (status, _) = post_json(
        addr,
        &format!("/v1/tabs/{tab_id}/sweep"),
        serde_json::json!({ "recipient_address": payer.address() }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);

    // 6. The sweep is mined (`GET /sweep` reports its height; `closed` follows at 10).
    let status = loop {
        if let Err(e) = ztab_watcher::sync::sync_once(&state).await {
            eprintln!("watcher sync pass failed (retrying): {e}");
        }
        let status = common::get(&addr, &format!("/v1/tabs/{tab_id}/sweep")).await;
        assert_eq!(status["txid"], sweep_txid.as_str());
        if status["mined_height"].is_u64() {
            break status;
        }
        assert!(
            swept_at.elapsed() < Duration::from_secs(600),
            "sweep {sweep_txid} not mined within 10 minutes: {status}"
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
    };
    timings.push(("sweep mined (after broadcast)", swept_at.elapsed()));
    eprintln!("sweep status: {status}");
    assert!(status["mined_height"].as_u64().unwrap() > mined_height);
    assert!(matches!(
        status["state"].as_str(),
        Some("sweeping" | "closed")
    ));
    // The funds are back in the payer's wallet.
    payer.sync().await;
    assert!(matches!(
        payer.transaction_mined_height(&sweep_txid),
        Some(Some(_))
    ));
    eprintln!(
        "payer balance after the sweep: total {} zat",
        payer.balance_zat().0
    );

    eprintln!("payment {txid}, sweep {sweep_txid}");
    for (what, t) in &timings {
        eprintln!("  {what}: {t:.1?}");
    }
    eprintln!("total wall time: {:.1?}", started.elapsed());
}
