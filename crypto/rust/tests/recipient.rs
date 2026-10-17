use zcash_address::{ToAddress, ZcashAddress};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{Network, NetworkType};
use zcash_transparent::address::TransparentAddress;
use ztab_crypto::error::Code;
use ztab_crypto::recipient::{encode_orchard, orchard_receiver, validate_recipient};

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
