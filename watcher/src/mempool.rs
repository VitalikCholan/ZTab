//! Mempool watcher: subscribes to `GetMempoolStream`, trial-decrypts each transaction with
//! every open tab's UFVK, and records sightings of payments to participant addresses.
//!
//! Sightings are hints for the UI only; this module never writes wallet state the sync loop
//! owns. It dials its own lightwalletd connection so it never waits on the shared client,
//! and takes only short std locks, never across an `.await`.

use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use futures_util::StreamExt;
use time::OffsetDateTime;
use zcash_client_backend::{
    data_api::{Account, WalletRead},
    decrypt_transaction,
    proto::service,
    TransferType,
};
use zcash_client_sqlite::AccountUuid;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId};

use crate::{error::WatcherError, http::AppState, meta::Sighting};

const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MempoolPass {
    pub seen: usize,
    pub matched: usize,
}

/// Runs mempool passes forever. lightwalletd ends the stream at every new block, so an
/// ended stream means "resubscribe" immediately; errors and panics resubscribe after an
/// exponential backoff.
pub async fn run_mempool_loop(state: AppState) -> ! {
    let mut backoff = Duration::from_secs(1);
    loop {
        let s = state.clone();
        match crate::sync::catch_panics(async move { mempool_pass(&s).await }).await {
            Ok(p) => {
                tracing::debug!(
                    seen = p.seen,
                    matched = p.matched,
                    "mempool stream ended; resubscribing"
                );
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                tracing::warn!(error = %e, "mempool stream failed; resubscribing after backoff");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

/// Clears the health flag when a pass ends for any reason, including an error or a panic.
struct Subscribed<'a>(&'a AtomicBool);

impl Drop for Subscribed<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// One subscription: processes every mempool transaction until the server closes the
/// stream (a new block) or the stream stays silent for ten block intervals.
pub async fn mempool_pass(state: &AppState) -> Result<MempoolPass, WatcherError> {
    // Own connection: the shared client is held by sync/sweep for seconds at a time.
    let mut client = crate::remote::connect(&state.cfg).await?;
    let mut stream = client
        .get_mempool_stream(service::Empty {})
        .await
        .map_err(|e| WatcherError::Remote(format!("get_mempool_stream: {e}")))?
        .into_inner();
    state
        .health
        .mempool_subscribed
        .store(true, Ordering::Relaxed);
    let _subscribed = Subscribed(&state.health.mempool_subscribed);
    let idle = Duration::from_secs(state.cfg.block_interval_seconds.max(30) * 10);
    let mut pass = MempoolPass {
        seen: 0,
        matched: 0,
    };
    loop {
        let item = match tokio::time::timeout(idle, stream.next()).await {
            Ok(Some(item)) => item,
            Ok(None) => break,
            Err(_) => {
                tracing::debug!("mempool stream idle; resubscribing");
                break;
            }
        };
        let raw = item.map_err(|e| WatcherError::Remote(format!("mempool stream: {e}")))?;
        pass.seen += 1;
        match record_sightings(state, &raw.data, OffsetDateTime::now_utc()) {
            Ok(n) => pass.matched += n,
            // A transaction we cannot parse is skipped, not a reason to drop the stream.
            Err(WatcherError::Unprocessable(e)) => {
                tracing::debug!(error = %e, "skipping unparseable mempool transaction")
            }
            Err(e) => return Err(e),
        }
    }
    Ok(pass)
}

/// Trial-decrypts `raw` with every open tab's UFVK and records a sighting per participant
/// paid by an incoming Orchard/Ironwood output; returns the number of matched outputs.
/// Change and outgoing outputs are ignored, as are all outputs of a transaction the tab's
/// account funded and incoming outputs to addresses outside `0..participants_count`.
/// Memos are discarded.
pub fn record_sightings(
    state: &AppState,
    raw: &[u8],
    now: OffsetDateTime,
) -> Result<usize, WatcherError> {
    let network = state.wallet.network();
    let tip = match state.health.tip_height.load(Ordering::Relaxed) {
        0 => None,
        h => Some(BlockHeight::from_u32(h)),
    };
    // The branch id only matters for pre-v5 transactions; v5+ carry their own.
    let branch = BranchId::for_height(&network, tip.map_or(BlockHeight::from_u32(1), |h| h + 1));
    let tx = Transaction::read(raw, branch)
        .map_err(|e| WatcherError::Unprocessable(format!("tx parse: {e}")))?;
    let open = state.meta.open_tabs()?;
    if open.is_empty() {
        return Ok(0);
    }
    let mut ufvks = HashMap::new();
    let mut tabs = HashMap::new();
    {
        let db = state.wallet.db();
        for tab in open {
            let acct = AccountUuid::from_uuid(tab.account_uuid);
            let account = db
                .get_account(acct)
                .map_err(|e| WatcherError::Wallet(format!("get_account: {e:?}")))?;
            if let Some(ufvk) = account.and_then(|a| a.ufvk().cloned()) {
                ufvks.insert(acct, ufvk);
                tabs.insert(acct, tab);
            }
        }
    }
    let decrypted = decrypt_transaction(&network, None, tip, &tx, &ufvks);
    let txid = tx.txid().to_string();
    let first_seen_at = crate::meta::rfc3339(now)?;
    let orchard_family = || {
        decrypted
            .orchard_outputs()
            .iter()
            .chain(decrypted.ironwood_outputs())
    };
    // An account that recovered an output with its OVK, or received change, funded the
    // transaction. Like the block scanner, its outputs to its own addresses are then not
    // participant payments (a tab only ever sends in a sweep).
    let funded_by: HashSet<AccountUuid> = orchard_family()
        .filter(|o| o.transfer_type() != TransferType::Incoming)
        .map(|o| *o.account())
        .chain(
            decrypted
                .sapling_outputs()
                .iter()
                .filter(|o| o.transfer_type() != TransferType::Incoming)
                .map(|o| *o.account()),
        )
        .collect();
    // Several outputs to one participant in one transaction form one sighting (the row is
    // keyed by txid, tab and participant), so their values are summed.
    let mut paid: HashMap<(uuid::Uuid, u32), u64> = HashMap::new();
    let mut count = 0;
    for out in orchard_family() {
        if out.transfer_type() != TransferType::Incoming || funded_by.contains(out.account()) {
            continue;
        }
        let Some(tab) = tabs.get(out.account()) else {
            continue;
        };
        let (note, _pool) = out.note();
        let Some(index) = state.wallet.index_for_orchard_address(
            *out.account(),
            tab.participants_count,
            &note.recipient(),
        )?
        else {
            continue;
        };
        *paid.entry((tab.tab_id, index)).or_default() += note.value().inner();
        count += 1;
    }
    for ((tab_id, index), value_zat) in paid {
        state.meta.upsert_sighting(
            &Sighting {
                txid: txid.clone(),
                participant_index: index,
                value_zat,
                first_seen_at: first_seen_at.clone(),
            },
            tab_id,
        )?;
        tracing::debug!(txid = %txid, "mempool sighting recorded");
    }
    Ok(count)
}
