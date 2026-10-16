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
