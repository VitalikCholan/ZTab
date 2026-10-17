use zcash_protocol::consensus::Network;

use crate::error::CryptoError;

/// The network names the TypeScript layer passes (`'test' | 'main'`).
pub fn parse_network(name: &str) -> Result<Network, CryptoError> {
    match name {
        "test" => Ok(Network::TestNetwork),
        "main" => Ok(Network::MainNetwork),
        other => Err(CryptoError::internal(format!(
            "unknown network {other:?}; expected \"test\" or \"main\""
        ))),
    }
}
