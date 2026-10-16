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

/// A pass shorter than this did not last until a plausible new block: the server or a
/// proxy closed the stream right away, so the next subscription is delayed like a failure.
const MIN_HEALTHY_PASS: Duration = Duration::from_secs(2);
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);

/// Pacing between passes: returns `(sleep before the next pass, next backoff)`.
/// A pass that ended normally after at least `MIN_HEALTHY_PASS` resubscribes at once and
/// resets the backoff; a failed or instantly-ended pass sleeps `backoff` and doubles it, so
/// a server that keeps closing the stream is never hammered with fresh TLS connections.
pub fn pace(ok: bool, pass_duration: Duration, backoff: Duration) -> (Duration, Duration) {
    if ok && pass_duration >= MIN_HEALTHY_PASS {
        (Duration::ZERO, INITIAL_BACKOFF)
    } else {
        (backoff, (backoff * 2).min(MAX_BACKOFF))
    }
}

/// Runs mempool passes forever. lightwalletd ends the stream at every new block, so an
/// ended stream always means "resubscribe" (never "mempool empty"); errors, panics and
/// streams that end instantly resubscribe after an exponential backoff (see [`pace`]).
pub async fn run_mempool_loop(state: AppState) -> ! {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        let s = state.clone();
        let started = tokio::time::Instant::now();
        let ok = match crate::sync::catch_panics(async move { mempool_pass(&s).await }).await {
            Ok(p) => {
                tracing::debug!(
                    seen = p.seen,
                    matched = p.matched,
                    "mempool stream ended; resubscribing"
                );
                true
            }
            Err(e) => {
                tracing::warn!(
                    kind = e.kind(),
                    "mempool stream failed; resubscribing after backoff"
                );
                tracing::debug!(error = %e, "mempool failure detail");
                false
            }
        };
        let (sleep, next) = pace(ok, started.elapsed(), backoff);
        backoff = next;
        if !sleep.is_zero() {
            tokio::time::sleep(sleep).await;
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
    let mut stream = crate::remote::with_timeout(
        "get_mempool_stream",
        crate::remote::STREAM_START_TIMEOUT,
        client.get_mempool_stream(service::Empty {}),
    )
    .await?
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
    // Sightings of transactions that can no longer be mined are not mempool facts.
    let cutoff =
        crate::meta::sighting_cutoff(OffsetDateTime::now_utc(), state.cfg.block_interval_seconds);
    let pruned = state.meta.prune_sightings_older_than(cutoff)?;
    if pruned > 0 {
        tracing::debug!(pruned, "pruned stale mempool sightings");
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
            || crate::facts::ensure_tab_addresses(&state.wallet, &state.meta, tab),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pace_resubscribes_at_once_after_a_normal_pass() {
        let (sleep, next) = pace(true, Duration::from_secs(40), Duration::from_secs(16));
        assert_eq!(sleep, Duration::ZERO);
        assert_eq!(next, INITIAL_BACKOFF);
    }

    #[test]
    fn pace_backs_off_on_instantly_ended_streams() {
        let mut backoff = INITIAL_BACKOFF;
        let mut sleeps = Vec::new();
        for _ in 0..8 {
            let (sleep, next) = pace(true, Duration::from_millis(50), backoff);
            sleeps.push(sleep.as_secs());
            backoff = next;
        }
        assert_eq!(sleeps, [1, 2, 4, 8, 16, 32, 60, 60]);
    }

    #[test]
    fn pace_backs_off_on_errors_however_long_the_pass() {
        let (sleep, next) = pace(false, Duration::from_secs(300), Duration::from_secs(4));
        assert_eq!(sleep, Duration::from_secs(4));
        assert_eq!(next, Duration::from_secs(8));
    }
}
