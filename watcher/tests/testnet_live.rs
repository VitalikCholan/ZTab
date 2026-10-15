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
