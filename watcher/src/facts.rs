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
    pub synced_height: u32,
    pub tip_height: u32,
    pub stale: bool,
    pub participants: Vec<ParticipantFacts>,
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
                let confirmations = n.mined_height.map_or(0, |h| tip.saturating_sub(h) + 1);
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

pub fn tab_facts(
    wallet: &WalletStore,
    meta: &MetaStore,
    _cfg: &Config,
    tab: &TabRow,
    tip: u32,
    synced: u32,
    stale: bool,
) -> Result<TabFacts, WatcherError> {
    let notes = note_rows(wallet, tab.account_uuid)?;
    let sightings = meta.sightings_for_tab(tab.tab_id)?;
    let sources = meta.transparent_sources(notes.iter().map(|n| n.txid.as_str()))?;
    let addresses = wallet.participant_addresses(
        crate::wallet::account_uuid(tab.account_uuid),
        tab.participants_count,
    )?;
    let mut participants = aggregate(tab.participants_count, &notes, &sightings, &sources, tip);
    for (p, (_, addr)) in participants.iter_mut().zip(addresses) {
        p.address = addr;
    }
    Ok(TabFacts {
        tab_id: tab.tab_id,
        state: tab.state,
        synced_height: synced,
        tip_height: tip,
        stale,
        participants,
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
    fn transparent_source_flag_propagates() {
        let notes = vec![row(0, 100, Some(90), "aa")];
        let mut sources = HashMap::new();
        sources.insert("aa".to_string(), true);
        let facts = aggregate(1, &notes, &[], &sources, 100);
        assert!(facts[0].status_facts.transparent_source);
        assert!(facts[0].payments[0].transparent_source);
    }
}
