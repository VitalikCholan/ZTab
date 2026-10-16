//! ZTab browser crypto module. The modules hold the logic and are tested natively; this file
//! holds only the wasm-bindgen exports (spec §3). Nothing here logs.
pub mod error;
pub mod keys;
pub mod network;
pub mod recipient;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
