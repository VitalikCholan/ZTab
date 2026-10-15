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
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), "x", 10)
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
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), "x", 10)
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
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), "x", 10)
        .unwrap();
    for s in [TabState::Sweeping, TabState::Closed, TabState::Abandoned] {
        // The stored state decides, even when the caller's copy still says open.
        state.meta.set_tab_state(tab.tab_id, s).unwrap();
        assert_eq!(tab.state, TabState::Open);
        let r = create_proved_pczt(&state, &tab, "utest1x", None).await;
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
    state.meta.put_sweep(tab.tab_id, &offered, "x", 10).unwrap();
    // Held exactly as an in-flight broadcast (or offer) holds it.
    let in_flight = state.sweep_locks.try_acquire(tab.tab_id).unwrap();
    let r = create_proved_pczt(&state, &tab, "utest1x", None).await;
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
    state.meta.put_sweep(tab.tab_id, &txid, "x", 1_000).unwrap();
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
        .put_sweep(tab.tab_id, &fixture_txid("sweep2.proved.pczt"), "x", 10)
        .unwrap();
    assert!(ztab_watcher::sweep::pending_sweep(&state, tab.tab_id)
        .unwrap()
        .is_none());
    // Offer for the stored, unmined transaction: pending.
    state.meta.put_sweep(tab.tab_id, txid, "x", 10).unwrap();
    let pending = ztab_watcher::sweep::pending_sweep(&state, tab.tab_id)
        .unwrap()
        .unwrap();
    assert_eq!(pending.txid, txid);
}
