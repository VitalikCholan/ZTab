//! What the browser does with the watcher's closing PCZT: read what it pays (the confirmation
//! screen) and sign it, but only when it pays exactly what Alice confirmed.
use pczt::roles::verifier::{OrchardError, Verifier};
use pczt::Pczt;
use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::txid::{to_txid, TxIdDigester};
use zcash_protocol::consensus::Network;

use crate::error::{Code, CryptoError};
use crate::recipient::encode_orchard;

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
