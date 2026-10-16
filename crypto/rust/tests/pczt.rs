use zcash_protocol::consensus::Network;
use ztab_crypto::error::Code;
use ztab_crypto::pczt_ops::{inspect, PcztOutput};

pub const RECIPIENT: &str = "utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp";

pub fn watcher_fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../watcher/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

#[test]
fn inspects_the_proved_sweep() {
    let summary = inspect(Network::TestNetwork, &watcher_fixture("sweep.proved.pczt")).unwrap();
    assert_eq!(
        summary.outputs,
        vec![PcztOutput { address: RECIPIENT.to_string(), zat: 29_990_000 }]
    );
    assert_eq!(summary.fee_zat, 10_000);
    assert_eq!(summary.total_in_zat, 30_000_000);
    assert_eq!(
        summary.txid,
        "659513d7a836783c8ab08445069de601c5c25b7f422e30ab8f116f5ff0e0f978"
    );
}

#[test]
fn inspects_the_second_sweep_and_the_signed_form() {
    let second = inspect(Network::TestNetwork, &watcher_fixture("sweep2.proved.pczt")).unwrap();
    assert_eq!(second.outputs[0].zat, 19_990_000);
    assert_eq!(second.total_in_zat, 20_000_000);
    assert_eq!(
        second.txid,
        "de425ef04e19f9d6e8ffa6caf7c87a110f76b321c7e0fcff97715417b943c2cb"
    );
    // Signatures do not change what the transaction does.
    let signed = inspect(Network::TestNetwork, &watcher_fixture("sweep.signed.pczt")).unwrap();
    let proved = inspect(Network::TestNetwork, &watcher_fixture("sweep.proved.pczt")).unwrap();
    assert_eq!(signed, proved);
}

#[test]
fn summary_serializes_as_camel_case_json() {
    let summary = inspect(Network::TestNetwork, &watcher_fixture("sweep.proved.pczt")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&summary).unwrap()).unwrap();
    assert_eq!(json["feeZat"], 10_000);
    assert_eq!(json["totalInZat"], 30_000_000);
    assert_eq!(json["outputs"][0]["address"], RECIPIENT);
    assert_eq!(json["outputs"][0]["zat"], 29_990_000);
    assert!(json["txid"].is_string());
}

#[test]
fn garbage_and_truncated_bytes_are_invalid_pczt_not_panics() {
    for bytes in [vec![], b"PCZT".to_vec(), vec![0u8; 100], watcher_fixture("sweep.proved.pczt")[..4000].to_vec()] {
        let err = inspect(Network::TestNetwork, &bytes).unwrap_err();
        assert_eq!(err.code, Code::InvalidPczt, "{} bytes", bytes.len());
    }
}

const OTHER: &str = "utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7";

#[test]
fn metadata_that_contradicts_the_note_commitment_is_refused() {
    use ztab_crypto::recipient::orchard_receiver;
    let bytes = watcher_fixture("sweep.proved.pczt");
    let real = orchard_receiver(Network::TestNetwork, RECIPIENT).unwrap().to_raw_address_bytes();
    let other = orchard_receiver(Network::TestNetwork, OTHER).unwrap().to_raw_address_bytes();
    let pos = bytes.windows(43).position(|w| w == real).expect("receiver bytes in fixture");
    let mut tampered = bytes.clone();
    tampered[pos..pos + 43].copy_from_slice(&other);
    assert!(inspect(Network::TestNetwork, &bytes).is_ok());
    let err = inspect(Network::TestNetwork, &tampered).unwrap_err();
    assert_eq!(err.code, Code::InvalidPczt);
    assert!(err.message.contains("note commitment"), "{}", err.message);
}

#[test]
fn every_fixture_action_passes_commitment_checks() {
    for name in ["sweep.proved.pczt", "sweep.signed.pczt", "sweep2.proved.pczt"] {
        assert!(inspect(Network::TestNetwork, &watcher_fixture(name)).is_ok(), "{name}");
    }
}

use ztab_crypto::pczt_ops::{check_expectation, parse, inspect_inner, sign, Expected, Inspected, PcztSummary};
use ztab_crypto::recipient::orchard_receiver;

/// Orchard spending key of the deterministic fixture tab (NOT the key of the watcher fixture
/// PCZTs, whose wallet is gone): it signs nothing in them.
const FOREIGN_SK: &str = "5ad2324395117be2510b63d2672f7f187302b6a1b683b512f2446bd0df378368";
const FOREIGN_ADDRESS: &str = "utest1k76fvkzrq5a6sxurhd5muxlkeynlhvqcuzfrvnlex7vvgpk96m63rrxjunzxa2zqd799edqdup0u9zjz3pwkegwfty0x6qz3dcum28e7";

fn expected_for_sweep() -> Expected {
    Expected { recipient: RECIPIENT.to_string(), total_zat: 29_990_000, fee_zat: 10_000 }
}

fn sign_sweep(expected: &Expected) -> Result<Vec<u8>, ztab_crypto::error::CryptoError> {
    sign(
        Network::TestNetwork,
        &watcher_fixture("sweep.proved.pczt"),
        &hex::decode(FOREIGN_SK).unwrap(),
        &[9u8; 32],
        expected,
    )
}

#[test]
fn a_key_that_authorizes_no_spend_fails_after_the_checks_pass() {
    let err = sign_sweep(&expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::SignFailed);
    assert_eq!(err.message, "this key authorizes none of the spends");
}

#[test]
fn refuses_before_signing_when_the_recipient_differs() {
    let err = sign_sweep(&Expected { recipient: FOREIGN_ADDRESS.to_string(), ..expected_for_sweep() }).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    assert_eq!(err.message, "an output pays an address other than the expected recipient");
}

#[test]
fn refuses_before_signing_when_the_total_or_fee_differs() {
    let err = sign_sweep(&Expected { total_zat: 29_990_001, ..expected_for_sweep() }).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    assert_eq!(err.message, "outputs pay 29990000 zat, expected 29990001");
    let err = sign_sweep(&Expected { fee_zat: 20_000, ..expected_for_sweep() }).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    assert_eq!(err.message, "fee is 10000 zat, expected 20000");
}

#[test]
fn a_mainnet_call_with_a_testnet_recipient_fails_as_invalid_recipient() {
    let err = sign(
        Network::MainNetwork,
        &watcher_fixture("sweep.proved.pczt"),
        &hex::decode(FOREIGN_SK).unwrap(),
        &[9u8; 32],
        &expected_for_sweep(),
    )
    .unwrap_err();
    assert_eq!(err.code, Code::InvalidRecipient);
}

#[test]
fn wrong_key_or_seed_lengths_are_internal_errors() {
    let pczt = watcher_fixture("sweep.proved.pczt");
    let err = sign(Network::TestNetwork, &pczt, &[1u8; 31], &[9u8; 32], &expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "orchard spending key must be 32 bytes");
    let err = sign(Network::TestNetwork, &pczt, &[1u8; 32], &[9u8; 16], &expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "rng seed must be 32 bytes");
}

#[test]
fn check_expectation_refuses_a_second_value_carrying_output() {
    // Synthetic: the sweep pays the recipient AND leaks change to someone else.
    let pczt = parse(&watcher_fixture("sweep.proved.pczt")).unwrap();
    let real = inspect_inner(Network::TestNetwork, &pczt).unwrap();
    let want = orchard_receiver(Network::TestNetwork, RECIPIENT).unwrap().to_raw_address_bytes();
    let other = orchard_receiver(Network::TestNetwork, FOREIGN_ADDRESS).unwrap().to_raw_address_bytes();
    let leaky = Inspected {
        summary: PcztSummary {
            outputs: vec![
                PcztOutput { address: RECIPIENT.to_string(), zat: 29_000_000 },
                PcztOutput { address: FOREIGN_ADDRESS.to_string(), zat: 990_000 },
            ],
            fee_zat: 10_000,
            total_in_zat: 30_000_000,
            txid: real.summary.txid.clone(),
        },
        receivers: vec![want, other],
        actions: 2,
    };
    let err = check_expectation(&leaky, &want, &expected_for_sweep()).unwrap_err();
    assert_eq!(err.code, Code::PcztMismatch);
    // The honest inspection passes the same check.
    check_expectation(&real, &want, &expected_for_sweep()).unwrap();
    // No value-carrying output at all is also a mismatch.
    let empty = Inspected {
        summary: PcztSummary { outputs: vec![], fee_zat: 10_000, total_in_zat: 10_000, txid: real.summary.txid },
        receivers: vec![],
        actions: 2,
    };
    assert_eq!(check_expectation(&empty, &want, &expected_for_sweep()).unwrap_err().message, "the PCZT pays nobody");
}

mod real_tab {
    use super::*;
    use pczt::roles::verifier::Verifier;
    use ztab_crypto::keys::derive_tab_account;

    fn tab(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/tests/fixtures/tab/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn signs_a_real_watcher_sweep_with_the_tab_key() {
        let exp: serde_json::Value = serde_json::from_slice(&tab("expected.json")).unwrap();
        let seed = hex::decode(String::from_utf8(tab("spend_seed.hex")).unwrap().trim()).unwrap();
        let account = derive_tab_account(Network::TestNetwork, &seed).unwrap();
        assert_eq!(account.ufvk, exp["ufvk"].as_str().unwrap());

        let proved = tab("sweep.proved.pczt");
        let summary = inspect(Network::TestNetwork, &proved).unwrap();
        assert_eq!(summary.txid, exp["txid"].as_str().unwrap());
        assert_eq!(summary.fee_zat, exp["feeZat"].as_u64().unwrap());
        assert_eq!(summary.outputs.iter().map(|o| o.zat).sum::<u64>(), exp["outputZat"].as_u64().unwrap());

        let expected = Expected {
            recipient: exp["recipient"].as_str().unwrap().to_string(),
            total_zat: exp["outputZat"].as_u64().unwrap(),
            fee_zat: exp["feeZat"].as_u64().unwrap(),
        };
        let signed = sign(Network::TestNetwork, &proved, &account.orchard_sk[..], &[4u8; 32], &expected).unwrap();

        // Every action now carries a spend authorization, and the transaction is unchanged.
        let mut unsigned = 0;
        Verifier::new(parse(&signed).unwrap())
            .with_ironwood::<std::convert::Infallible, _>(|b| {
                unsigned = b.actions().iter().filter(|a| a.spend().spend_auth_sig().is_none()).count();
                Ok(())
            })
            .unwrap();
        assert_eq!(unsigned, 0);
        assert_eq!(inspect(Network::TestNetwork, &signed).unwrap(), summary);
        // Signatures are randomized: a different rng seed gives different bytes, same effects.
        let again = sign(Network::TestNetwork, &proved, &account.orchard_sk[..], &[5u8; 32], &expected).unwrap();
        assert_ne!(again, signed);
    }
}
