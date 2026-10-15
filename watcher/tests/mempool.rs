//! Offline tests of mempool trial decryption against saved testnet transactions.
mod common;

#[tokio::test]
async fn record_sightings_attributes_note_to_participant_index() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    let raw = common::fixture_rawtx(common::FIXTURE_INDEX0_PAYMENT_TXID);
    let n = ztab_watcher::mempool::record_sightings(&state, &raw, time::OffsetDateTime::now_utc())
        .unwrap();
    assert_eq!(n, 1);
    let s = state
        .meta
        .sightings_for_tab(common::fixture_tab_id())
        .unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].txid, common::FIXTURE_INDEX0_PAYMENT_TXID);
    assert_eq!(s[0].participant_index, 0);
    assert_eq!(s[0].value_zat, 29_990_000);
    // Seeing the same transaction again (e.g. after a resubscribe) keeps one sighting.
    ztab_watcher::mempool::record_sightings(&state, &raw, time::OffsetDateTime::now_utc()).unwrap();
    let again = state
        .meta
        .sightings_for_tab(common::fixture_tab_id())
        .unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].first_seen_at, s[0].first_seen_at);
}

#[tokio::test]
async fn record_sightings_ignores_change_and_outgoing_outputs() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    // Sent by the fixture account: its 0.3 TAZ output decrypts only as outgoing and its
    // change as account-internal; neither is a participant payment.
    let raw = common::fixture_rawtx(common::FIXTURE_FUNDING_TXID);
    let n = ztab_watcher::mempool::record_sightings(&state, &raw, time::OffsetDateTime::now_utc())
        .unwrap();
    assert_eq!(n, 0);
    assert!(state
        .meta
        .sightings_for_tab(common::fixture_tab_id())
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn record_sightings_ignores_self_sends_to_participant_addresses() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    // The fixture account paid its own index-1 address. That output decrypts as incoming,
    // but the account funded the transaction, so (as in the block scanner) it is not a
    // participant payment.
    let raw = common::fixture_rawtx(common::FIXTURE_INDEX1_SELF_SEND_TXID);
    let n = ztab_watcher::mempool::record_sightings(&state, &raw, time::OffsetDateTime::now_utc())
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn index_for_orchard_address_is_bounded_by_participant_count() {
    use zcash_client_backend::data_api::{Account, WalletRead};
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 3).await;
    let tab = state
        .meta
        .get_tab(common::fixture_tab_id())
        .unwrap()
        .unwrap();
    let account = ztab_watcher::wallet::account_uuid(tab.account_uuid);
    let fvk = state
        .wallet
        .db()
        .get_account(account)
        .unwrap()
        .unwrap()
        .ufvk()
        .unwrap()
        .orchard()
        .unwrap()
        .clone();
    let at = |i: u32| fvk.address_at(i, zip32::Scope::External);
    let w = &state.wallet;
    // Receivers come from the addresses registration stored in `tab_addresses`; a count
    // beyond them (only possible for this test) is served from the wallet derivation.
    let stored = || state.meta.tab_addresses(tab.tab_id);
    assert_eq!(stored().unwrap().len(), 3);
    assert_eq!(
        w.index_for_orchard_address(account, 3, &at(2), stored)
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        w.index_for_orchard_address(account, 3, &at(0), stored)
            .unwrap(),
        Some(0)
    );
    // Cached receivers beyond the requested count are not matched.
    assert_eq!(
        w.index_for_orchard_address(account, 2, &at(2), stored)
            .unwrap(),
        None
    );
    assert_eq!(
        w.index_for_orchard_address(account, 3, &at(3), stored)
            .unwrap(),
        None
    );
    // Growing the count re-derives.
    assert_eq!(
        w.index_for_orchard_address(account, 4, &at(3), || w.participant_addresses(account, 4))
            .unwrap(),
        Some(3)
    );
    // The internal (change) address is never a participant.
    let change = fvk.address_at(0u32, zip32::Scope::Internal);
    assert_eq!(
        w.index_for_orchard_address(account, 4, &change, || w.participant_addresses(account, 4))
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn record_sightings_rejects_garbage_as_unprocessable() {
    let state = common::offline_state().await;
    common::import_fixture_tab_offline(&state, 2).await;
    let r = ztab_watcher::mempool::record_sightings(
        &state,
        &[0xff; 16],
        time::OffsetDateTime::now_utc(),
    );
    assert!(matches!(
        r,
        Err(ztab_watcher::error::WatcherError::Unprocessable(_))
    ));
}
