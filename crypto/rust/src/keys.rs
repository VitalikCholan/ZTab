//! Tab keys from the spend seed (watcher-spec §4): the seed is `HKDF(master, "ztab/v1/spend")`,
//! derived in TypeScript; this module never sees `master`.
use zcash_keys::keys::{
    ReceiverRequirement, UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey,
};
use zcash_protocol::consensus::Network;
use zeroize::Zeroizing;
use zip32::{AccountId, DiversifierIndex};

use crate::error::CryptoError;

/// What the browser keeps from a tab's spend seed: the UFVK for the watcher and the 32-byte
/// Orchard spending key that authorizes the closing PCZT.
pub struct TabAccount {
    pub ufvk: String,
    pub orchard_sk: Zeroizing<[u8; 32]>,
}

// Manual `Debug` so the spending key can never leak through a `{:?}`.
impl std::fmt::Debug for TabAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TabAccount")
            .field("ufvk", &self.ufvk)
            .field("orchard_sk", &"<redacted>")
            .finish()
    }
}

pub fn derive_tab_account(network: Network, spend_seed: &[u8]) -> Result<TabAccount, CryptoError> {
    let seed: Zeroizing<[u8; 32]> = Zeroizing::new(
        spend_seed
            .try_into()
            .map_err(|_| CryptoError::internal("spend seed must be 32 bytes"))?,
    );
    let usk = UnifiedSpendingKey::from_seed(&network, &seed[..], AccountId::ZERO)
        .map_err(|e| CryptoError::internal(format!("usk from seed: {e:?}")))?;
    let ufvk = usk
        .to_unified_full_viewing_key()
        .encode(&network)
        .map_err(|e| CryptoError::internal(format!("ufvk encode: {e:?}")))?;
    let orchard_sk = Zeroizing::new(*usk.orchard().to_bytes());
    Ok(TabAccount { ufvk, orchard_sk })
}

/// The watcher's request for participant addresses: one Orchard receiver, nothing else.
fn orchard_only() -> UnifiedAddressRequest {
    UnifiedAddressRequest::custom(
        ReceiverRequirement::Require,
        ReceiverRequirement::Omit,
        ReceiverRequirement::Omit,
    )
    .expect("an Orchard-only request is valid")
}

/// The participant address at `index`, exactly as the watcher derives it
/// (`watcher/src/wallet.rs::participant_addresses`), so the browser can check the watcher.
pub fn derive_address(network: Network, ufvk: &str, index: u32) -> Result<String, CryptoError> {
    let ufvk = UnifiedFullViewingKey::decode(&network, ufvk)
        .map_err(|e| CryptoError::internal(format!("ufvk decode: {e:?}")))?;
    let ua = ufvk
        .address(DiversifierIndex::from(index), orchard_only())
        .map_err(|e| CryptoError::internal(format!("address at index {index}: {e:?}")))?;
    Ok(ua.encode(&network))
}
