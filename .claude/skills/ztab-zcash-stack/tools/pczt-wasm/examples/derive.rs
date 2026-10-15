//! Native helper: mnemonic file -> hex of the account-0 Orchard spending key (testnet).
use bip0039::{English, Mnemonic};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::Network;
fn main() {
    let path = std::env::args().nth(1).expect("mnemonic file");
    let text = std::fs::read_to_string(path).expect("read");
    let phrase = text.lines().find(|l| l.split_whitespace().count() == 24).expect("24-word line").trim();
    let mnemonic = Mnemonic::<English>::from_phrase(phrase).expect("valid mnemonic");
    let seed = mnemonic.to_seed("");
    let usk = UnifiedSpendingKey::from_seed(&Network::TestNetwork, &seed, zip32::AccountId::ZERO).expect("usk");
    println!("{}", hex::encode(usk.orchard().to_bytes()));
}
