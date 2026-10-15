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
