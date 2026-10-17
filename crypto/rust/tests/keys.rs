use zcash_protocol::consensus::Network;
use ztab_crypto::error::Code;
use ztab_crypto::keys::{derive_address, derive_tab_account};

fn fixture_seed() -> Vec<u8> {
    hex::decode(include_str!("fixtures/spend_seed.hex").trim()).unwrap()
}

fn expected() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/expected.json")).unwrap()
}

#[test]
fn derives_the_fixture_ufvk_and_orchard_key() {
    let account = derive_tab_account(Network::TestNetwork, &fixture_seed()).unwrap();
    let exp = expected();
    assert_eq!(account.ufvk, exp["ufvk"].as_str().unwrap());
    assert_eq!(hex::encode(*account.orchard_sk), exp["orchardSkHex"].as_str().unwrap());
}

#[test]
fn mainnet_ufvk_differs_in_prefix_only_by_network() {
    let account = derive_tab_account(Network::MainNetwork, &fixture_seed()).unwrap();
    assert!(account.ufvk.starts_with("uview1"), "{}", account.ufvk);
}

#[test]
fn rejects_a_seed_that_is_not_32_bytes() {
    let err = derive_tab_account(Network::TestNetwork, &[1u8; 31]).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "spend seed must be 32 bytes");
}

#[test]
fn derives_the_watcher_participant_addresses() {
    let exp = expected();
    let ufvk = exp["ufvk"].as_str().unwrap();
    for (index, address) in exp["addresses"].as_object().unwrap() {
        let index: u32 = index.parse().unwrap();
        assert_eq!(
            derive_address(Network::TestNetwork, ufvk, index).unwrap(),
            address.as_str().unwrap(),
            "index {index}"
        );
    }
}

#[test]
fn every_u32_index_yields_an_address() {
    let ufvk = expected()["ufvk"].as_str().unwrap().to_string();
    let last = derive_address(Network::TestNetwork, &ufvk, u32::MAX).unwrap();
    assert!(last.starts_with("utest1"));
    assert_ne!(last, derive_address(Network::TestNetwork, &ufvk, 0).unwrap());
}

#[test]
fn rejects_a_ufvk_of_the_other_network() {
    let ufvk = expected()["ufvk"].as_str().unwrap().to_string();
    let err = derive_address(Network::MainNetwork, &ufvk, 0).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert!(err.message.starts_with("ufvk decode:"), "{}", err.message);
}

#[test]
fn fixture_seed_is_the_hkdf_spend_key_of_the_ts_vectors() {
    // Pins the `ztab/v1/*` port from the Rust side: the same vectors live in crypto/test/fixtures/hkdf.json.
    let master: Vec<u8> = (0u8..32).collect();
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70"), &master);
    let mut spend_seed = [0u8; 32];
    hk.expand(b"ztab/v1/spend", &mut spend_seed).unwrap();
    assert_eq!(spend_seed.to_vec(), fixture_seed());
    let mut admin = [0u8; 32];
    hk.expand(b"ztab/v1/admin", &mut admin).unwrap();
    assert_eq!(hex::encode(admin), "6520dc5f78da4a75a29312b191c11a032cd26818ce3a74631d798f2d65fdf0df");
}
