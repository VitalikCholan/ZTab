use zcash_address::{ToAddress, ZcashAddress};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{Network, NetworkType};
use zcash_transparent::address::TransparentAddress;
use ztab_crypto::error::Code;
use zcash_address::unified::{self, Encoding};
use ztab_crypto::recipient::{canonical_recipient, encode_orchard, orchard_receiver, validate_recipient};

const UFVK: &str = "uviewtest10ff4c0qk6sneplhnr5h53lw9j4n2a4af7j6spgy5sh67xfcfje3mpwdurusf590p2usjt7d07q952xyv2eqjudd568nqun8qqvcfjz2qmtw9ttkqtygkrmhku885eez4dhztlnev8cleaxqdtakgk9et8t4d6n2ll8fm3vp9efwre8tf42t35esdgz89w";
const ADDRESS_0: &str = "utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7";

fn orchard_address_of_fixture() -> orchard::Address {
    // Independent of `derive_address`: straight from the Orchard full viewing key.
    let ufvk = UnifiedFullViewingKey::decode(&Network::TestNetwork, UFVK).unwrap();
    ufvk.orchard().unwrap().address_at(0u32, orchard::keys::Scope::External)
}

fn refused(network: Network, address: &str, expected_message: &str) {
    let err = validate_recipient(network, address).unwrap_err();
    assert_eq!(err.code, Code::InvalidRecipient, "{address}");
    assert_eq!(err.message, expected_message, "{address}");
}

#[test]
fn accepts_a_testnet_ua_with_an_orchard_receiver() {
    validate_recipient(Network::TestNetwork, ADDRESS_0).unwrap();
    validate_recipient(Network::TestNetwork, &format!("  {ADDRESS_0}\n")).unwrap();
    let receiver = orchard_receiver(Network::TestNetwork, ADDRESS_0).unwrap();
    assert_eq!(receiver.to_raw_address_bytes(), orchard_address_of_fixture().to_raw_address_bytes());
}

#[test]
fn encode_orchard_round_trips_the_watcher_address() {
    let receiver = orchard_receiver(Network::TestNetwork, ADDRESS_0).unwrap();
    assert_eq!(encode_orchard(Network::TestNetwork, receiver).unwrap(), ADDRESS_0);
}

#[test]
fn refuses_the_other_network() {
    let mainnet = UnifiedAddress::from_receivers(Some(orchard_address_of_fixture()), None, None, None)
        .unwrap()
        .encode(&Network::MainNetwork);
    assert!(mainnet.starts_with("u1"));
    refused(Network::TestNetwork, &mainnet, "the address belongs to another network");
    refused(Network::MainNetwork, ADDRESS_0, "the address belongs to another network");
}

#[test]
fn refuses_transparent_and_tex_addresses() {
    let t = ZcashAddress::from_transparent_p2pkh(NetworkType::Test, [1; 20]).encode();
    assert!(t.starts_with("tm"));
    refused(Network::TestNetwork, &t, "transparent addresses are not accepted; use a shielded unified address");
    let tex = ZcashAddress::from_tex(NetworkType::Test, [1; 20]).encode();
    refused(Network::TestNetwork, &tex, "transparent addresses are not accepted; use a shielded unified address");
}

#[test]
fn refuses_a_ua_without_an_orchard_receiver() {
    let transparent_only = UnifiedAddress::from_receivers(
        None,
        Some(TransparentAddress::PublicKeyHash([3; 20])),
        None,
        None,
    )
    .unwrap()
    .encode(&Network::TestNetwork);
    refused(Network::TestNetwork, &transparent_only, "the unified address has no Orchard receiver");
}

#[test]
fn refuses_garbage() {
    refused(Network::TestNetwork, "utest1x", "not a Zcash address");
    refused(Network::TestNetwork, "", "not a Zcash address");
}

/// The tab fixture's withdraw recipient (Orchard-only), as `inspectPczt` prints it.
const TAB_RECIPIENT: &str = "utest1ar2v4yu756pkxhpacqe0kut2zkjske7y2pe6dea6ezfg7qs3c8e4e5uflja4e4l5869c5j0q6g5gvvl8620uxy9nr26475939uegwc4d";

/// A wallet-style UA: the same Orchard receiver plus Sapling and transparent receivers.
fn multi_receiver_ua() -> String {
    let orchard = orchard_receiver(Network::TestNetwork, TAB_RECIPIENT).unwrap().to_raw_address_bytes();
    unified::Address::try_from_items(
        unified::Revision::R0,
        vec![
            unified::Uitem::Data(unified::Receiver::Orchard(orchard)),
            unified::Uitem::Data(unified::Receiver::Sapling([7; 43])),
            unified::Uitem::Data(unified::Receiver::P2pkh([5; 20])),
        ],
    )
    .unwrap()
    .encode(&NetworkType::Test)
}

#[test]
fn canonical_recipient_strips_non_orchard_receivers() {
    let multi = multi_receiver_ua();
    assert_ne!(multi, TAB_RECIPIENT);
    assert_eq!(canonical_recipient(Network::TestNetwork, &multi).unwrap(), TAB_RECIPIENT);
    // The JS tests use this exact string (crypto/test/fixtures/recipient.json).
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../test/fixtures/recipient.json")).unwrap();
    assert_eq!(fixture["multiReceiver"], multi.as_str());
    assert_eq!(fixture["orchardOnly"], TAB_RECIPIENT);
}

#[test]
fn canonical_recipient_keeps_an_orchard_only_ua() {
    assert_eq!(canonical_recipient(Network::TestNetwork, TAB_RECIPIENT).unwrap(), TAB_RECIPIENT);
    assert_eq!(canonical_recipient(Network::TestNetwork, ADDRESS_0).unwrap(), ADDRESS_0);
}

#[test]
fn canonical_recipient_refuses_like_validate_recipient() {
    let transparent_only =
        UnifiedAddress::from_receivers(None, Some(TransparentAddress::PublicKeyHash([3; 20])), None, None)
            .unwrap()
            .encode(&Network::TestNetwork);
    for bad in [transparent_only.as_str(), "utest1x", ADDRESS_0.replace("utest", "u").as_str()] {
        let a = canonical_recipient(Network::TestNetwork, bad).unwrap_err();
        let b = validate_recipient(Network::TestNetwork, bad).unwrap_err();
        assert_eq!((a.code, a.message), (b.code, b.message), "{bad}");
    }
}

#[test]
#[ignore]
fn print_multi_receiver_ua() {
    println!("{}", multi_receiver_ua());
}
