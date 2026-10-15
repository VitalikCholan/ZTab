//! PCZT sweeps: the watcher proposes, creates and proves the sweep of a tab's whole balance;
//! the payer's browser signs it; the watcher checks that the signed PCZT is the one it
//! offered, extracts the transaction and broadcasts it. No spending key ever reaches here.
use crate::{
    error::WatcherError,
    http::AppState,
    meta::{TabRow, TabState},
    rng::OsRng,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use pczt::{roles::prover::Prover, Pczt};
use std::{
    collections::HashMap,
    convert::Infallible,
    num::NonZeroU32,
    str::FromStr,
    sync::{atomic::Ordering, Arc},
};
use uuid::Uuid;
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        error::Error as BackendError,
        wallet::{
            create_pczt_from_proposal, extract_and_store_transaction_from_pczt,
            input_selection::LockedInputPolicy, propose_send_max_transfer, ConfirmationsPolicy,
        },
        MaxSpendMode, WalletRead,
    },
    fees::{ChangeError, StandardFeeRule},
    proto::service,
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{error::SqliteClientError, util::SystemClock, AccountUuid};
use zcash_primitives::transaction::{
    builder::BundlePadding,
    components::orchard::bundle_version_for_branch,
    txid::{to_txid, TxIdDigester},
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    consensus::BranchId,
    memo::{Memo, MemoBytes},
    ShieldedPool, TxId,
};

#[derive(Clone, Debug, serde::Serialize)]
pub struct SweepSummary {
    pub inputs_zat: u64,
    pub output_zat: u64,
    pub fee_zat: u64,
    pub expiry_height: u32,
    pub txid: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SweepOffer {
    pub pczt_b64: String,
    pub summary: SweepSummary,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SweepStatus {
    pub state: TabState,
    pub txid: Option<String>,
    pub mined_height: Option<u32>,
    pub confirmations: u32,
}

fn parse_pczt(bytes: &[u8]) -> Result<Pczt, WatcherError> {
    Pczt::parse(bytes).map_err(|e| WatcherError::Unprocessable(format!("pczt: {e:?}")))
}

/// The txid of the transaction a PCZT describes. It commits only to the transaction's
/// effects, not to proofs or signatures, so an offered (proved) PCZT and its signed form
/// share it. Mirrors zcash-devtool `pczt inspect`.
fn txid_of(pczt: Pczt) -> Result<String, WatcherError> {
    let tx_data = pczt
        .into_effects()
        .map_err(|e| WatcherError::Unprocessable(format!("pczt effects: {e:?}")))?;
    let parts = tx_data.digest(TxIdDigester);
    Ok(to_txid(tx_data.version(), tx_data.consensus_branch_id(), &parts).to_string())
}

pub fn pczt_txid(bytes: &[u8]) -> Result<String, WatcherError> {
    txid_of(parse_pczt(bytes)?)
}

/// Per-tab serialization of sweep operations. Offer and broadcast take a tab's lock with
/// `try_acquire` (a concurrent request is refused with `Conflict`, so a `POST /sweep` can
/// never replace an offer whose broadcast is in flight); status waits for it.
///
/// Lock order: a tab's sweep lock is taken first, before the shared lightwalletd `client`
/// lock and before any std guard (`db()`, `read_conn()`, meta), and never while holding
/// either.
#[derive(Default)]
pub struct SweepLocks(std::sync::Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>);

pub type SweepGuard = tokio::sync::OwnedMutexGuard<()>;

impl SweepLocks {
    fn lock_for(&self, tab_id: Uuid) -> Arc<tokio::sync::Mutex<()>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(tab_id)
            .or_default()
            .clone()
    }

    /// The tab's sweep lock, or `Conflict` if another offer/broadcast holds it.
    pub fn try_acquire(&self, tab_id: Uuid) -> Result<SweepGuard, WatcherError> {
        self.lock_for(tab_id).try_lock_owned().map_err(|_| {
            WatcherError::Conflict(
                "another sweep request for this tab is in progress; retry shortly".into(),
            )
        })
    }

    pub async fn acquire(&self, tab_id: Uuid) -> SweepGuard {
        self.lock_for(tab_id).lock_owned().await
    }
}

/// The tab as currently stored; callers re-read it under the tab's sweep lock.
fn reload(state: &AppState, tab_id: Uuid) -> Result<TabRow, WatcherError> {
    state
        .meta
        .get_tab(tab_id)?
        .ok_or_else(|| WatcherError::NotFound(format!("tab {tab_id}")))
}

/// Proposes sending the tab's entire balance (Orchard and Ironwood) to `recipient`, creates
/// the PCZT, proves it, and records it as the tab's current offer. Fails with `Conflict`
/// unless the tab is open and every note has `confirmations_sweep` confirmations, or while
/// another offer/broadcast for the tab is in progress.
pub async fn create_proved_pczt(
    state: &AppState,
    tab: &TabRow,
    recipient: &str,
    memo: Option<&str>,
) -> Result<SweepOffer, WatcherError> {
    let guard = state.sweep_locks.try_acquire(tab.tab_id)?;
    let (state, tab_id) = (state.clone(), tab.tab_id);
    let (recipient, memo) = (recipient.to_string(), memo.map(str::to_string));
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let tab = reload(&state, tab_id)?;
        create_proved_pczt_blocking(&state, &tab, &recipient, memo.as_deref())
    })
    .await
    .map_err(|e| WatcherError::Internal(anyhow::anyhow!("sweep task: {e}")))?
}

fn create_proved_pczt_blocking(
    state: &AppState,
    tab: &TabRow,
    recipient: &str,
    memo: Option<&str>,
) -> Result<SweepOffer, WatcherError> {
    if tab.state != TabState::Open {
        return Err(WatcherError::Conflict(format!(
            "tab state is {}",
            tab.state.as_str()
        )));
    }
    let network = state.wallet.network();
    let recipient = ZcashAddress::try_from_encoded(recipient)
        .map_err(|e| WatcherError::Unprocessable(format!("recipient: {e}")))?;
    let memo = memo
        .map(|m| Memo::from_str(m).map(MemoBytes::from))
        .transpose()
        .map_err(|e| WatcherError::Unprocessable(format!("memo: {e}")))?;
    let account = AccountUuid::from_uuid(tab.account_uuid);
    let confirmations = NonZeroU32::new(state.cfg.confirmations_sweep).unwrap_or(NonZeroU32::MIN);
    // Same depth for wallet-internal (change) and external notes: a sweep must not spend
    // anything a reorg could still take back.
    let policy = ConfirmationsPolicy::new_symmetrical(confirmations, false);

    let started = std::time::Instant::now();
    let (pczt, inputs_zat, output_zat, fee_zat) = {
        let mut db = state.wallet.db();
        let proposal = propose_send_max_transfer::<_, _, _, Infallible>(
            &mut *db,
            &network,
            account,
            &[ShieldedPool::Orchard, ShieldedPool::Ironwood],
            &StandardFeeRule::Zip317,
            recipient,
            memo,
            // Everything, not MaxSpendable: a note below the confirmation depth fails the
            // proposal instead of being silently left behind.
            MaxSpendMode::Everything,
            policy,
            &LockedInputPolicy::Exclude,
            None,
        )
        .map_err(|e| match e {
            // Not spendable (yet): explained below, once the wallet lock is released.
            BackendError::DataSource(SqliteClientError::IneligibleNotes)
            | BackendError::InsufficientFunds { .. }
            | BackendError::Change(ChangeError::InsufficientFunds { .. }) => None,
            BackendError::ScanRequired => Some(WatcherError::Conflict(
                "the tab is not synced yet; retry shortly".into(),
            )),
            BackendError::Payment(e) => {
                Some(WatcherError::Unprocessable(format!("recipient: {e}")))
            }
            e => Some(WatcherError::Wallet(format!("propose: {e:?}"))),
        });
        let proposal = match proposal {
            Ok(p) => p,
            Err(Some(e)) => return Err(e),
            Err(None) => {
                drop(db);
                return Err(not_spendable(state, tab.tab_id)?);
            }
        };
        if proposal.steps().len() != 1 {
            return Err(WatcherError::Unprocessable(
                "recipient needs a multi-step transaction (e.g. a TEX address); use a shielded or unified address".into(),
            ));
        }
        let step = proposal.steps().first();
        let inputs_zat: u64 = step.shielded_inputs().map_or(0, |i| {
            i.notes().iter().map(|n| u64::from(n.note().value())).sum()
        });
        let output_zat = step
            .transaction_request()
            .total()
            .map_err(|e| WatcherError::Wallet(format!("proposal total: {e:?}")))?
            .map_or(0, u64::from);
        let fee_zat = u64::from(step.balance().fee_required());
        let mut rng = OsRng;
        let pczt = create_pczt_from_proposal::<_, _, Infallible, _, Infallible, _>(
            &mut *db,
            &network,
            &SystemClock,
            &mut rng,
            account,
            OvkPolicy::Sender,
            &proposal,
            None,
            BundlePadding::DEFAULT,
        )
        .map_err(|e| WatcherError::Wallet(format!("create_pczt: {e:?}")))?;
        (pczt, inputs_zat, output_zat, fee_zat)
    };
    // The wallet lock is released: proving is CPU-bound and must not stall sync or reads.
    let created = started.elapsed();
    let txid = txid_of(pczt.clone())?;
    let expiry_height = *pczt.global().expiry_height();
    let pczt = prove(pczt)?;
    tracing::debug!(tab = %tab.tab_id, %txid, ?created, proved = ?started.elapsed(), "sweep proved");
    let bytes = pczt
        .serialize()
        .map_err(|e| WatcherError::Wallet(format!("serialize pczt: {e:?}")))?;
    let pczt_b64 = B64.encode(&bytes);
    state
        .meta
        .put_sweep(tab.tab_id, &txid, &pczt_b64, expiry_height)?;
    tracing::info!(tab = %tab.tab_id, "sweep offered");
    Ok(SweepOffer {
        pczt_b64,
        summary: SweepSummary {
            inputs_zat,
            output_zat,
            fee_zat,
            expiry_height,
            txid,
        },
    })
}

/// The tab's offered sweep if the wallet holds it extracted but unmined: its spends keep
/// the tab's notes unavailable until it is mined or expires.
pub fn pending_sweep(
    state: &AppState,
    tab_id: Uuid,
) -> Result<Option<crate::meta::SweepRow>, WatcherError> {
    let Some(sweep) = state.meta.get_sweep(tab_id)? else {
        return Ok(None);
    };
    Ok((state.wallet.transaction_mined_height(&sweep.txid)? == Some(None)).then_some(sweep))
}

/// Why a sweep proposal found nothing spendable: a pending sweep holds the notes, or they
/// lack confirmations (or the tab is empty).
fn not_spendable(state: &AppState, tab_id: Uuid) -> Result<WatcherError, WatcherError> {
    if let Some(sweep) = pending_sweep(state, tab_id)? {
        return Ok(WatcherError::Conflict(format!(
            "a sweep for txid {} is pending; retry /broadcast or wait for its expiry at height {}",
            sweep.txid, sweep.expiry_height
        )));
    }
    Ok(WatcherError::Conflict(format!(
        "not every note has {} confirmations yet (or the tab holds no funds); wait and retry",
        state.cfg.confirmations_sweep
    )))
}

/// The Orchard-family circuit for a PCZT's consensus branch. Orchard and Ironwood share
/// one circuit on every branch where Ironwood exists, so one key serves both bundles.
fn circuit_version(
    raw_branch_id: u32,
) -> Result<orchard::circuit::OrchardCircuitVersion, WatcherError> {
    let branch_id = BranchId::try_from(raw_branch_id)
        .map_err(|_| WatcherError::Unprocessable("PCZT has an unknown consensus branch".into()))?;
    bundle_version_for_branch(branch_id, orchard::ValuePool::Orchard)
        .map(|v| v.circuit_version())
        .ok_or_else(|| WatcherError::Unprocessable("PCZT branch does not support Orchard".into()))
}

/// Adds the Orchard/Ironwood (and, if any, Sapling) proofs, as zcash-devtool `pczt prove`.
fn prove(pczt: Pczt) -> Result<Pczt, WatcherError> {
    let werr = |what: &str, e: &dyn std::fmt::Debug| WatcherError::Wallet(format!("{what}: {e:?}"));
    let raw_branch_id = *pczt.global().consensus_branch_id();
    let mut prover = Prover::new(pczt);
    let (needs_orchard, needs_ironwood) = (
        prover.requires_orchard_proof(),
        prover.requires_ironwood_proof(),
    );
    if needs_orchard || needs_ironwood {
        let pk = orchard::circuit::ProvingKey::build(circuit_version(raw_branch_id)?);
        if needs_orchard {
            prover = prover
                .create_orchard_proof(OsRng, &pk)
                .map_err(|e| werr("orchard proof", &e))?;
        }
        if needs_ironwood {
            prover = prover
                .create_ironwood_proof(OsRng, &pk)
                .map_err(|e| werr("ironwood proof", &e))?;
        }
    }
    if prover.requires_sapling_proofs() {
        let local = LocalTxProver::bundled();
        prover = prover
            .create_sapling_proofs(OsRng, &local, &local)
            .map_err(|e| werr("sapling proofs", &e))?;
    }
    Ok(prover.finish())
}

/// Broadcasts a signed PCZT, but only if it is the sweep last offered for this tab and that
/// offer has not been broadcast yet. `Unprocessable` if it cannot be extracted (e.g. a
/// missing or bad signature). Holds the tab's sweep lock throughout, so the offer cannot be
/// replaced while this runs.
pub async fn broadcast_signed(
    state: &AppState,
    tab: &TabRow,
    pczt_b64: &str,
) -> Result<String, WatcherError> {
    let _guard = state.sweep_locks.try_acquire(tab.tab_id)?;
    let tab = reload(state, tab.tab_id)?;
    if tab.state != TabState::Open {
        return Err(WatcherError::Conflict(format!(
            "tab state is {}",
            tab.state.as_str()
        )));
    }
    let offered = state
        .meta
        .get_sweep(tab.tab_id)?
        .ok_or_else(|| WatcherError::Conflict("no sweep offered for this tab".into()))?;
    if offered.broadcast_at.is_some() {
        return Err(WatcherError::Conflict(
            "the offered sweep was already broadcast; request a new one".into(),
        ));
    }
    // URL-safe unpadded is what offers use; standard base64 (e.g. browser `btoa`) is
    // accepted too.
    let b64 = pczt_b64.trim();
    let bytes = B64
        .decode(b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(b64))
        .map_err(|e| WatcherError::Unprocessable(format!("pczt_b64: {e}")))?;
    let pczt = parse_pczt(&bytes)?;
    if txid_of(pczt.clone())? != offered.txid {
        return Err(WatcherError::Conflict(
            "signed PCZT does not match the offered sweep".into(),
        ));
    }
    // Already in the wallet means an earlier attempt extracted it and its send may have
    // reached the network even though that attempt failed (e.g. a transport error).
    let retry = state
        .wallet
        .transaction_mined_height(&offered.txid)?
        .is_some();
    let raw = if retry {
        // Extracted (and verified) by the earlier attempt: resend the stored transaction
        // rather than storing it again.
        stored_raw(state, &offered.txid)?
    } else {
        let state = state.clone();
        tokio::task::spawn_blocking(move || extract(&state, pczt))
            .await
            .map_err(|e| WatcherError::Internal(anyhow::anyhow!("extract task: {e}")))??
    };
    let mut client = state.client.lock().await;
    let resp = client
        .send_transaction(service::RawTransaction {
            data: raw,
            height: 0,
        })
        .await
        .map_err(|e| WatcherError::Remote(format!("send_transaction: {e}")))?
        .into_inner();
    drop(client);
    if resp.error_code != 0 && !(retry && already_known(&resp.error_message)) {
        return Err(WatcherError::Remote(format!(
            "lightwalletd rejected the transaction: {} {}",
            resp.error_code, resp.error_message
        )));
    }
    state.meta.mark_broadcast(tab.tab_id, &offered.txid)?;
    state.meta.set_tab_state(tab.tab_id, TabState::Sweeping)?;
    tracing::info!(tab = %tab.tab_id, "sweep broadcast");
    tracing::debug!(tab = %tab.tab_id, txid = %offered.txid, "sweep broadcast txid");
    Ok(offered.txid)
}

/// A node's rejection of a transaction it already has (zcashd: "txn-already-in-mempool",
/// "txn-already-known", "transaction already in block chain"; zebrad: "... already exists
/// in the mempool / already in state").
fn already_known(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("already")
}

/// Finalizes spends, verifies proofs and signatures, stores the transaction in the wallet
/// and returns its raw bytes.
fn extract(state: &AppState, pczt: Pczt) -> Result<Vec<u8>, WatcherError> {
    let local = LocalTxProver::bundled();
    let (spend_vk, output_vk) = local.verifying_keys();
    // Built before taking the wallet lock: key generation is the slow part of extraction.
    let orchard_vk = orchard::circuit::VerifyingKey::build(circuit_version(
        *pczt.global().consensus_branch_id(),
    )?);
    let mut rng = OsRng;
    let mut db = state.wallet.db();
    let txid = extract_and_store_transaction_from_pczt::<_, ()>(
        &mut *db,
        &SystemClock,
        &mut rng,
        pczt,
        Some((&spend_vk, &output_vk)),
        Some(&orchard_vk),
    )
    .map_err(|e| WatcherError::Unprocessable(format!("extract: {e:?}")))?;
    drop(db);
    stored_raw(state, &txid.to_string())
}

/// Raw bytes of wallet transaction `txid` (display hex).
fn stored_raw(state: &AppState, txid: &str) -> Result<Vec<u8>, WatcherError> {
    let id = TxId::from_hex(txid)
        .ok_or_else(|| WatcherError::Wallet(format!("txid {txid} is not hex")))?;
    let tx = state
        .wallet
        .db()
        .get_transaction(id)
        .map_err(|e| WatcherError::Wallet(format!("get_transaction: {e:?}")))?
        .ok_or_else(|| WatcherError::Wallet("sweep transaction is not in the wallet".into()))?;
    let mut raw = vec![];
    tx.write(&mut raw)
        .map_err(|e| WatcherError::Wallet(format!("serialize tx: {e}")))?;
    Ok(raw)
}

/// The tab's sweep progress. Moves `sweeping → closed` once the sweep has
/// `confirmations_sweep` confirmations, `sweeping → open` once the scanned chain is past its
/// expiry height without it having been mined, and `open → sweeping/closed` once the offered
/// sweep is seen mined (its broadcast succeeded although the request reporting it failed,
/// or the signer broadcast it).
pub async fn sweep_status(state: &AppState, tab: &TabRow) -> Result<SweepStatus, WatcherError> {
    let _guard = state.sweep_locks.acquire(tab.tab_id).await;
    let tab = reload(state, tab.tab_id)?;
    let Some(sweep) = state.meta.get_sweep(tab.tab_id)? else {
        return Ok(SweepStatus {
            state: tab.state,
            txid: None,
            mined_height: None,
            confirmations: 0,
        });
    };
    let tip = state.health.tip_height.load(Ordering::Relaxed);
    let synced = state.health.synced_height.load(Ordering::Relaxed);
    let mined = state.wallet.mined_height_of(&sweep.txid)?;
    let confirmations = confirmations(tip, mined);
    let new_state = next_state(
        tab.state,
        mined,
        confirmations,
        state.cfg.confirmations_sweep,
        synced,
        sweep.expiry_height,
    );
    if new_state != tab.state {
        if mined.is_some() && sweep.broadcast_at.is_none() {
            state.meta.mark_broadcast(tab.tab_id, &sweep.txid)?;
        }
        state.meta.set_tab_state(tab.tab_id, new_state)?;
        tracing::info!(tab = %tab.tab_id, state = new_state.as_str(), "sweep state changed");
    }
    Ok(SweepStatus {
        state: new_state,
        txid: Some(sweep.txid),
        mined_height: mined,
        confirmations,
    })
}

/// A tip below the mined height (stale tip after a restart or rewind) means 0, never 1.
fn confirmations(tip: u32, mined: Option<u32>) -> u32 {
    mined.and_then(|h| tip.checked_sub(h)).map_or(0, |d| d + 1)
}

/// `open`/`sweeping` → `closed` once the offered sweep is mined `required` deep;
/// `open` → `sweeping` once it is mined at all (shallower); `sweeping` → `open` once the
/// scanned height is past its expiry without it having been mined. Other states never move.
fn next_state(
    current: TabState,
    mined: Option<u32>,
    confirmations: u32,
    required: u32,
    synced: u32,
    expiry_height: u32,
) -> TabState {
    if !matches!(current, TabState::Open | TabState::Sweeping) {
        return current;
    }
    match mined {
        Some(_) if confirmations >= required.max(1) => TabState::Closed,
        Some(_) => TabState::Sweeping,
        None if current == TabState::Sweeping && synced > expiry_height => TabState::Open,
        None => current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn signed_pczt_must_match_offered_txid() {
        // Spike PCZTs: their transactions are already mined on testnet; no keys inside.
        let proved = fixture("sweep.proved.pczt");
        let signed = fixture("sweep.signed.pczt");
        let other = fixture("sweep2.proved.pczt");
        let offered = pczt_txid(&proved).unwrap();
        assert_eq!(pczt_txid(&signed).unwrap(), offered);
        assert_ne!(pczt_txid(&other).unwrap(), offered);
    }

    #[test]
    fn confirmations_are_zero_when_unmined_or_tip_lags() {
        assert_eq!(confirmations(100, None), 0);
        assert_eq!(confirmations(100, Some(101)), 0);
        assert_eq!(confirmations(100, Some(100)), 1);
        assert_eq!(confirmations(109, Some(100)), 10);
    }

    #[test]
    fn sweeping_closes_at_required_depth_and_reopens_after_expiry() {
        use TabState::*;
        // mined, not deep enough yet
        assert_eq!(next_state(Sweeping, Some(100), 9, 10, 108, 140), Sweeping);
        assert_eq!(next_state(Sweeping, Some(100), 10, 10, 109, 140), Closed);
        // unmined: waits through the expiry height, reopens only once scanned past it
        assert_eq!(next_state(Sweeping, None, 0, 10, 140, 140), Sweeping);
        assert_eq!(next_state(Sweeping, None, 0, 10, 141, 140), Open);
        // a required depth of 0 still needs the sweep mined
        assert_eq!(next_state(Sweeping, None, 0, 0, 100, 140), Sweeping);
        assert_eq!(next_state(Sweeping, Some(100), 1, 0, 100, 140), Closed);
        // other states never move here
        for s in [Closed, Abandoned] {
            assert_eq!(next_state(s, Some(1), 50, 10, 500, 2), s);
            assert_eq!(next_state(s, None, 0, 10, 500, 2), s);
        }
    }

    #[test]
    fn open_tab_follows_its_offered_sweep_once_mined() {
        use TabState::*;
        // Broadcast outcome unknown to the watcher, but the offered txid got mined.
        assert_eq!(next_state(Open, Some(100), 1, 10, 100, 140), Sweeping);
        assert_eq!(next_state(Open, Some(100), 10, 10, 109, 140), Closed);
        // Unmined: an open tab stays open, before or after the offer's expiry.
        assert_eq!(next_state(Open, None, 0, 10, 100, 140), Open);
        assert_eq!(next_state(Open, None, 0, 10, 500, 140), Open);
    }

    #[test]
    fn already_known_rejections_are_recognized() {
        for m in [
            "txn-already-in-mempool",
            "txn-already-known",
            "transaction already in block chain",
            "Transaction already exists in the mempool",
        ] {
            assert!(already_known(m), "{m}");
        }
        assert!(!already_known("bad-txns-inputs-spent"));
        assert!(!already_known(""));
    }
}
