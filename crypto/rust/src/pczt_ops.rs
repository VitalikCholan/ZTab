//! What the browser does with the watcher's closing PCZT: read what it pays (the confirmation
//! screen) and sign it, but only when it pays exactly what Alice confirmed.
use orchard::keys::{SpendAuthorizingKey, SpendingKey};
use pczt::roles::signer::{Error as SignerError, Signer};
use pczt::roles::verifier::{OrchardError, Verifier};
use pczt::Pczt;
use rand::{rngs::StdRng, SeedableRng};
use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::txid::{to_txid, TxIdDigester};
use zcash_protocol::consensus::Network;
use zeroize::Zeroizing;

use crate::error::{Code, CryptoError};
use crate::recipient::{encode_orchard, orchard_receiver};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PcztOutput {
    pub address: String,
    pub zat: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PcztSummary {
    /// Every value-carrying Ironwood output; zero-valued padding dummies are left out.
    pub outputs: Vec<PcztOutput>,
    pub fee_zat: u64,
    pub total_in_zat: u64,
    pub txid: String,
}

/// What `sign` checks the PCZT against (spec §3).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub recipient: String,
    pub total_zat: u64,
    pub fee_zat: u64,
}

/// The inspection result plus the raw receivers the signer compares.
pub struct Inspected {
    pub summary: PcztSummary,
    /// Raw Orchard address bytes of each value-carrying output, in `summary.outputs` order.
    pub receivers: Vec<[u8; 43]>,
    pub actions: usize,
}

pub fn parse(bytes: &[u8]) -> Result<Pczt, CryptoError> {
    Pczt::parse(bytes).map_err(|e| CryptoError::new(Code::InvalidPczt, format!("not a valid PCZT: {e:?}")))
}

fn invalid(message: impl Into<String>) -> CryptoError {
    CryptoError::new(Code::InvalidPczt, message)
}

/// Values and recipients are read from PCZT metadata, so they are trusted only after each
/// action's `cv_net` and note commitment (`cmx`) have been verified against that metadata.
pub fn inspect_inner(network: Network, pczt: &Pczt) -> Result<Inspected, CryptoError> {
    let mut outputs = Vec::new();
    let mut receivers = Vec::new();
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut actions = 0usize;
    let mut value_sum = 0i64;

    Verifier::new(pczt.clone())
        .with_ironwood::<CryptoError, _>(|bundle| {
            actions = bundle.actions().len();
            value_sum = i64::try_from(*bundle.value_sum())
                .map_err(|_| OrchardError::Custom(invalid("value sum out of range")))?;
            for (i, action) in bundle.actions().iter().enumerate() {
                action.verify_cv_net().map_err(|e| {
                    OrchardError::Custom(invalid(format!("action {i}: value commitment does not match: {e:?}")))
                })?;
                action.output().verify_note_commitment(action.spend()).map_err(|e| {
                    OrchardError::Custom(invalid(format!("action {i}: note commitment does not match: {e:?}")))
                })?;
                let spent = action
                    .spend()
                    .value()
                    .as_ref()
                    .ok_or_else(|| OrchardError::Custom(invalid(format!("action {i}: spend value redacted"))))?
                    .inner();
                let out = action
                    .output()
                    .value()
                    .as_ref()
                    .ok_or_else(|| OrchardError::Custom(invalid(format!("action {i}: output value redacted"))))?
                    .inner();
                total_in = total_in
                    .checked_add(spent)
                    .ok_or_else(|| OrchardError::Custom(invalid("input value overflow")))?;
                total_out = total_out
                    .checked_add(out)
                    .ok_or_else(|| OrchardError::Custom(invalid("output value overflow")))?;
                if out > 0 {
                    let recipient = action
                        .output()
                        .recipient()
                        .as_ref()
                        .ok_or_else(|| OrchardError::Custom(invalid(format!("action {i}: output recipient redacted"))))?;
                    receivers.push(recipient.to_raw_address_bytes());
                    outputs.push(PcztOutput {
                        address: encode_orchard(network, *recipient).map_err(OrchardError::Custom)?,
                        zat: out,
                    });
                }
            }
            Ok(())
        })
        .map_err(|e| match e {
            OrchardError::Custom(e) => e,
            other => invalid(format!("ironwood bundle: {other:?}")),
        })?;

    if actions == 0 {
        return Err(invalid("no Ironwood actions"));
    }
    let fee = total_in
        .checked_sub(total_out)
        .ok_or_else(|| invalid("outputs exceed inputs"))?;
    if i64::try_from(fee).ok() != Some(value_sum) {
        return Err(invalid("value sum does not match the actions"));
    }

    // The PCZT must describe a complete transaction with nothing outside the Ironwood bundle,
    // otherwise value could leave through a bundle this module does not inspect.
    let effects = pczt
        .clone()
        .into_effects()
        .map_err(|e| invalid(format!("not a complete transaction: {e:?}")))?;
    if effects
        .transparent_bundle()
        .is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty())
    {
        return Err(invalid("transparent inputs or outputs are not supported"));
    }
    if effects.sapling_bundle().is_some() || effects.orchard_bundle().is_some() {
        return Err(invalid("only an Ironwood bundle is supported"));
    }
    let parts = effects.digest(TxIdDigester);
    let txid = to_txid(effects.version(), effects.consensus_branch_id(), &parts).to_string();

    Ok(Inspected {
        summary: PcztSummary { outputs, fee_zat: fee, total_in_zat: total_in, txid },
        receivers,
        actions,
    })
}

/// The confirmation-screen view of a PCZT.
pub fn inspect(network: Network, bytes: &[u8]) -> Result<PcztSummary, CryptoError> {
    Ok(inspect_inner(network, &parse(bytes)?)?.summary)
}

/// Refuses unless every value-carrying output pays `want`, the outputs sum to
/// `expected.total_zat` and the fee is `expected.fee_zat`. Runs before any signature exists.
pub fn check_expectation(inspected: &Inspected, want: &[u8; 43], expected: &Expected) -> Result<(), CryptoError> {
    let mismatch = |m: String| CryptoError::new(Code::PcztMismatch, m);
    if inspected.summary.outputs.is_empty() {
        return Err(mismatch("the PCZT pays nobody".into()));
    }
    if inspected.receivers.iter().any(|r| r != want) {
        return Err(mismatch("an output pays an address other than the expected recipient".into()));
    }
    let paid: u64 = inspected.summary.outputs.iter().map(|o| o.zat).sum();
    if paid != expected.total_zat {
        return Err(mismatch(format!("outputs pay {paid} zat, expected {}", expected.total_zat)));
    }
    if inspected.summary.fee_zat != expected.fee_zat {
        return Err(mismatch(format!("fee is {} zat, expected {}", inspected.summary.fee_zat, expected.fee_zat)));
    }
    Ok(())
}

/// Signs every Ironwood spend `orchard_sk` authorizes, after `check_expectation` passes.
/// `rng_seed` is 32 bytes from `crypto.getRandomValues` (RedPallas signatures are randomized).
///
/// PCZTs from the watcher come from a view-only account, so their spends carry no
/// `zip32_derivation`: the only way to find this key's spends is to try each action and treat
/// `WrongSpendAuthorizingKey` as "not ours" (the dummy spend the IO Finalizer already signed,
/// or another key's note). Any other error is fatal; at least one signature is required.
pub fn sign(
    network: Network,
    bytes: &[u8],
    orchard_sk: &[u8],
    rng_seed: &[u8],
    expected: &Expected,
) -> Result<Vec<u8>, CryptoError> {
    let want = orchard_receiver(network, &expected.recipient)?.to_raw_address_bytes();
    let sk_bytes: Zeroizing<[u8; 32]> = Zeroizing::new(
        orchard_sk
            .try_into()
            .map_err(|_| CryptoError::internal("orchard spending key must be 32 bytes"))?,
    );
    let seed: [u8; 32] = rng_seed
        .try_into()
        .map_err(|_| CryptoError::internal("rng seed must be 32 bytes"))?;

    let pczt = parse(bytes)?;
    let inspected = inspect_inner(network, &pczt)?;
    check_expectation(&inspected, &want, expected)?;

    let sk = Option::<SpendingKey>::from(SpendingKey::from_bytes(*sk_bytes))
        .ok_or_else(|| CryptoError::internal("orchard spending key is not valid"))?;
    let ask = SpendAuthorizingKey::from(&sk);
    let mut rng = StdRng::from_seed(seed);
    let mut signer = Signer::new(pczt)
        .map_err(|e| CryptoError::new(Code::InvalidPczt, format!("signer: {e:?}")))?;
    let mut signed = 0usize;
    for i in 0..inspected.actions {
        match signer.sign_ironwood(&mut rng, i, &ask) {
            Ok(()) => signed += 1,
            Err(SignerError::IronwoodSign(orchard::pczt::SignerError::WrongSpendAuthorizingKey)) => {}
            Err(e) => return Err(CryptoError::new(Code::SignFailed, format!("action {i}: {e:?}"))),
        }
    }
    if signed == 0 {
        return Err(CryptoError::new(Code::SignFailed, "this key authorizes none of the spends"));
    }
    signer
        .finish()
        .serialize()
        .map_err(|e| CryptoError::internal(format!("serialize: {e:?}")))
}
