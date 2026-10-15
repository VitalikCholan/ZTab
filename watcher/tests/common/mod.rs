// Each test binary uses a subset of this harness.
#![allow(dead_code)]
use std::{collections::HashMap, path::Path};
use ztab_watcher::config::Config;

/// Testnet UFVK of the spike's view-only wallet; it is a viewing key, not a secret.
pub const FIXTURE_UFVK: &str = match str::from_utf8(
    include_str!("../fixtures/fixture-ufvk.txt")
        .as_bytes()
        .trim_ascii(),
) {
    Ok(s) => s,
    Err(_) => panic!("fixture UFVK is not UTF-8"),
};
pub const FIXTURE_BIRTHDAY: u32 = 4_503_583;

pub fn testnet_config(tmp: &Path) -> Config {
    let m: HashMap<String, String> = [
        ("ZTAB_API_TOKEN", "test-token"),
        ("ZTAB_DATA_DIR", tmp.to_str().unwrap()),
        ("ZTAB_NETWORK", "test"),
        ("ZTAB_LIGHTWALLETD_URL", "https://testnet.zec.rocks:443"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    Config::from_map(&m).unwrap()
}
