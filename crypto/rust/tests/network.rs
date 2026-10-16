use ztab_crypto::error::Code;
use ztab_crypto::network::parse_network;
use zcash_protocol::consensus::Network;

#[test]
fn parses_the_two_network_names() {
    assert!(matches!(parse_network("test"), Ok(Network::TestNetwork)));
    assert!(matches!(parse_network("main"), Ok(Network::MainNetwork)));
}

#[test]
fn rejects_anything_else_as_internal() {
    let err = parse_network("testnet").unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.to_string(), "internal: unknown network \"testnet\"; expected \"test\" or \"main\"");
}
