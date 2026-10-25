use crate::{
    config::Config,
    error::WatcherError,
    meta::{MetaStore, Sighting, TabRow, TabState},
    wallet::WalletStore,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Serialize, Clone, Debug)]
pub struct Payment {
    pub txid: String,
    pub value_zat: u64,
    pub mined_height: Option<u32>,
    pub confirmations: u32,
    pub transparent_source: bool,
    pub first_seen_at: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct StatusFacts {
    pub confirmed_zat: u64,
    pub mempool_zat: u64,
    pub best_confirmations: u32,
    pub transparent_source: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ParticipantFacts {
    pub index: u32,
    pub address: String,
    pub payments: Vec<Payment>,
    pub status_facts: StatusFacts,
}

#[derive(Serialize, Clone, Debug)]
pub struct TabFacts {
    pub tab_id: Uuid,
    pub state: TabState,
    pub active: bool,
    pub synced_height: u32,
    pub tip_height: u32,
    pub stale: bool,
    pub participants: Vec<ParticipantFacts>,
    pub balance: TabBalance,
}

/// What the tab's account holds right now, from its unspent notes and its sweep history.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct TabBalance {
    /// Unspent notes at least `confirmations_sweep` deep: what a sweep takes today.
    pub spendable_zat: u64,
    /// Unspent notes still shallower than that, mined or in the mempool.
    pub pending_zat: u64,
    /// Output of the tab's sweeps that are mined.
    pub swept_zat: u64,
    /// Fewest confirmations over the unspent mined notes; `None` when there are none.
    pub min_unspent_confirmations: Option<u32>,
    /// What a sweep requested now would send, after its fee ([`plan_sweep`]); 0 when a
    /// sweep would be refused.
    pub sweepable_zat: u64,
}

/// Most notes one sweep spends. ZIP 317 charges per action, so the fee of a sweep of
/// 50 notes (250 000 zat) stays well under the browser's 500 000-zat cap.
pub const SWEEP_MAX_INPUTS: usize = 50;
/// ZIP 317 marginal fee per logical action; a note worth no more than this is not swept.
pub const ZIP317_MARGINAL_FEE: u64 = 5_000;

/// The notes one sweep takes: the largest eligible ones, at most [`SWEEP_MAX_INPUTS`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SweepPlan {
    pub inputs: usize,
    pub inputs_zat: u64,
    pub fee_zat: u64,
    pub output_zat: u64,
    /// Every unspent note's value not taken by this sweep (young notes, dust, notes past
    /// the input cap).
    pub remaining_zat: u64,
}

/// Confirmations of a note at `tip`; a tip below the mined height (or no height) is 0.
fn note_confirmations(n: &UnspentNote, tip: u32) -> u32 {
    n.mined_height
        .and_then(|h| tip.checked_sub(h))
        .map_or(0, |d| d + 1)
}

/// Whether a sweep may spend the note: deep enough and worth more than its marginal fee.
/// Mirrors the wallet's `MaxSpendable` note selection.
fn sweep_eligible(n: &UnspentNote, tip: u32, confirmations_sweep: u32) -> bool {
    note_confirmations(n, tip) >= confirmations_sweep.max(1) && n.value_zat > ZIP317_MARGINAL_FEE
}

/// Which of the eligible notes (given by value) one sweep takes: indices of the largest,
/// at most [`SWEEP_MAX_INPUTS`]. Ties keep the given order. The sweep builder uses the same
/// rule, so its proposal spends exactly the notes [`plan_sweep`] counts.
pub fn choose_sweep_inputs(values: &[u64]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(values[i]));
    order.truncate(SWEEP_MAX_INPUTS);
    order
}

/// The sweep a withdraw would build right now, from the account's unspent notes. Eligible
/// notes have at least `confirmations_sweep` (min 1) confirmations and are worth more than
/// [`ZIP317_MARGINAL_FEE`]; the largest [`SWEEP_MAX_INPUTS`] of them are spent for a fee of
/// one marginal fee per input (at least two). A plan whose inputs do not exceed its fee is
/// empty.
pub fn plan_sweep(notes: &[UnspentNote], tip: u32, confirmations_sweep: u32) -> SweepPlan {
    let total: u64 = notes.iter().map(|n| n.value_zat).sum();
    let eligible: Vec<u64> = notes
        .iter()
        .filter(|n| sweep_eligible(n, tip, confirmations_sweep))
        .map(|n| n.value_zat)
        .collect();
    let chosen = choose_sweep_inputs(&eligible);
    let inputs_zat: u64 = chosen.iter().map(|&i| eligible[i]).sum();
    let fee_zat = ZIP317_MARGINAL_FEE * chosen.len().max(2) as u64;
    if inputs_zat <= fee_zat {
        return SweepPlan {
            remaining_zat: total,
            ..Default::default()
        };
    }
    SweepPlan {
        inputs: chosen.len(),
        inputs_zat,
        fee_zat,
        output_zat: inputs_zat - fee_zat,
        remaining_zat: total - inputs_zat,
    }
}

/// An unspent received note of the tab's account.
pub struct UnspentNote {
    pub value_zat: u64,
    pub mined_height: Option<u32>,
}

/// One received note of the tab's account, joined with its transaction and address.
pub struct NoteRow {
    pub participant_index: u32,
    pub value_zat: u64,
    pub mined_height: Option<u32>,
    pub txid: String,
}

/// Pure aggregation. Only mined wallet notes count as confirmed; unmined wallet notes and
/// mempool sightings are mempool hints and never become confirmed facts.
pub fn aggregate(
    count: u32,
    notes: &[NoteRow],
    sightings: &[Sighting],
    sources: &HashMap<String, bool>,
    tip: u32,
) -> Vec<ParticipantFacts> {
    (0..count)
        .map(|i| {
            let mut payments = Vec::new();
            let mut sf = StatusFacts::default();
            let mut known_txids = HashSet::new();
            for n in notes.iter().filter(|n| n.participant_index == i) {
                known_txids.insert(n.txid.clone());
                let ts = sources.get(&n.txid).copied().unwrap_or(false);
                // tip below the mined height (stale/zero tip after restart or rewind) means 0, never 1.
                let confirmations = n
                    .mined_height
                    .and_then(|h| tip.checked_sub(h))
                    .map_or(0, |d| d + 1);
                match n.mined_height {
                    Some(_) => {
                        sf.confirmed_zat += n.value_zat;
                        sf.best_confirmations = sf.best_confirmations.max(confirmations);
                        sf.transparent_source |= ts;
                    }
                    None => sf.mempool_zat += n.value_zat,
                }
                payments.push(Payment {
                    txid: n.txid.clone(),
                    value_zat: n.value_zat,
                    mined_height: n.mined_height,
                    confirmations,
                    transparent_source: ts,
                    first_seen_at: String::new(),
                });
            }
            for s in sightings
                .iter()
                .filter(|s| s.participant_index == i && !known_txids.contains(&s.txid))
            {
                sf.mempool_zat += s.value_zat;
                payments.push(Payment {
                    txid: s.txid.clone(),
                    value_zat: s.value_zat,
                    mined_height: None,
                    confirmations: 0,
                    transparent_source: false,
                    first_seen_at: s.first_seen_at.clone(),
                });
            }
            ParticipantFacts {
                index: i,
                address: String::new(),
                payments,
                status_facts: sf,
            }
        })
        .collect()
}

/// Drops sightings first seen before `cutoff` (expired, evicted or replaced transactions),
/// so they stop counting as mempool payments even before the mempool loop prunes them.
pub fn fresh_sightings(
    sightings: Vec<Sighting>,
    cutoff: time::OffsetDateTime,
) -> Result<Vec<Sighting>, WatcherError> {
    let mut out = Vec::with_capacity(sightings.len());
    for s in sightings {
        if crate::meta::parse_rfc3339(&s.first_seen_at)? >= cutoff {
            out.push(s);
        }
    }
    Ok(out)
}

/// Value of the sightings whose transaction is not mined for the tab yet: money on its way
/// that a sweep made now would leave behind.
pub fn pending_mempool_zat(sightings: &[Sighting], notes: &[NoteRow]) -> u64 {
    let mined: HashSet<&str> = notes
        .iter()
        .filter(|n| n.mined_height.is_some())
        .map(|n| n.txid.as_str())
        .collect();
    sightings
        .iter()
        .filter(|s| !mined.contains(s.txid.as_str()))
        .map(|s| s.value_zat)
        .sum()
}

/// [`pending_mempool_zat`] over the tab's fresh sightings and its wallet notes.
pub fn tab_pending_mempool_zat(
    wallet: &WalletStore,
    meta: &MetaStore,
    cfg: &Config,
    tab: &TabRow,
) -> Result<u64, WatcherError> {
    let cutoff =
        crate::meta::sighting_cutoff(time::OffsetDateTime::now_utc(), cfg.block_interval_seconds);
    let sightings = fresh_sightings(meta.sightings_for_tab(tab.tab_id)?, cutoff)?;
    let notes = note_rows(wallet, tab.account_uuid)?;
    Ok(pending_mempool_zat(&sightings, &notes))
}

fn werr(e: impl std::fmt::Display) -> WatcherError {
    WatcherError::Wallet(e.to_string())
}

/// Reads this tab's received notes straight from the wallet database.
/// Pools: 3 = Orchard, 4 = Ironwood (we accept both; after NU6.3 only Ironwood arrives).
pub fn note_rows(wallet: &WalletStore, account_uuid: Uuid) -> Result<Vec<NoteRow>, WatcherError> {
    let conn = wallet.read_conn();
    let mut st = conn
        .prepare(
            "SELECT a.diversifier_index_be, r.value, t.mined_height, t.txid
               FROM v_received_outputs r
               JOIN accounts acc ON acc.id = r.account_id
               JOIN transactions t ON t.id_tx = r.transaction_id
               JOIN addresses a ON a.id = r.address_id
              WHERE acc.uuid = ?1 AND r.pool IN (3, 4) AND r.is_change = 0",
        )
        .map_err(werr)?;
    type Raw = (Vec<u8>, i64, Option<i64>, Vec<u8>);
    let raw: Vec<Raw> = st
        .query_map([account_uuid.as_bytes().to_vec()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(werr)?
        .collect::<Result<_, _>>()
        .map_err(werr)?;
    raw.into_iter()
        .map(|(be, value, mined, mut txid)| {
            let participant_index = crate::wallet::index_from_be(&be)
                .ok_or_else(|| WatcherError::Wallet("diversifier index out of u32 range".into()))?;
            txid.reverse();
            Ok(NoteRow {
                participant_index,
                value_zat: u64::try_from(value).map_err(werr)?,
                mined_height: mined.map(u32::try_from).transpose().map_err(werr)?,
                txid: hex::encode(txid),
            })
        })
        .collect()
}

/// The tab's unspent notes: those without a spend row (`*_received_note_spends`, through
/// `v_received_output_spends`) by a live transaction. Like `zcash_client_sqlite`, a spend
/// counts only if its transaction is mined, never expires (`expiry_height = 0`), has an
/// unknown expiry, or has not expired yet at `tip`; a spending transaction that expired
/// unmined gives its notes back.
pub fn unspent_notes(
    wallet: &WalletStore,
    account_uuid: Uuid,
    tip: u32,
) -> Result<Vec<UnspentNote>, WatcherError> {
    let conn = wallet.read_conn();
    let mut st = conn
        .prepare(
            "SELECT r.value, t.mined_height
               FROM v_received_outputs r
               JOIN accounts acc ON acc.id = r.account_id
               JOIN transactions t ON t.id_tx = r.transaction_id
              WHERE acc.uuid = ?1 AND r.pool IN (3, 4)
                AND NOT EXISTS (
                    SELECT 1 FROM v_received_output_spends s
                      JOIN transactions stx ON stx.id_tx = s.transaction_id
                     WHERE s.pool = r.pool AND s.received_output_id = r.id_within_pool_table
                       AND (stx.mined_height IS NOT NULL OR stx.expiry_height IS NULL
                            OR stx.expiry_height = 0 OR stx.expiry_height > ?2))",
        )
        .map_err(werr)?;
    let raw: Vec<(i64, Option<i64>)> = st
        .query_map(
            rusqlite::params![account_uuid.as_bytes().to_vec(), tip],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(werr)?
        .collect::<Result<_, _>>()
        .map_err(werr)?;
    raw.into_iter()
        .map(|(value, mined)| {
            Ok(UnspentNote {
                value_zat: u64::try_from(value).map_err(werr)?,
                mined_height: mined.map(u32::try_from).transpose().map_err(werr)?,
            })
        })
        .collect()
}

/// Pure split of unspent notes by depth, plus what a sweep would send now. A tip below a
/// note's mined height counts as 0 confirmations, like payments.
pub fn balance_of(
    notes: &[UnspentNote],
    mempool_zat: u64,
    swept_zat: u64,
    tip: u32,
    confirmations_sweep: u32,
) -> TabBalance {
    let mut b = TabBalance {
        pending_zat: mempool_zat,
        swept_zat,
        sweepable_zat: plan_sweep(notes, tip, confirmations_sweep).output_zat,
        ..Default::default()
    };
    for n in notes {
        let confirmations = note_confirmations(n, tip);
        if confirmations >= confirmations_sweep.max(1) {
            b.spendable_zat += n.value_zat;
        } else {
            b.pending_zat += n.value_zat;
        }
        if n.mined_height.is_some() {
            b.min_unspent_confirmations = Some(
                b.min_unspent_confirmations
                    .map_or(confirmations, |m| m.min(confirmations)),
            );
        }
    }
    b
}

/// [`balance_of`] over the account's unspent notes, the tab's fresh unmined mempool
/// payments and its mined sweeps.
pub fn tab_balance(
    wallet: &WalletStore,
    meta: &MetaStore,
    cfg: &Config,
    tab: &TabRow,
    tip: u32,
) -> Result<TabBalance, WatcherError> {
    let swept = meta
        .sweep_history(tab.tab_id)?
        .iter()
        .filter(|h| h.mined_height.is_some())
        .map(|h| h.output_zat)
        .sum();
    let notes = unspent_notes(wallet, tab.account_uuid, tip)?;
    // Sightings of transactions the wallet already holds are counted through their notes.
    let cutoff =
        crate::meta::sighting_cutoff(time::OffsetDateTime::now_utc(), cfg.block_interval_seconds);
    let sightings = fresh_sightings(meta.sightings_for_tab(tab.tab_id)?, cutoff)?;
    let held: HashSet<String> = note_rows(wallet, tab.account_uuid)?
        .into_iter()
        .map(|n| n.txid)
        .collect();
    let mempool = sightings
        .iter()
        .filter(|s| !held.contains(&s.txid))
        .map(|s| s.value_zat)
        .sum();
    Ok(balance_of(
        &notes,
        mempool,
        swept,
        tip,
        cfg.confirmations_sweep,
    ))
}

/// The tab's participant addresses from `ztab.sqlite`. Registration stores them; a tab
/// registered before that (or interrupted between its rows) is backfilled once here, which
/// is the only path that derives them through the wallet (and takes its `db()` lock).
pub fn ensure_tab_addresses(
    wallet: &WalletStore,
    meta: &MetaStore,
    tab: &TabRow,
) -> Result<Vec<(u32, String)>, WatcherError> {
    let stored = meta.tab_addresses(tab.tab_id)?;
    let complete = stored.len() == tab.participants_count as usize
        && stored
            .iter()
            .enumerate()
            .all(|(i, (idx, _))| *idx as usize == i);
    if complete {
        return Ok(stored);
    }
    let derived = wallet.participant_addresses(
        crate::wallet::account_uuid(tab.account_uuid),
        tab.participants_count,
    )?;
    meta.put_tab_addresses(tab.tab_id, &derived)?;
    Ok(derived)
}

pub fn tab_facts(
    wallet: &WalletStore,
    meta: &MetaStore,
    cfg: &Config,
    tab: &TabRow,
    tip: u32,
    synced: u32,
    stale: bool,
) -> Result<TabFacts, WatcherError> {
    let notes = note_rows(wallet, tab.account_uuid)?;
    let cutoff =
        crate::meta::sighting_cutoff(time::OffsetDateTime::now_utc(), cfg.block_interval_seconds);
    let sightings = fresh_sightings(meta.sightings_for_tab(tab.tab_id)?, cutoff)?;
    let sources = meta.transparent_sources(notes.iter().map(|n| n.txid.as_str()))?;
    let addresses = ensure_tab_addresses(wallet, meta, tab)?;
    let mut participants = aggregate(tab.participants_count, &notes, &sightings, &sources, tip);
    for (p, (_, addr)) in participants.iter_mut().zip(addresses) {
        p.address = addr;
    }
    Ok(TabFacts {
        tab_id: tab.tab_id,
        state: tab.state,
        active: tab.active,
        synced_height: synced,
        tip_height: tip,
        stale,
        participants,
        balance: tab_balance(wallet, meta, cfg, tab, tip)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(idx: u32, value: u64, mined: Option<u32>, txid: &str) -> NoteRow {
        NoteRow {
            participant_index: idx,
            value_zat: value,
            mined_height: mined,
            txid: txid.into(),
        }
    }

    #[test]
    fn aggregates_confirmed_and_mempool_separately() {
        let notes = vec![
            row(0, 100, Some(90), "aa"),
            row(0, 50, None, "bb"),
            row(1, 70, Some(99), "cc"),
        ];
        let sightings = vec![Sighting {
            txid: "dd".into(),
            participant_index: 1,
            value_zat: 30,
            first_seen_at: "t".into(),
        }];
        let facts = aggregate(2, &notes, &sightings, &Default::default(), 100);
        let p0 = &facts[0];
        let p1 = &facts[1];
        assert_eq!(p0.status_facts.confirmed_zat, 100);
        assert_eq!(p0.status_facts.mempool_zat, 50);
        assert_eq!(p0.status_facts.best_confirmations, 11);
        assert_eq!(p1.status_facts.confirmed_zat, 70);
        assert_eq!(p1.status_facts.mempool_zat, 30);
        assert_eq!(p1.status_facts.best_confirmations, 2);
    }

    #[test]
    fn stale_sightings_are_ignored() {
        let s = |txid: &str, seen: &str| Sighting {
            txid: txid.into(),
            participant_index: 0,
            value_zat: 10,
            first_seen_at: seen.into(),
        };
        let cutoff = crate::meta::parse_rfc3339("2026-10-15T10:00:00Z").unwrap();
        let fresh = fresh_sightings(
            vec![
                s("stale", "2026-10-15T09:59:59Z"),
                s("edge", "2026-10-15T10:00:00Z"),
                s("fresh", "2026-10-15T11:00:00.25Z"),
            ],
            cutoff,
        )
        .unwrap();
        let txids: Vec<_> = fresh.iter().map(|s| s.txid.as_str()).collect();
        assert_eq!(txids, ["edge", "fresh"]);
        let facts = aggregate(1, &[], &fresh, &Default::default(), 100);
        assert_eq!(facts[0].status_facts.mempool_zat, 20);
        assert!(fresh_sightings(vec![s("bad", "t")], cutoff).is_err());
    }

    #[test]
    fn mempool_sighting_is_dropped_once_the_note_is_mined() {
        let notes = vec![row(0, 100, Some(90), "aa")];
        let sightings = vec![Sighting {
            txid: "aa".into(),
            participant_index: 0,
            value_zat: 100,
            first_seen_at: "t".into(),
        }];
        let facts = aggregate(1, &notes, &sightings, &Default::default(), 100);
        assert_eq!(facts[0].status_facts.mempool_zat, 0);
        assert_eq!(facts[0].payments.len(), 1);
    }

    #[test]
    fn tip_below_mined_height_reports_zero_confirmations() {
        let notes = vec![row(0, 100, Some(90), "aa")];
        let facts = aggregate(1, &notes, &[], &Default::default(), 0);
        assert_eq!(facts[0].status_facts.best_confirmations, 0);
        assert_eq!(facts[0].payments[0].confirmations, 0);
        // Still a mined note: counted as confirmed, with an honest 0 confirmations.
        assert_eq!(facts[0].status_facts.confirmed_zat, 100);
        let at_tip = aggregate(1, &notes, &[], &Default::default(), 90);
        assert_eq!(at_tip[0].status_facts.best_confirmations, 1);
    }

    #[test]
    fn note_rows_reads_only_ironwood_and_orchard_non_change_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let m: HashMap<String, String> = [
            ("ZTAB_API_TOKEN", "t"),
            ("ZTAB_DATA_DIR", tmp.path().to_str().unwrap()),
            ("ZTAB_NETWORK", "test"),
            ("ZTAB_LIGHTWALLETD_URL", "https://example.invalid:443"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let cfg = Config::from_map(&m).unwrap();
        let wallet = WalletStore::open(&cfg).unwrap();
        let acct = Uuid::new_v4();
        let other = Uuid::new_v4();
        {
            let c = rusqlite::Connection::open(tmp.path().join("wallet.sqlite")).unwrap();
            for (id, u) in [(1, acct), (2, other)] {
                c.execute(
                    "INSERT INTO accounts (id, uuid, account_kind, uivk, birthday_height) VALUES (?1, ?2, 1, 'uivk' || ?1, 1)",
                    rusqlite::params![id, u.as_bytes().to_vec()],
                )
                .unwrap();
            }
            let mut idx1 = vec![0u8; 11];
            idx1[10] = 1;
            c.execute(
                "INSERT INTO addresses (id, account_id, key_scope, diversifier_index_be, address, receiver_flags) VALUES (1, 1, 0, ?1, 'a', 0)",
                [idx1],
            )
            .unwrap();
            let txid: Vec<u8> = (1u8..=32).collect();
            let other_txid: Vec<u8> = (101u8..=132).collect();
            for (id, t, mined) in [(1, &txid, Some(500)), (2, &other_txid, None)] {
                c.execute(
                    "INSERT INTO transactions (id_tx, txid, mined_height, min_observed_height) VALUES (?1, ?2, ?3, 1)",
                    rusqlite::params![id, t, mined],
                )
                .unwrap();
            }
            // (table, account, action/output idx, tx, value, is_change)
            let note = |sql: &str, rowid: i64, acc: i64, tx: i64, value: i64, change: i64| {
                c.execute(sql, rusqlite::params![rowid, acc, tx, value, change])
                    .unwrap();
            };
            let iw = "INSERT INTO ironwood_received_notes (id, action_index, account_id, transaction_id, diversifier, value, rho, rseed, is_change, address_id, note_version) VALUES (?1, ?1, ?2, ?3, x'00', ?4, x'00', x'00', ?5, 1, 1)";
            note(iw, 1, 1, 1, 12_345, 0); // wanted: mined, ours, non-change
            note(iw, 2, 1, 1, 999, 1); // change: excluded
            note(iw, 3, 2, 1, 777, 0); // other account: excluded
            note(iw, 4, 1, 2, 55, 0); // wanted: unmined
            let sap = "INSERT INTO sapling_received_notes (id, output_index, account_id, transaction_id, diversifier, value, rcm, is_change, address_id) VALUES (?1, ?1, ?2, ?3, x'00', ?4, x'00', ?5, 1)";
            note(sap, 1, 1, 1, 888, 0); // Sapling: excluded
        }
        let mut rows = note_rows(&wallet, acct).unwrap();
        rows.sort_by_key(|r| r.value_zat);
        assert_eq!(rows.len(), 2);
        let display: Vec<u8> = (1u8..=32).rev().collect();
        assert_eq!(rows[1].value_zat, 12_345);
        assert_eq!(rows[1].participant_index, 1);
        assert_eq!(rows[1].mined_height, Some(500));
        assert_eq!(rows[1].txid, hex::encode(display));
        assert_eq!(rows[0].value_zat, 55);
        assert_eq!(rows[0].mined_height, None);
    }

    #[test]
    fn pending_mempool_zat_counts_sightings_not_yet_mined() {
        let s = |txid: &str, idx: u32, v: u64| Sighting {
            txid: txid.into(),
            participant_index: idx,
            value_zat: v,
            first_seen_at: "t".into(),
        };
        let sightings = vec![s("aa", 0, 100), s("bb", 1, 40), s("cc", 0, 7)];
        // "aa" is mined; "bb" is in the wallet but unmined; "cc" only sighted.
        let notes = vec![row(0, 100, Some(90), "aa"), row(1, 40, None, "bb")];
        assert_eq!(pending_mempool_zat(&sightings, &notes), 47);
        assert_eq!(pending_mempool_zat(&[], &notes), 0);
        assert_eq!(pending_mempool_zat(&sightings, &[]), 147);
    }

    fn unspent(value_zat: u64, mined_height: Option<u32>) -> UnspentNote {
        UnspentNote {
            value_zat,
            mined_height,
        }
    }

    #[test]
    fn plan_sweep_skips_young_notes() {
        // Tip 100: mined at 91 has 10 confirmations, mined at 100 has 1.
        let notes = [unspent(100_000_000, Some(91)), unspent(70_000, Some(100))];
        let plan = plan_sweep(&notes, 100, 10);
        assert_eq!(plan.inputs, 1);
        assert_eq!(plan.inputs_zat, 100_000_000);
        assert_eq!(plan.fee_zat, 10_000);
        assert_eq!(plan.output_zat, 100_000_000 - 10_000);
        assert_eq!(plan.remaining_zat, 70_000);
        // Unmined notes are never deep: left behind and reported.
        let plan = plan_sweep(&[unspent(100_000_000, Some(91)), unspent(5, None)], 100, 10);
        assert_eq!((plan.inputs, plan.remaining_zat), (1, 5));
    }

    #[test]
    fn plan_sweep_ignores_dust() {
        let notes = [unspent(5_000, Some(1)), unspent(5_000, Some(2))];
        assert_eq!(
            plan_sweep(&notes, 100, 10),
            SweepPlan {
                inputs: 0,
                inputs_zat: 0,
                fee_zat: 0,
                output_zat: 0,
                remaining_zat: 10_000,
            }
        );
    }

    #[test]
    fn plan_sweep_caps_inputs_at_50() {
        let notes: Vec<_> = (0..51).map(|_| unspent(10_000, Some(1))).collect();
        let plan = plan_sweep(&notes, 100, 10);
        assert_eq!(plan.inputs, SWEEP_MAX_INPUTS);
        assert_eq!(plan.inputs_zat, 500_000);
        assert_eq!(plan.fee_zat, 250_000);
        assert!(plan.fee_zat < 500_000);
        assert_eq!(plan.output_zat, 250_000);
        assert_eq!(plan.remaining_zat, 10_000);
        // Exactly 50: all taken, nothing left.
        let plan = plan_sweep(&notes[..50], 100, 10);
        assert_eq!((plan.inputs, plan.remaining_zat), (50, 0));
    }

    #[test]
    fn plan_sweep_takes_the_largest_eligible_notes() {
        let mut notes: Vec<_> = (0..50).map(|_| unspent(10_000, Some(1))).collect();
        notes.insert(7, unspent(9_000, Some(1)));
        notes.push(unspent(1_000_000, Some(1)));
        notes.push(unspent(2_000_000, Some(100))); // young: not eligible however large
        let plan = plan_sweep(&notes, 100, 10);
        assert_eq!(plan.inputs, 50);
        assert_eq!(plan.inputs_zat, 1_000_000 + 49 * 10_000);
        assert_eq!(plan.remaining_zat, 10_000 + 9_000 + 2_000_000);
    }

    #[test]
    fn choose_sweep_inputs_takes_the_largest_up_to_the_cap() {
        assert_eq!(choose_sweep_inputs(&[]), Vec::<usize>::new());
        assert_eq!(choose_sweep_inputs(&[7, 9, 8]), [1, 2, 0]);
        // 60 values: the 50 largest, ties in the given order; the 10 smallest are left.
        let values: Vec<u64> = (0..60).map(|i| 10_000 + (i % 3) * 1_000).collect();
        let chosen = choose_sweep_inputs(&values);
        assert_eq!(chosen.len(), SWEEP_MAX_INPUTS);
        let left: u64 = (0..60)
            .filter(|i| !chosen.contains(i))
            .map(|i| values[i])
            .sum();
        assert_eq!(left, 10 * 10_000);
        assert_eq!(&chosen[..3], [2, 5, 8]);
    }

    #[test]
    fn plan_sweep_empty_when_fee_exceeds_value() {
        // One deep 6 000-zat note: the minimum fee (two actions, 10 000) eats it.
        let plan = plan_sweep(&[unspent(6_000, Some(1))], 100, 10);
        assert_eq!(
            plan,
            SweepPlan {
                inputs: 0,
                inputs_zat: 0,
                fee_zat: 0,
                output_zat: 0,
                remaining_zat: 6_000,
            }
        );
        // Value exactly the fee: still nothing to send.
        let plan = plan_sweep(&[unspent(10_000, Some(1))], 100, 10);
        assert_eq!((plan.inputs, plan.output_zat), (0, 0));
        // Two deep 6 000-zat notes cost two actions (10 000): 2 000 can be sent.
        let plan = plan_sweep(&[unspent(6_000, Some(1)), unspent(6_000, Some(1))], 100, 10);
        assert_eq!(
            (plan.inputs, plan.fee_zat, plan.output_zat),
            (2, 10_000, 2_000)
        );
    }

    #[test]
    fn plan_sweep_treats_zero_confirmations_setting_as_one() {
        let notes = [unspent(100_000, Some(100)), unspent(100_000, None)];
        let plan = plan_sweep(&notes, 100, 0);
        assert_eq!((plan.inputs, plan.remaining_zat), (1, 100_000));
        // A tip below the mined height counts as 0 confirmations.
        assert_eq!(plan_sweep(&notes, 99, 0).inputs, 0);
    }

    #[test]
    fn balance_reports_sweepable() {
        let notes = [
            unspent(100_000_000, Some(91)),
            unspent(70_000, Some(100)),
            unspent(5_000, Some(50)),
        ];
        let b = balance_of(&notes, 3_000, 0, 100, 10);
        assert_eq!(b.spendable_zat, 100_005_000);
        assert_eq!(b.pending_zat, 73_000);
        assert_eq!(b.sweepable_zat, 100_000_000 - 10_000);
        let json = serde_json::to_value(&b).unwrap();
        assert_eq!(json["sweepable_zat"], 100_000_000 - 10_000);
        // Deep dust only: spendable but not sweepable.
        let b = balance_of(&[unspent(5_000, Some(1))], 0, 0, 100, 10);
        assert_eq!((b.spendable_zat, b.sweepable_zat), (5_000, 0));
    }

    #[test]
    fn transparent_source_flag_propagates() {
        let notes = vec![row(0, 100, Some(90), "aa")];
        let mut sources = HashMap::new();
        sources.insert("aa".to_string(), true);
        let facts = aggregate(1, &notes, &[], &sources, 100);
        assert!(facts[0].status_facts.transparent_source);
        assert!(facts[0].payments[0].transparent_source);
    }
}
