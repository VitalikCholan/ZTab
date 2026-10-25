//! Offline tests of tab registration storage and fact reads.
mod common;
use std::time::Duration;
use tower::ServiceExt;

#[tokio::test]
async fn registration_stores_participant_addresses_and_backfills_them() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 3).await;
    let tab_id = common::fixture_tab_id();
    let tab = state.meta.get_tab(tab_id).unwrap().unwrap();
    let account = ztab_watcher::wallet::account_uuid(tab.account_uuid);
    let derived = state.wallet.participant_addresses(account, 3).unwrap();
    assert_eq!(state.meta.tab_addresses(tab_id).unwrap(), derived);

    // A tab whose rows are missing (registered before the table existed) is backfilled by
    // the idempotent re-registration, which needs no lightwalletd.
    rusqlite::Connection::open(state.cfg.data_dir.join("ztab.sqlite"))
        .unwrap()
        .execute("DELETE FROM tab_addresses", [])
        .unwrap();
    assert!(state.meta.tab_addresses(tab_id).unwrap().is_empty());
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/v1/tabs")
        .header("Authorization", "Bearer test-token")
        .header("Content-Type", "application/json")
        .body(axum::body::Body::from(
            serde_json::json!({
                "tab_id": tab_id,
                "ufvk": common::FIXTURE_UFVK,
                "birthday": common::FIXTURE_BIRTHDAY,
                "participants_count": 3,
            })
            .to_string(),
        ))
        .unwrap();
    let resp = ztab_watcher::http::router(state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["addresses"][2]["address"], derived[2].1.as_str());
    assert_eq!(state.meta.tab_addresses(tab_id).unwrap(), derived);
}

#[tokio::test]
async fn tab_facts_do_not_wait_on_the_wallet_write_lock() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    let tab = state
        .meta
        .get_tab(common::fixture_tab_id())
        .unwrap()
        .unwrap();
    // Held exactly as a running scan holds it: a fact read that needed it would block.
    let scanning = state.wallet.db();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = {
        let state = state.clone();
        std::thread::spawn(move || {
            let facts = ztab_watcher::facts::tab_facts(
                &state.wallet,
                &state.meta,
                &state.cfg,
                &tab,
                0,
                0,
                true,
            );
            let _ = tx.send(facts.map(|f| f.participants));
        })
    };
    let participants = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("tab_facts must not take the wallet db() lock")
        .unwrap();
    drop(scanning);
    reader.join().unwrap();
    assert_eq!(participants.len(), 2);
    assert!(participants[1].address.starts_with("utest1"));
}

async fn call(
    state: &ztab_watcher::http::AppState,
    method: &str,
    uri: &str,
    token: bool,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let mut b = axum::http::Request::builder().method(method).uri(uri);
    if token {
        b = b.header("Authorization", "Bearer test-token");
    }
    let req = match body {
        Some(v) => b
            .header("Content-Type", "application/json")
            .body(axum::body::Body::from(v.to_string())),
        None => b.body(axum::body::Body::empty()),
    }
    .unwrap();
    let resp = ztab_watcher::http::router(state.clone())
        .oneshot(req)
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

#[tokio::test]
async fn pause_and_resume_tab() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    let id = common::fixture_tab_id();
    let uri = format!("/v1/tabs/{id}/active");
    let get = format!("/v1/tabs/{id}");

    let (s, tab) = call(&state, "GET", &get, true, None).await;
    assert_eq!((s, &tab["active"]), (200, &serde_json::json!(true)));

    let off = Some(serde_json::json!({"active": false}));
    assert_eq!(call(&state, "PUT", &uri, true, off.clone()).await.0, 204);
    let (_, tab) = call(&state, "GET", &get, true, None).await;
    assert_eq!(tab["active"], false);
    assert_eq!(tab["state"], "open");
    assert!(state.meta.open_tabs().unwrap().is_empty());

    let on = Some(serde_json::json!({"active": true}));
    assert_eq!(call(&state, "PUT", &uri, true, on.clone()).await.0, 204);
    let (_, tab) = call(&state, "GET", &get, true, None).await;
    assert_eq!(tab["active"], true);
    assert_eq!(state.meta.open_tabs().unwrap().len(), 1);

    let unknown = format!("/v1/tabs/{}/active", uuid::Uuid::new_v4());
    assert_eq!(call(&state, "PUT", &unknown, true, on.clone()).await.0, 404);
    assert_eq!(
        call(&state, "PUT", &uri, true, Some(serde_json::json!({})))
            .await
            .0,
        422
    );
    assert_eq!(call(&state, "PUT", &uri, false, off).await.0, 401);
}

/// Stores the fixture transactions of the account as a scan would, each at its mined height.
fn store_fixture_txs(state: &ztab_watcher::http::AppState) {
    use zcash_primitives::transaction::Transaction;
    use zcash_protocol::consensus::{BlockHeight, BranchId};
    let network = state.wallet.network();
    for (txid, mined) in [
        (common::FIXTURE_INDEX1_SELF_SEND_TXID, 4_503_710),
        (common::FIXTURE_FUNDING_TXID, 4_503_718),
        (common::FIXTURE_INDEX0_PAYMENT_TXID, 4_503_742),
    ] {
        let tx = Transaction::read(
            &common::fixture_rawtx(txid)[..],
            BranchId::for_height(&network, BlockHeight::from_u32(mined)),
        )
        .unwrap();
        zcash_client_backend::data_api::wallet::decrypt_and_store_transaction(
            &network,
            &mut *state.wallet.db(),
            &tx,
            Some(BlockHeight::from_u32(mined)),
        )
        .unwrap();
    }
}

/// (value, mined height) of the account's notes that no stored transaction spends, read
/// straight from the three pools' notes and spends tables.
fn unspent_notes_by_sql(state: &ztab_watcher::http::AppState) -> Vec<(u64, u32)> {
    let conn = state.wallet.read_conn();
    let mut out = Vec::new();
    for pool in ["sapling", "orchard", "ironwood"] {
        let sql = format!(
            "SELECT n.value, t.mined_height FROM {pool}_received_notes n
               JOIN transactions t ON t.id_tx = n.transaction_id
          LEFT JOIN {pool}_received_note_spends s ON s.{pool}_received_note_id = n.id
              WHERE s.{pool}_received_note_id IS NULL AND t.mined_height IS NOT NULL"
        );
        let mut st = conn.prepare(&sql).unwrap();
        let rows = st
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u32))
            })
            .unwrap();
        out.extend(rows.map(Result::unwrap));
    }
    out
}

#[tokio::test]
async fn balance_reflects_unspent_notes_and_confirmations() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    store_fixture_txs(&state);
    let id = common::fixture_tab_id();
    let notes = unspent_notes_by_sql(&state);
    assert!(notes.len() >= 2, "fixture has unspent notes: {notes:?}");
    // Tip chosen so the oldest unspent note is deep and the youngest is not.
    let (oldest, youngest) = (
        notes.iter().map(|n| n.1).min().unwrap(),
        notes.iter().map(|n| n.1).max().unwrap(),
    );
    assert!(youngest > oldest + 1, "{notes:?}");
    let tip = youngest + 4; // youngest has 5 confirmations
    state
        .health
        .tip_height
        .store(tip, std::sync::atomic::Ordering::Relaxed);
    let deep = |h: u32| tip - h + 1 >= 10;
    let want_spendable: u64 = notes.iter().filter(|n| deep(n.1)).map(|n| n.0).sum();
    let want_pending: u64 = notes.iter().filter(|n| !deep(n.1)).map(|n| n.0).sum();
    assert!(want_spendable > 0 && want_pending > 0, "{notes:?}");
    let unspent: Vec<_> = notes
        .iter()
        .map(|n| ztab_watcher::facts::UnspentNote {
            value_zat: n.0,
            mined_height: Some(n.1),
        })
        .collect();
    let want_sweepable = ztab_watcher::facts::plan_sweep(&unspent, tip, 10).output_zat;

    let (s, tab) = call(&state, "GET", &format!("/v1/tabs/{id}"), true, None).await;
    assert_eq!(s, 200);
    assert_eq!(
        tab["balance"],
        serde_json::json!({
            "spendable_zat": want_spendable,
            "pending_zat": want_pending,
            "swept_zat": 0,
            "min_unspent_confirmations": 5,
            "sweepable_zat": want_sweepable,
        })
    );

    // No unspent mined notes at a tip below them: nothing is deep and the minimum is 0.
    state
        .health
        .tip_height
        .store(0, std::sync::atomic::Ordering::Relaxed);
    let (_, tab) = call(&state, "GET", &format!("/v1/tabs/{id}"), true, None).await;
    assert_eq!(tab["balance"]["spendable_zat"], 0);
    assert_eq!(tab["balance"]["sweepable_zat"], 0);
    assert_eq!(tab["balance"]["min_unspent_confirmations"], 0);
}

#[tokio::test]
async fn a_spend_by_an_expired_unmined_transaction_gives_the_note_back() {
    use zcash_primitives::transaction::Transaction;
    use zcash_protocol::consensus::{BlockHeight, BranchId};
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    let network = state.wallet.network();
    // The self-send is mined (two notes of the account); the funding transaction stands in
    // for a stored, unmined sweep (expiry height 4503834).
    for (txid, mined) in [
        (common::FIXTURE_INDEX1_SELF_SEND_TXID, Some(4_503_710)),
        (common::FIXTURE_FUNDING_TXID, None),
    ] {
        let tx = Transaction::read(
            &common::fixture_rawtx(txid)[..],
            BranchId::for_height(&network, BlockHeight::from_u32(4_503_718)),
        )
        .unwrap();
        zcash_client_backend::data_api::wallet::decrypt_and_store_transaction(
            &network,
            &mut *state.wallet.db(),
            &tx,
            mined.map(BlockHeight::from_u32),
        )
        .unwrap();
    }
    // Record the spend as a scan of the sweep would: it spends the 0.1 TAZ note.
    let expiry = {
        let conn = rusqlite::Connection::open(state.cfg.data_dir.join("wallet.sqlite")).unwrap();
        let (tx_id, expiry): (i64, i64) = conn
            .query_row(
                "SELECT id_tx, expiry_height FROM transactions WHERE mined_height IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let n = conn
            .execute(
                "INSERT INTO ironwood_received_note_spends (ironwood_received_note_id, transaction_id)
                 SELECT id, ?1 FROM ironwood_received_notes WHERE value = 10000000",
                [tx_id],
            )
            .unwrap();
        assert_eq!(n, 1);
        expiry as u32
    };
    let tab = state
        .meta
        .get_tab(common::fixture_tab_id())
        .unwrap()
        .unwrap();
    let values = |tip: u32| {
        let mut v: Vec<u64> =
            ztab_watcher::facts::unspent_notes(&state.wallet, tab.account_uuid, tip)
                .unwrap()
                .iter()
                .map(|n| n.value_zat)
                .collect();
        v.sort();
        v
    };
    // Unexpired and unmined (it can still be mined next block): its inputs stay spent.
    assert!(!values(expiry - 1).contains(&10_000_000));
    // Expired without being mined (the tip reached its expiry height): the note is spendable again.
    assert!(values(expiry).contains(&10_000_000));
}

#[tokio::test]
async fn mempool_payments_are_pending_and_never_spendable() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    store_fixture_txs(&state);
    let id = common::fixture_tab_id();
    let tip = 4_503_742 + 4;
    state
        .health
        .tip_height
        .store(tip, std::sync::atomic::Ordering::Relaxed);
    let uri = format!("/v1/tabs/{id}");
    let (_, before) = call(&state, "GET", &uri, true, None).await;
    state
        .meta
        .upsert_sighting(
            &ztab_watcher::meta::Sighting {
                txid: "ab".repeat(32),
                participant_index: 1,
                value_zat: 7_000,
                first_seen_at: ztab_watcher::meta::rfc3339(time::OffsetDateTime::now_utc())
                    .unwrap(),
            },
            id,
        )
        .unwrap();
    let (_, after) = call(&state, "GET", &uri, true, None).await;
    let n = |v: &serde_json::Value, k: &str| v["balance"][k].as_u64().unwrap();
    assert_eq!(n(&after, "pending_zat"), n(&before, "pending_zat") + 7_000);
    assert_eq!(n(&after, "spendable_zat"), n(&before, "spendable_zat"));
    assert_eq!(
        after["balance"]["min_unspent_confirmations"],
        before["balance"]["min_unspent_confirmations"]
    );
}
