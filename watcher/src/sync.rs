//! Block sync: subtree roots, chain tip, compact-block download and scanning, reorg rewind.
//! A port of zcash-devtool `commands/wallet/sync.rs` without the TUI and UTXO refresh.
//!
//! Locking: `sync_once` holds the tokio `client` lock for the whole block pass; wallet
//! `db()`/`cache()` and meta mutexes are only taken inside synchronous helpers that return
//! before the next `.await`.

use std::{path::Path, sync::atomic::Ordering, time::Duration};

use futures_util::TryStreamExt;
use orchard::tree::MerkleHashOrchard;
use prost::Message;
use tokio::io::AsyncWriteExt;
use zcash_client_backend::{
    data_api::{
        chain::{error::Error as ChainError, scan_cached_blocks, ChainState, CommitmentTreeRoot},
        scanning::ScanRange,
        WalletCommitmentTrees, WalletRead, WalletWrite,
    },
    proto::{
        compact_formats::CompactBlock,
        service::{self, BlockId},
    },
};
use zcash_client_sqlite::{chain::BlockMeta, error::SqliteClientError};
use zcash_primitives::{block::BlockHash, merkle_tree::HashSer, transaction::Transaction};
use zcash_protocol::consensus::{BlockHeight, BranchId};
use zcash_transparent::bundle::{Authorization, Bundle};

use crate::{
    error::WatcherError,
    http::AppState,
    remote::{self, LwdClient},
};

/// Blocks downloaded and scanned per batch.
const BATCH_SIZE: u32 = 1_000;
/// When a reorg is detected, rewind this many blocks below the reorg point.
const REORG_REWIND_MARGIN: u32 = 10;
/// More rewinds than this in one pass means the server keeps contradicting itself.
const MAX_REWINDS_PER_PASS: u32 = 3;
/// Upper bound on batches per pass (10M blocks), so a wedged scan queue cannot spin forever.
const MAX_BATCHES_PER_PASS: u32 = 10_000;
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncReport {
    pub tip: u32,
    pub scanned_to: u32,
    pub rewound_to: Option<u32>,
}

fn werr(ctx: &str, e: impl std::fmt::Debug) -> WatcherError {
    WatcherError::Wallet(format!("{ctx}: {e:?}"))
}

fn rerr(ctx: &str, e: impl std::fmt::Display) -> WatcherError {
    WatcherError::Remote(format!("{ctx}: {e}"))
}

/// The pause after a pass: `base` after success, otherwise double the previous pause,
/// capped at 60 s.
pub fn next_backoff(prev: Duration, base: Duration, ok: bool) -> Duration {
    if ok {
        base
    } else {
        prev.saturating_mul(2)
            .min(MAX_BACKOFF)
            .max(base.min(MAX_BACKOFF))
    }
}

pub fn base_interval(block_interval_seconds: u64) -> Duration {
    Duration::from_secs((block_interval_seconds / 2).max(5))
}

pub async fn run_sync_loop(state: AppState) -> ! {
    let base = base_interval(state.cfg.block_interval_seconds);
    let mut pause = base;
    loop {
        let s = state.clone();
        pause = loop_step(pause, base, async move { sync_once(&s).await }).await;
        tokio::time::sleep(pause).await;
    }
}

/// Runs one iteration with panics contained, logs the outcome, and returns the next pause.
async fn loop_step<F>(pause: Duration, base: Duration, iteration: F) -> Duration
where
    F: std::future::Future<Output = Result<SyncReport, WatcherError>> + Send + 'static,
{
    let ok = match catch_panics(iteration).await {
        Ok(r) => {
            tracing::debug!(
                tip = r.tip,
                scanned_to = r.scanned_to,
                rewound_to = r.rewound_to,
                "sync ok"
            );
            true
        }
        Err(e) => {
            tracing::warn!(error = %e, "sync failed");
            false
        }
    };
    next_backoff(pause, base, ok)
}

/// Runs `f` on its own task so a panic (e.g. inside the scanner on hostile remote data)
/// becomes an error instead of killing the sync loop.
async fn catch_panics<T, F>(f: F) -> Result<T, WatcherError>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, WatcherError>> + Send + 'static,
{
    match tokio::spawn(f).await {
        Ok(r) => r,
        Err(e) if e.is_panic() => Err(WatcherError::Internal(anyhow::anyhow!(
            "sync iteration panicked"
        ))),
        Err(e) => Err(WatcherError::Internal(anyhow::anyhow!(
            "sync iteration aborted: {e}"
        ))),
    }
}

pub async fn sync_once(state: &AppState) -> Result<SyncReport, WatcherError> {
    let mut client = state.client.lock().await;

    let (tip, tip_hash) = remote::latest_height(&mut client).await?;
    state
        .health
        .tip_height
        .store(u32::from(tip), Ordering::Relaxed);
    // Without accounts the wallet has no birthday, and `update_chain_tip` would queue
    // everything above the last completed shard (~400k testnet blocks). Nothing to watch
    // means nothing to scan: the first imported tab's birthday bounds the first scan.
    if !wallet_has_accounts(state)? {
        mark_synced(state, u32::from(tip));
        return Ok(SyncReport {
            tip: u32::from(tip),
            scanned_to: u32::from(tip),
            rewound_to: None,
        });
    }

    update_subtree_roots(&mut client, state).await?;
    let mut rewound_to = apply_chain_tip(state, tip, tip_hash)?;

    let mut rewinds = 0u32;
    let mut batches = 0u32;
    loop {
        let Some(range) = next_batch(state)? else {
            break;
        };
        batches += 1;
        if batches > MAX_BATCHES_PER_PASS {
            return Err(WatcherError::Wallet(
                "scan queue did not drain within the batch limit".into(),
            ));
        }
        let metas = download_blocks(&mut client, state, &range).await?;
        let chain_state = download_chain_state(&mut client, range.block_range().start - 1).await?;
        let outcome = scan_batch(state, &chain_state, &range, tip);
        // Scanned (or rejected) blocks are not needed on disk any more either way.
        delete_cached_blocks(state.wallet.blocks_dir(), &metas).await;
        if let ScanOutcome::Rewound(h) = outcome? {
            rewinds += 1;
            rewound_to = Some(u32::from(h));
            if rewinds > MAX_REWINDS_PER_PASS {
                return Err(WatcherError::Remote(format!(
                    "{rewinds} reorg rewinds in one pass; giving up until the next pass"
                )));
            }
        }
    }

    let scanned_to = state
        .wallet
        .db()
        .block_fully_scanned()
        .map_err(|e| werr("block_fully_scanned", e))?
        .map_or(0, |m| u32::from(m.block_height()));
    mark_synced(state, scanned_to);
    drop(client);
    if batches > 0 || rewound_to.is_some() {
        tracing::info!(
            tip = u32::from(tip),
            scanned_to,
            batches,
            rewound_to,
            "sync pass complete"
        );
    }

    refresh_transparent_sources_for_open_tabs(state).await?;
    Ok(SyncReport {
        tip: u32::from(tip),
        scanned_to,
        rewound_to,
    })
}

fn wallet_has_accounts(state: &AppState) -> Result<bool, WatcherError> {
    Ok(!state
        .wallet
        .db()
        .get_account_ids()
        .map_err(|e| werr("get_account_ids", e))?
        .is_empty())
}

fn mark_synced(state: &AppState, scanned_to: u32) {
    state
        .health
        .synced_height
        .store(scanned_to, Ordering::Relaxed);
    if let Ok(mut t) = state.health.last_ok_at.lock() {
        *t = Some(time::OffsetDateTime::now_utc());
    }
}

/// Downloads the Sapling, Orchard and Ironwood subtree roots and stores them, so the
/// wallet can scan out of order and skip shards with no relevant notes.
async fn update_subtree_roots(
    client: &mut LwdClient,
    state: &AppState,
) -> Result<(), WatcherError> {
    let sapling = fetch_subtree_roots(client, service::ShieldedProtocol::Sapling)
        .await?
        .into_iter()
        .map(|(h, bytes)| {
            sapling_crypto::Node::read(&bytes[..])
                .map(|n| CommitmentTreeRoot::from_parts(h, n))
                .map_err(|e| rerr("sapling subtree root", e))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let orchard =
        orchard_roots(fetch_subtree_roots(client, service::ShieldedProtocol::Orchard).await?)?;
    // Ironwood note commitments are Orchard-shaped; a pre-Ironwood server streams none.
    let ironwood =
        orchard_roots(fetch_subtree_roots(client, service::ShieldedProtocol::Ironwood).await?)?;
    tracing::debug!(
        sapling = sapling.len(),
        orchard = orchard.len(),
        ironwood = ironwood.len(),
        "subtree roots"
    );
    let mut db = state.wallet.db();
    db.put_sapling_subtree_roots(0, &sapling)
        .map_err(|e| werr("put_sapling_subtree_roots", e))?;
    db.put_orchard_subtree_roots(0, &orchard)
        .map_err(|e| werr("put_orchard_subtree_roots", e))?;
    db.put_ironwood_subtree_roots(0, &ironwood)
        .map_err(|e| werr("put_ironwood_subtree_roots", e))?;
    Ok(())
}

async fn fetch_subtree_roots(
    client: &mut LwdClient,
    protocol: service::ShieldedProtocol,
) -> Result<Vec<(BlockHeight, Vec<u8>)>, WatcherError> {
    let mut request = service::GetSubtreeRootsArg::default();
    request.set_shielded_protocol(protocol);
    let roots: Vec<service::SubtreeRoot> = client
        .get_subtree_roots(request)
        .await
        .map_err(|e| rerr("get_subtree_roots", e))?
        .into_inner()
        .try_collect()
        .await
        .map_err(|e| rerr("get_subtree_roots stream", e))?;
    roots
        .into_iter()
        .map(|r| {
            let h = u32::try_from(r.completing_block_height)
                .map_err(|_| WatcherError::Remote("subtree root height overflow".into()))?;
            Ok((BlockHeight::from_u32(h), r.root_hash))
        })
        .collect()
}

fn orchard_roots(
    raw: Vec<(BlockHeight, Vec<u8>)>,
) -> Result<Vec<CommitmentTreeRoot<MerkleHashOrchard>>, WatcherError> {
    raw.into_iter()
        .map(|(h, bytes)| {
            MerkleHashOrchard::read(&bytes[..])
                .map(|n| CommitmentTreeRoot::from_parts(h, n))
                .map_err(|e| rerr("orchard subtree root", e))
        })
        .collect()
}

/// Tells the wallet about the tip. If the node's tip is below our scanned height and its
/// hash differs from ours at that height, the chain was rolled back: rewind (devtool logic;
/// a lagging node with matching history is not a reorg and is left alone).
fn apply_chain_tip(
    state: &AppState,
    tip: BlockHeight,
    tip_hash: BlockHash,
) -> Result<Option<u32>, WatcherError> {
    let mut db = state.wallet.db();
    db.update_chain_tip(tip)
        .map_err(|e| werr("update_chain_tip", e))?;
    let Some(max_scanned) = db
        .block_max_scanned()
        .map_err(|e| werr("block_max_scanned", e))?
        .map(|b| b.block_height())
    else {
        return Ok(None);
    };
    let ours = db
        .block_metadata(tip)
        .map_err(|e| werr("block_metadata", e))?
        .map(|m| m.block_hash());
    if tip < max_scanned && ours != Some(tip_hash) {
        let requested = tip.saturating_sub(REORG_REWIND_MARGIN);
        tracing::warn!(
            tip = u32::from(tip),
            max_scanned = u32::from(max_scanned),
            requested = u32::from(requested),
            "chain tip diverges from scanned history; rewinding"
        );
        let cache = state.wallet.cache();
        let h = rewind(
            &mut db,
            &cache,
            state.wallet.blocks_dir(),
            tip,
            requested,
            tip,
        )?;
        return Ok(Some(u32::from(h)));
    }
    Ok(None)
}

/// The highest-priority suggested range, limited to `BATCH_SIZE` blocks.
fn next_batch(state: &AppState) -> Result<Option<ScanRange>, WatcherError> {
    let ranges = state
        .wallet
        .db()
        .suggest_scan_ranges()
        .map_err(|e| werr("suggest_scan_ranges", e))?;
    Ok(ranges.into_iter().find(|r| !r.is_empty()).map(|r| {
        let end = r.block_range().start + BATCH_SIZE;
        r.truncate_end(end).unwrap_or(r)
    }))
}

async fn download_blocks(
    client: &mut LwdClient,
    state: &AppState,
    range: &ScanRange,
) -> Result<Vec<BlockMeta>, WatcherError> {
    tracing::debug!(
        start = u32::from(range.block_range().start),
        end = u32::from(range.block_range().end),
        "fetching blocks"
    );
    let request = service::BlockRange {
        start: Some(BlockId {
            height: u64::from(range.block_range().start),
            hash: vec![],
        }),
        end: Some(BlockId {
            height: u64::from(range.block_range().end - 1),
            hash: vec![],
        }),
        pool_types: Default::default(),
    };
    let mut stream = client
        .get_block_range(request)
        .await
        .map_err(|e| rerr("get_block_range", e))?
        .into_inner();
    let blocks_dir = state.wallet.blocks_dir();
    let mut metas = Vec::with_capacity(range.len());
    while let Some(block) = stream
        .try_next()
        .await
        .map_err(|e| rerr("get_block_range stream", e))?
    {
        let meta = validated_block_meta(&block)?;
        if !range.block_range().contains(&meta.height) {
            delete_cached_blocks(blocks_dir, &metas).await;
            return Err(WatcherError::Remote(format!(
                "server sent block {} outside the requested range",
                meta.height
            )));
        }
        let mut file = tokio::fs::File::create(meta.block_file_path(&blocks_dir))
            .await
            .map_err(|e| werr("create block file", e))?;
        file.write_all(&block.encode_to_vec())
            .await
            .map_err(|e| werr("write block file", e))?;
        metas.push(meta);
    }
    if metas.len() != range.len() {
        delete_cached_blocks(blocks_dir, &metas).await;
        return Err(WatcherError::Remote(format!(
            "server returned {} of {} blocks",
            metas.len(),
            range.len()
        )));
    }
    state
        .wallet
        .cache()
        .write_block_metadata(&metas)
        .map_err(|e| werr("write_block_metadata", e))?;
    Ok(metas)
}

/// Builds cache metadata from a server block, rejecting the shapes on which the
/// `CompactBlock::height`/`hash`/`prev_hash` accessors (used here and by the scanner) panic.
fn validated_block_meta(block: &CompactBlock) -> Result<BlockMeta, WatcherError> {
    let height = u32::try_from(block.height)
        .map_err(|_| WatcherError::Remote(format!("block height {} overflows", block.height)))?;
    if block.header().is_none() && (block.hash.len() != 32 || block.prev_hash.len() != 32) {
        return Err(WatcherError::Remote(format!(
            "block {height} has no header and a hash that is not 32 bytes"
        )));
    }
    let (sapling_outputs_count, orchard_actions_count) =
        block.vtx.iter().fold((0u32, 0u32), |(s, o), tx| {
            (
                s.saturating_add(u32::try_from(tx.outputs.len()).unwrap_or(u32::MAX)),
                o.saturating_add(u32::try_from(tx.actions.len()).unwrap_or(u32::MAX)),
            )
        });
    Ok(BlockMeta {
        height: BlockHeight::from_u32(height),
        block_hash: block.hash(),
        block_time: block.time,
        sapling_outputs_count,
        orchard_actions_count,
    })
}

async fn download_chain_state(
    client: &mut LwdClient,
    height: BlockHeight,
) -> Result<ChainState, WatcherError> {
    client
        .get_tree_state(BlockId {
            height: u64::from(height),
            hash: vec![],
        })
        .await
        .map_err(|e| rerr("get_tree_state", e))?
        .into_inner()
        .to_chain_state()
        .map_err(|e| rerr("tree state", e))
}

/// Removes the given compact-block files, tolerating files that are already gone.
async fn delete_cached_blocks(blocks_dir: &Path, metas: &[BlockMeta]) {
    for meta in metas {
        if let Err(e) = tokio::fs::remove_file(meta.block_file_path(&blocks_dir)).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(height = u32::from(meta.height), error = %e, "failed to remove cached block");
            }
        }
    }
}

enum ScanOutcome {
    Done,
    Rewound(BlockHeight),
}

fn scan_batch(
    state: &AppState,
    chain_state: &ChainState,
    range: &ScanRange,
    tip: BlockHeight,
) -> Result<ScanOutcome, WatcherError> {
    let network = state.wallet.network();
    let mut db = state.wallet.db();
    let cache = state.wallet.cache();
    match scan_cached_blocks(
        &network,
        &*cache,
        &mut *db,
        range.block_range().start,
        chain_state,
        range.len(),
    ) {
        Ok(_) => Ok(ScanOutcome::Done),
        Err(ChainError::Scan(err)) if err.is_continuity_error() => {
            let at = err.at_height();
            let requested = at.saturating_sub(REORG_REWIND_MARGIN);
            tracing::warn!(
                at = u32::from(at),
                requested = u32::from(requested),
                "chain reorg detected; rewinding"
            );
            let h = rewind(
                &mut db,
                &cache,
                state.wallet.blocks_dir(),
                at,
                requested,
                tip,
            )?;
            Ok(ScanOutcome::Rewound(h))
        }
        Err(e) => Err(werr("scan_cached_blocks", e)),
    }
}

/// Rewinds wallet and block cache to `requested` (devtool/zecd logic). `truncate_to_height`
/// only rewinds to a height with a note-commitment-tree checkpoint, so if `requested` has
/// none we retry at `at - 2`; if that fails too the reorg is deeper than our history.
fn rewind(
    db: &mut crate::wallet::Db,
    cache: &zcash_client_sqlite::FsBlockDb,
    blocks_dir: &Path,
    at: BlockHeight,
    requested: BlockHeight,
    tip: BlockHeight,
) -> Result<BlockHeight, WatcherError> {
    let rewound = match db.truncate_to_height(requested) {
        Ok(h) => h,
        Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
            match db.truncate_to_height(at.saturating_sub(2)) {
                Ok(h) => h,
                Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
                    return Err(WatcherError::Wallet(format!(
                        "unrecoverable reorg at {at}: no checkpoint below the conflict \
                         (requested {requested}); reset the wallet to resync"
                    )))
                }
                Err(e) => return Err(werr("truncate_to_height", e)),
            }
        }
        Err(e) => return Err(werr("truncate_to_height", e)),
    };
    delete_block_files_above(blocks_dir, rewound);
    cache
        .truncate_to_height(rewound)
        .map_err(|e| werr("cache truncate_to_height", e))?;
    // Truncation trims the scan queue; re-apply the tip so the replacement chain is scanned.
    db.update_chain_tip(tip)
        .map_err(|e| werr("update_chain_tip", e))?;
    tracing::warn!(rewound_to = u32::from(rewound), "wallet rewound");
    Ok(rewound)
}

/// Deletes cached block files (`<height>-<hash>-compactblock`) above `height`.
fn delete_block_files_above(blocks_dir: &Path, height: BlockHeight) {
    let Ok(entries) = std::fs::read_dir(blocks_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_height = entry
            .file_name()
            .to_str()
            .and_then(|n| n.split('-').next())
            .and_then(|h| h.parse::<u32>().ok());
        if file_height.is_some_and(|h| h > u32::from(height)) {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error = %e, "failed to delete cached block");
                }
            }
        }
    }
}

/// Converts a display-order (byte-reversed) hex txid to internal byte order.
pub fn txid_internal_bytes(display_hex: &str) -> Result<[u8; 32], WatcherError> {
    let mut b: [u8; 32] = hex::decode(display_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| WatcherError::Wallet(format!("malformed txid {display_hex:?}")))?;
    b.reverse();
    Ok(b)
}

/// True when the transaction spends at least one transparent input.
pub fn spends_transparent<A: Authorization>(bundle: Option<&Bundle<A>>) -> bool {
    bundle.is_some_and(|b| !b.vin.is_empty())
}

async fn refresh_transparent_sources_for_open_tabs(state: &AppState) -> Result<(), WatcherError> {
    let mut txids = Vec::new();
    for tab in state.meta.open_tabs()? {
        for n in crate::facts::note_rows(&state.wallet, tab.account_uuid)? {
            if n.mined_height.is_some() && !txids.contains(&n.txid) {
                txids.push(n.txid);
            }
        }
    }
    refresh_transparent_sources(state, &txids).await
}

/// For each txid (display hex) without a `tx_sources` row, fetches the full transaction
/// and records whether it spends transparent inputs. Transactions the node reports as
/// unmined, or that fail to parse, are skipped and retried on the next pass.
pub async fn refresh_transparent_sources(
    state: &AppState,
    txids: &[String],
) -> Result<(), WatcherError> {
    let network = state.wallet.network();
    let mut client = state.client.lock().await;
    let mut stored = 0usize;
    for txid in txids {
        if state.meta.transparent_source(txid)?.is_some() {
            continue;
        }
        let internal = txid_internal_bytes(txid)?;
        let raw = client
            .get_transaction(service::TxFilter {
                hash: internal.to_vec(),
                ..Default::default()
            })
            .await
            .map_err(|e| rerr("get_transaction", e))?
            .into_inner();
        // 0 and u64::MAX are lightwalletd's "not mined" sentinels.
        let height = match u32::try_from(raw.height) {
            Ok(h) if h > 0 => BlockHeight::from_u32(h),
            _ => {
                tracing::debug!(txid = %txid, "transaction not mined per node; skipping");
                continue;
            }
        };
        let tx = match Transaction::read(&raw.data[..], BranchId::for_height(&network, height)) {
            Ok(tx) if tx.txid().as_ref() == &internal => tx,
            Ok(_) => {
                tracing::warn!(txid = %txid, "node returned a different transaction; skipping");
                continue;
            }
            Err(e) => {
                tracing::warn!(txid = %txid, error = %e, "unparseable transaction; skipping");
                continue;
            }
        };
        state
            .meta
            .set_transparent_source(txid, spends_transparent(tx.transparent_bundle()))?;
        stored += 1;
    }
    if stored > 0 {
        tracing::info!(count = stored, "transparent sources recorded");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_transparent::bundle::{OutPoint, TxIn};

    #[test]
    fn backoff_doubles_and_caps_at_60s() {
        let base = Duration::from_secs(12);
        let mut d = base;
        let mut seen = vec![];
        for _ in 0..5 {
            d = next_backoff(d, base, false);
            seen.push(d.as_secs());
        }
        assert_eq!(seen, vec![24, 48, 60, 60, 60]);
        assert_eq!(next_backoff(d, base, true), base);
        // A base above the cap never exceeds it on errors.
        let big = Duration::from_secs(90);
        assert_eq!(next_backoff(big, big, false), MAX_BACKOFF);
    }

    #[test]
    fn base_interval_is_half_block_time_min_5s() {
        assert_eq!(base_interval(75), Duration::from_secs(37));
        assert_eq!(base_interval(25), Duration::from_secs(12));
        assert_eq!(base_interval(4), Duration::from_secs(5));
    }

    #[test]
    fn display_hex_txid_is_reversed_to_internal_order() {
        let display = format!("{}{}", "00".repeat(31), "ff");
        let b = txid_internal_bytes(&display).unwrap();
        assert_eq!(b[0], 0xff);
        assert!(b[1..].iter().all(|&x| x == 0));
        let mut seq: Vec<u8> = (0u8..32).collect();
        let internal = txid_internal_bytes(&hex::encode(&seq)).unwrap();
        seq.reverse();
        assert_eq!(internal.to_vec(), seq);
        assert!(txid_internal_bytes("abcd").is_err());
        assert!(txid_internal_bytes(&"zz".repeat(32)).is_err());
    }

    fn block(height: u64, hash_len: usize, prev_len: usize) -> CompactBlock {
        CompactBlock {
            height,
            hash: vec![1; hash_len],
            prev_hash: vec![2; prev_len],
            ..Default::default()
        }
    }

    #[test]
    fn malformed_server_blocks_are_rejected_before_accessors() {
        let ok = validated_block_meta(&block(4_500_000, 32, 32)).unwrap();
        assert_eq!(u32::from(ok.height), 4_500_000);
        assert_eq!(ok.block_hash.0, [1; 32]);
        for bad in [
            block(u64::from(u32::MAX) + 1, 32, 32),
            block(4_500_000, 31, 32),
            block(4_500_000, 32, 0),
        ] {
            assert!(matches!(
                validated_block_meta(&bad),
                Err(WatcherError::Remote(_))
            ));
        }
    }

    #[tokio::test]
    async fn panicking_iteration_becomes_error_and_loop_continues() {
        let base = Duration::from_secs(12);
        let report = SyncReport {
            tip: 10,
            scanned_to: 10,
            rewound_to: None,
        };
        let r: Result<SyncReport, _> = catch_panics(async { panic!("hostile block") }).await;
        assert!(matches!(r, Err(WatcherError::Internal(_))));
        // A panicking step backs off; the next step runs and succeeds.
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut pause = base;
        for _ in 0..2 {
            let a = attempts.clone();
            pause = loop_step(pause, base, async move {
                if a.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("first iteration panics");
                }
                Ok(report)
            })
            .await;
            if attempts.load(Ordering::SeqCst) == 1 {
                assert_eq!(pause, Duration::from_secs(24));
            }
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(pause, base);
    }

    #[derive(Debug)]
    struct NoAuth;
    impl Authorization for NoAuth {
        type ScriptSig = ();
    }

    #[test]
    fn transparent_source_predicate() {
        assert!(!spends_transparent::<NoAuth>(None));
        let empty = Bundle::<NoAuth> {
            vin: vec![],
            vout: vec![],
            authorization: NoAuth,
        };
        assert!(!spends_transparent(Some(&empty)));
        let spending = Bundle::<NoAuth> {
            vin: vec![TxIn::from_parts(OutPoint::new([7; 32], 0), (), 0)],
            vout: vec![],
            authorization: NoAuth,
        };
        assert!(spends_transparent(Some(&spending)));
    }
}
