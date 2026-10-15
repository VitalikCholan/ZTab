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
    // Matches the offer but lacks signatures: extraction fails, nothing is sent.
    let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.proved.pczt")).await;
    assert!(matches!(r, Err(WatcherError::Unprocessable(_))), "{r:?}");
    let r = broadcast_signed(&state, &tab, "not base64!").await;
    assert!(matches!(r, Err(WatcherError::Unprocessable(_))), "{r:?}");
    let r = broadcast_signed(&state, &tab, &B64.encode(b"PCZTjunk")).await;
    assert!(matches!(r, Err(WatcherError::Unprocessable(_))), "{r:?}");
    let tab = state.meta.get_tab(tab.tab_id).unwrap().unwrap();
    assert_eq!(tab.state, TabState::Open);
}

#[tokio::test]
async fn sweep_and_broadcast_refuse_a_tab_that_is_not_open() {
    let state = common::offline_state().await;
    let mut tab = fixture_tab(&state).await;
    state
        .meta
        .put_sweep(tab.tab_id, &fixture_txid("sweep.proved.pczt"), "x", 10)
        .unwrap();
    for s in [TabState::Sweeping, TabState::Closed, TabState::Abandoned] {
        tab.state = s;
        let r = create_proved_pczt(&state, &tab, "utest1x", None).await;
        assert!(matches!(r, Err(WatcherError::Conflict(_))), "{s:?}: {r:?}");
        let r = broadcast_signed(&state, &tab, &fixture_b64("sweep.signed.pczt")).await;
        assert!(matches!(r, Err(WatcherError::Conflict(_))), "{s:?}: {r:?}");
    }
}

#[tokio::test]
async fn unmined_sweep_reopens_the_tab_once_scanned_past_expiry() {
    let state = common::offline_state().await;
    let tab = fixture_tab(&state).await;
    let st = sweep_status(&state, &tab).unwrap();
    assert_eq!(
        (st.state, st.txid, st.confirmations),
        (TabState::Open, None, 0)
    );

    let txid = fixture_txid("sweep.proved.pczt");
    state.meta.put_sweep(tab.tab_id, &txid, "x", 1_000).unwrap();
    state.meta.mark_broadcast(tab.tab_id).unwrap();
    state
        .meta
        .set_tab_state(tab.tab_id, TabState::Sweeping)
        .unwrap();
    let tab = state.meta.get_tab(tab.tab_id).unwrap().unwrap();
    state.health.tip_height.store(1_005, Ordering::Relaxed);
    state.health.synced_height.store(1_000, Ordering::Relaxed);
    let st = sweep_status(&state, &tab).unwrap();
    assert_eq!(st.state, TabState::Sweeping);
    assert_eq!(st.txid.as_deref(), Some(txid.as_str()));
    assert_eq!((st.mined_height, st.confirmations), (None, 0));

    state.health.synced_height.store(1_001, Ordering::Relaxed);
    let st = sweep_status(&state, &tab).unwrap();
    assert_eq!(st.state, TabState::Open);
    assert_eq!(
        state.meta.get_tab(tab.tab_id).unwrap().unwrap().state,
        TabState::Open
    );
}
