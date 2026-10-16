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
