//! Offline tests of the sweep guards: nothing here reaches lightwalletd, because every
//! request is refused before a transaction would be sent.
mod common;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use std::sync::atomic::Ordering;
use ztab_watcher::{
    error::WatcherError,
    meta::TabState,
    sweep::{broadcast_signed, create_proved_pczt, pczt_txid, sweep_status},
};

fn fixture_b64(name: &str) -> String {
    B64.encode(
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
        )
        .unwrap(),
    )
}

fn fixture_txid(name: &str) -> String {
    pczt_txid(&B64.decode(fixture_b64(name)).unwrap()).unwrap()
}

async fn fixture_tab(state: &ztab_watcher::http::AppState) -> ztab_watcher::meta::TabRow {
    common::import_fixture_tab_offline(state, 2).await;
    state
        .meta
        .get_tab(common::fixture_tab_id())
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn broadcast_without_offer_or_with_foreign_pczt_is_conflict() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.signed.pczt")).await;
    assert!(matches!(r, Err(WatcherError::Conflict(_))), "{r:?}");

    state
        .meta
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), 10)
        .unwrap();
    let r = broadcast_signed(&state, &tab, &fixture_b64("sweep2.proved.pczt")).await;
    assert!(matches!(r, Err(WatcherError::Conflict(_))), "{r:?}");
    assert_eq!(
        state
            .meta
            .get_sweep(tab.tab_id)
            .unwrap()
            .unwrap()
            .broadcast_at,
        None
    );
}

#[tokio::test]
async fn unsigned_or_garbage_pczt_is_unprocessable() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    state
        .meta
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), 10)
        .unwrap();
    // Matches the offer but lacks signatures: extraction fails, nothing is sent. The 422
    // bodies are fixed phrases, never library Debug output.
    let fixed_phrase = |r: &Result<String, WatcherError>| matches!(r, Err(WatcherError::Unprocessable(m)) if !m.contains(['{', '}']));
    for submitted in [
        fixture_b64("sweep.proved.pczt"),
        "not base64!".to_string(),
        B64.encode(b"PCZTjunk"),
    ] {
        let r = broadcast_signed(&state, &tab, &submitted).await;
        assert!(fixed_phrase(&r), "{r:?}");
    }
    let tab = state.meta.get_tab(tab.tab_id).unwrap().unwrap();
    assert_eq!(tab.state, TabState::Open);
}

#[tokio::test]
async fn sweep_and_broadcast_refuse_a_tab_that_is_not_open() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    state
        .meta
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), 10)
        .unwrap();
    for s in [TabState::Sweeping, TabState::Abandoned] {
        // The stored state decides, even when the caller's copy still says open.
        state.meta.set_tab_state(tab.tab_id, s).unwrap();
        assert_eq!(tab.state, TabState::Open);
        let r = create_proved_pczt(&state, &tab, "utest1x").await;
        assert!(matches!(r, Err(WatcherError::Conflict(_))), "{s:?}: {r:?}");
        let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.signed.pczt")).await;
        assert!(matches!(r, Err(WatcherError::Conflict(_))), "{s:?}: {r:?}");
    }
}

#[tokio::test]
async fn offer_and_broadcast_are_refused_while_a_sweep_request_is_in_flight() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    let offered = fixture_txid("sweep.proved.pczt");
    state.meta.put_sweep(tab.tab_id, &offered, 10).unwrap();
    // Held exactly as an in-flight broadcast (or offer) holds it.
    let in_flight = state.sweep_locks.try_acquire(tab.tab_id).unwrap();
    let r = create_proved_pczt(&state, &tab, "utest1x").await;
    assert!(matches!(r, Err(WatcherError::Conflict(_))), "{r:?}");
    let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.signed.pczt")).await;
    assert!(matches!(r, Err(WatcherError::Conflict(_))), "{r:?}");
    // The offer the in-flight request works on is untouched.
    let row = state.meta.get_sweep(tab.tab_id).unwrap().unwrap();
    assert_eq!(
        (row.txid.as_str(), row.broadcast_at),
        (offered.as_str(), None)
    );
    // Status waits for the lock instead of failing.
    let waiting = {
        let (state, tab) = (state.clone(), tab.clone());
        tokio::spawn(async move { sweep_status(&state, &tab).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!waiting.is_finished());
    drop(in_flight);
    let st = waiting.await.unwrap().unwrap();
    assert_eq!(st.txid.as_deref(), Some(offered.as_str()));
    // Released: other tabs were never affected, and this tab's lock is free again.
    drop(state.sweep_locks.try_acquire(tab.tab_id).unwrap());
}

#[tokio::test]
async fn unmined_sweep_reopens_the_tab_once_scanned_past_expiry() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    let st = sweep_status(&state, &tab).await.unwrap();
    assert_eq!(
        (st.state, st.txid, st.confirmations),
        (TabState::Open, None, 0)
    );

    let txid = fixture_txid("sweep.proved.pczt");
    state.meta.put_sweep(tab.tab_id, &txid, 1_000).unwrap();
    state.meta.mark_broadcast(tab.tab_id, &txid).unwrap();
    state
        .meta
        .set_tab_state(tab.tab_id, TabState::Sweeping)
        .unwrap();
    let tab = state.meta.get_tab(tab.tab_id).unwrap().unwrap();
    state.health.tip_height.store(1_005, Ordering::Relaxed);
    state.health.synced_height.store(1_000, Ordering::Relaxed);
    let st = sweep_status(&state, &tab).await.unwrap();
    assert_eq!(st.state, TabState::Sweeping);
    assert_eq!(st.txid.as_deref(), Some(txid.as_str()));
    assert_eq!((st.mined_height, st.confirmations), (None, 0));

    state.health.synced_height.store(1_001, Ordering::Relaxed);
    let st = sweep_status(&state, &tab).await.unwrap();
    assert_eq!(st.state, TabState::Open);
    assert_eq!(
        state.meta.get_tab(tab.tab_id).unwrap().unwrap().state,
        TabState::Open
    );
}

#[tokio::test]
async fn pending_sweep_is_an_offer_the_wallet_holds_unmined() {
    use zcash_primitives::transaction::Transaction;
    use zcash_protocol::consensus::{BlockHeight, BranchId};
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    assert!(ztab_watcher::sweep::pending_sweep(&state, tab.tab_id)
        .unwrap()
        .is_none());
    // Stand-in for an extracted, not-yet-mined sweep: a fixture transaction of the tab's
    // account stored without a mined height, exactly as extraction stores a sweep.
    let txid = common::FIXTURE_FUNDING_TXID;
    let network = state.wallet.network();
    let tx = Transaction::read(
        &common::fixture_rawtx(txid)[..],
        BranchId::for_height(&network, BlockHeight::from_u32(4_503_718)),
    )
    .unwrap();
    zcash_client_backend::data_api::wallet::decrypt_and_store_transaction(
        &network,
        &mut *state.wallet.db(),
        &tx,
        None,
    )
    .unwrap();
    assert_eq!(
        state.wallet.transaction_mined_height(txid).unwrap(),
        Some(None)
    );
    // Offer for an unknown transaction: not pending.
    state
        .meta
        .put_sweep(tab.tab_id, &fixture_txid("sweep2.proved.pczt"), 10)
        .unwrap();
    assert!(ztab_watcher::sweep::pending_sweep(&state, tab.tab_id)
        .unwrap()
        .is_none());
    // Offer for the stored, unmined transaction: pending.
    state.meta.put_sweep(tab.tab_id, txid, 10).unwrap();
    let pending = ztab_watcher::sweep::pending_sweep(&state, tab.tab_id)
        .unwrap()
        .unwrap();
    assert_eq!(pending.txid, txid);
}

#[tokio::test]
async fn sweep_request_with_a_memo_is_refused() {
    use tower::ServiceExt;
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    let app = ztab_watcher::http::router(state.clone());
    let req = axum::http::Request::builder()
        .method("POST")
        .uri(format!("/v1/tabs/{}/sweep", tab.tab_id))
        .header("Authorization", "Bearer test-token")
        .header("Content-Type", "application/json")
        .body(axum::body::Body::from(
            serde_json::json!({ "recipient_address": "utest1x", "memo": "hi" }).to_string(),
        ))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), 422);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("memo is not supported"));
    assert!(state.meta.get_sweep(tab.tab_id).unwrap().is_none());
}

#[tokio::test]
async fn a_closed_tab_passes_the_state_gate_for_a_new_sweep() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    state
        .meta
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), 10)
        .unwrap();
    state
        .meta
        .set_tab_state(tab.tab_id, TabState::Closed)
        .unwrap();
    // Past the state check: the next refusal is about the request itself, not the state.
    let r = create_proved_pczt(&state, &tab, "utest1x").await;
    assert!(matches!(r, Err(WatcherError::Unprocessable(_))), "{r:?}");
    let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.proved.pczt")).await;
    assert!(matches!(r, Err(WatcherError::Unprocessable(_))), "{r:?}");
    assert_eq!(
        state.meta.get_tab(tab.tab_id).unwrap().unwrap().state,
        TabState::Closed
    );
}

#[tokio::test]
async fn a_repeated_broadcast_of_the_sent_sweep_returns_its_txid() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    let offered = fixture_txid("sweep.proved.pczt");
    state.meta.put_sweep(tab.tab_id, &offered, 10).unwrap();
    state.meta.mark_broadcast(tab.tab_id, &offered).unwrap();
    for s in [TabState::Sweeping, TabState::Closed] {
        state.meta.set_tab_state(tab.tab_id, s).unwrap();
        // Nothing is sent (the offline client would fail): the earlier success is repeated.
        let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.signed.pczt")).await;
        assert_eq!(r.unwrap(), offered, "{s:?}");
        // Another transaction is still a mismatch.
        let r = broadcast_signed(&state, &tab, &fixture_b64("sweep2.proved.pczt")).await;
        assert!(matches!(r, Err(WatcherError::Conflict(_))), "{s:?}: {r:?}");
    }
    // Open again (the sweep expired): the old offer cannot be reused.
    state
        .meta
        .set_tab_state(tab.tab_id, TabState::Open)
        .unwrap();
    let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.signed.pczt")).await;
    assert!(matches!(r, Err(WatcherError::Conflict(_))), "{r:?}");
}

#[tokio::test]
async fn a_sync_pass_closes_a_sweeping_tab_whose_sweep_is_deep_enough() {
    use zcash_primitives::transaction::Transaction;
    use zcash_protocol::consensus::{BlockHeight, BranchId};
    use ztab_watcher::sweep::advance_sweeping_tabs;
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    // Stand-in for a mined sweep: a fixture transaction of the tab's account stored with
    // its mined height (4503718).
    let txid = common::FIXTURE_FUNDING_TXID;
    let mined = 4_503_718;
    let network = state.wallet.network();
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
    assert_eq!(state.wallet.mined_height_of(txid).unwrap(), Some(mined));
    state.meta.put_sweep(tab.tab_id, txid, mined + 40).unwrap();
    state.meta.mark_broadcast(tab.tab_id, txid).unwrap();
    state
        .meta
        .set_tab_state(tab.tab_id, TabState::Sweeping)
        .unwrap();
    let stored = || state.meta.get_tab(tab.tab_id).unwrap().unwrap().state;

    // 9 confirmations: still sweeping.
    state.health.tip_height.store(mined + 8, Ordering::Relaxed);
    state
        .health
        .synced_height
        .store(mined + 8, Ordering::Relaxed);
    assert_eq!(advance_sweeping_tabs(&state).unwrap(), 0);
    assert_eq!(stored(), TabState::Sweeping);

    // 10 confirmations, but a sweep request holds the tab: skipped, not waited for.
    state.health.tip_height.store(mined + 9, Ordering::Relaxed);
    state
        .health
        .synced_height
        .store(mined + 9, Ordering::Relaxed);
    let busy = state.sweep_locks.try_acquire(tab.tab_id).unwrap();
    assert_eq!(advance_sweeping_tabs(&state).unwrap(), 0);
    assert_eq!(stored(), TabState::Sweeping);
    drop(busy);

    // One pass later: closed, with no GET /sweep involved.
    assert_eq!(advance_sweeping_tabs(&state).unwrap(), 1);
    assert_eq!(stored(), TabState::Closed);
}
