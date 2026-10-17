//! The address Alice's funds go to. Narrower than the watcher's `shielded_recipient` (which
//! also accepts Sapling-only UAs): the closing PCZT is verified through its Ironwood outputs,
//! so the recipient must carry an Orchard receiver for the verification to see the payment.
use zcash_address::{ConversionError, ZcashAddress};
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_protocol::consensus::{Network, Parameters};

use crate::error::{Code, CryptoError};

/// Parses a recipient and returns its Orchard receiver.
pub fn orchard_receiver(network: Network, encoded: &str) -> Result<orchard::Address, CryptoError> {
    let refuse = |m: &str| CryptoError::new(Code::InvalidRecipient, m);
    let parsed = ZcashAddress::try_from_encoded(encoded.trim())
        .map_err(|_| refuse("not a Zcash address"))?;
    match parsed.convert_if_network::<Address>(network.network_type()) {
        Ok(Address::Unified(ua)) => ua
            .orchard()
            .copied()
            .ok_or_else(|| refuse("the unified address has no Orchard receiver")),
        Ok(Address::Transparent(_) | Address::Tex(_)) => Err(refuse(
            "transparent addresses are not accepted; use a shielded unified address",
        )),
        #[allow(unreachable_patterns)]
        Ok(_) => Err(refuse("not a supported address")),
        Err(ConversionError::IncorrectNetwork { .. }) => {
            Err(refuse("the address belongs to another network"))
        }
        Err(_) => Err(refuse("not a supported address")),
    }
}

pub fn validate_recipient(network: Network, encoded: &str) -> Result<(), CryptoError> {
    orchard_receiver(network, encoded).map(|_| ())
}

/// A bare Orchard receiver as a unified address of `network` (how PCZT outputs are shown).
pub fn encode_orchard(network: Network, receiver: orchard::Address) -> Result<String, CryptoError> {
    UnifiedAddress::from_receivers(Some(receiver), None, None, None)
        .map(|ua| ua.encode(&network))
        .ok_or_else(|| CryptoError::internal("unified address from an Orchard receiver"))
}
