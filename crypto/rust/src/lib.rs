//! ZTab browser crypto module. The modules hold the logic and are tested natively; this file
//! holds only the wasm-bindgen exports (spec §3). Nothing here logs. The Rust side never sees
//! `master`: callers pass the spend seed and derived material only.
pub mod error;
pub mod keys;
pub mod network;
pub mod pczt_ops;
pub mod recipient;

use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

use crate::error::CryptoError;

fn js(e: CryptoError) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returned to JS as an object with a `ufvk` getter, `takeOrchardSk()` and `free()`; the Rust
/// copy of the key is moved out by `takeOrchardSk` and zeroed on drop.
#[wasm_bindgen]
pub struct TabAccount {
    ufvk: String,
    orchard_sk: Vec<u8>,
}

#[wasm_bindgen]
impl TabAccount {
    #[wasm_bindgen(getter)]
    pub fn ufvk(&self) -> String {
        self.ufvk.clone()
    }

    /// Hands the 32-byte Orchard spending key to the caller, who must `fill(0)` it after use.
    /// The Rust copy is emptied; a second call returns an empty array.
    #[wasm_bindgen(js_name = takeOrchardSk)]
    pub fn take_orchard_sk(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.orchard_sk)
    }
}

impl Drop for TabAccount {
    fn drop(&mut self) {
        self.orchard_sk.zeroize();
    }
}

#[wasm_bindgen(js_name = deriveTabAccount)]
pub fn js_derive_tab_account(network: &str, spend_seed: Vec<u8>) -> Result<TabAccount, JsError> {
    let spend_seed = Zeroizing::new(spend_seed);
    let network = network::parse_network(network).map_err(js)?;
    let account = keys::derive_tab_account(network, &spend_seed).map_err(js)?;
    Ok(TabAccount { ufvk: account.ufvk, orchard_sk: account.orchard_sk.to_vec() })
}

#[wasm_bindgen(js_name = deriveAddress)]
pub fn js_derive_address(network: &str, ufvk: &str, index: u32) -> Result<String, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    keys::derive_address(network, ufvk, index).map_err(js)
}

#[wasm_bindgen(js_name = validateRecipient)]
pub fn js_validate_recipient(network: &str, address: &str) -> Result<(), JsError> {
    let network = network::parse_network(network).map_err(js)?;
    recipient::validate_recipient(network, address).map_err(js)
}

/// JSON `{ outputs: [{ address, zat }], feeZat, totalInZat, txid }`.
#[wasm_bindgen(js_name = inspectPczt)]
pub fn js_inspect_pczt(network: &str, pczt: &[u8]) -> Result<String, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    let summary = pczt_ops::inspect(network, pczt).map_err(js)?;
    serde_json::to_string(&summary).map_err(|e| js(CryptoError::internal(format!("summary json: {e}"))))
}

/// `expected_json` is `{ recipient, totalZat, feeZat }`. Returns the signed PCZT bytes.
#[wasm_bindgen(js_name = signPczt)]
pub fn js_sign_pczt(
    network: &str,
    pczt: &[u8],
    orchard_sk: Vec<u8>,
    rng_seed: Vec<u8>,
    expected_json: &str,
) -> Result<Vec<u8>, JsError> {
    let orchard_sk = Zeroizing::new(orchard_sk);
    let rng_seed = Zeroizing::new(rng_seed);
    let network = network::parse_network(network).map_err(js)?;
    let expected: pczt_ops::Expected = serde_json::from_str(expected_json)
        .map_err(|e| js(CryptoError::internal(format!("expected json: {e}"))))?;
    pczt_ops::sign(network, pczt, &orchard_sk, &rng_seed, &expected).map_err(js)
}
