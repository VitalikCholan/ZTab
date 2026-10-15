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
