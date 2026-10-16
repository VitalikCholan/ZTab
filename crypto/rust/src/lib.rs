//! ZTab browser crypto module. The modules hold the logic and are tested natively; this file
//! holds only the wasm-bindgen exports (spec §3). Nothing here logs. The Rust side never sees
//! `master`: callers pass the spend seed and derived material only.
pub mod error;
pub mod keys;
pub mod network;
pub mod pczt_ops;
pub mod recipient;

use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

use crate::error::CryptoError;

fn js(e: CryptoError) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returned to JS as an object with `ufvk` and `orchardSk` getters and `free()`; the Rust
/// copy of the key is zeroed when freed.
#[wasm_bindgen(getter_with_clone)]
#[allow(non_snake_case)]
pub struct TabAccount {
    pub ufvk: String,
    pub orchardSk: Vec<u8>,
}

impl Drop for TabAccount {
    fn drop(&mut self) {
        self.orchardSk.zeroize();
    }
}

#[wasm_bindgen(js_name = deriveTabAccount)]
pub fn js_derive_tab_account(network: &str, spend_seed: &[u8]) -> Result<TabAccount, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    let account = keys::derive_tab_account(network, spend_seed).map_err(js)?;
    Ok(TabAccount { ufvk: account.ufvk, orchardSk: account.orchard_sk.to_vec() })
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
    orchard_sk: &[u8],
    rng_seed: &[u8],
    expected_json: &str,
) -> Result<Vec<u8>, JsError> {
    let network = network::parse_network(network).map_err(js)?;
    let expected: pczt_ops::Expected = serde_json::from_str(expected_json)
        .map_err(|e| js(CryptoError::internal(format!("expected json: {e}"))))?;
    pczt_ops::sign(network, pczt, orchard_sk, rng_seed, &expected).map_err(js)
}
