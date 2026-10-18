use crate::{config::Config, error::WatcherError};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TabState {
    Open,
    Sweeping,
    Closed,
    Abandoned,
}

impl TabState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Sweeping => "sweeping",
            Self::Closed => "closed",
            Self::Abandoned => "abandoned",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "sweeping" => Some(Self::Sweeping),
            "closed" => Some(Self::Closed),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TabRow {
    pub tab_id: Uuid,
    pub account_uuid: Uuid,
    pub ufvk: String,
    pub birthday: u32,
    pub participants_count: u32,
    pub state: TabState,
    pub created_at: OffsetDateTime,
    /// False while the tab is paused: it is left out of `open_tabs()` and so of every
    /// background loop. Independent of `state`.
    pub active: bool,
}

/// A mempool sighting: a hint that a not-yet-mined tx pays a participant address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sighting {
    pub txid: String,
    pub participant_index: u32,
    pub value_zat: u64,
    pub first_seen_at: String,
}

/// The sweep last offered for a tab (one row per tab).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepRow {
    pub tab_id: Uuid,
    pub txid: String,
    pub expiry_height: u32,
    pub created_at: OffsetDateTime,
    pub broadcast_at: Option<OffsetDateTime>,
}

pub struct MetaStore {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tabs (
  tab_id TEXT PRIMARY KEY, account_uuid TEXT NOT NULL UNIQUE, ufvk TEXT NOT NULL,
  birthday INTEGER NOT NULL, participants_count INTEGER NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS mempool_sightings (
  txid TEXT NOT NULL, tab_id TEXT NOT NULL, participant_index INTEGER NOT NULL,
  value_zat INTEGER NOT NULL, first_seen_at TEXT NOT NULL,
  PRIMARY KEY (txid, tab_id, participant_index)
);
CREATE TABLE IF NOT EXISTS tx_sources (
  txid TEXT PRIMARY KEY, transparent_source INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tab_addresses (
  tab_id TEXT NOT NULL, participant_index INTEGER NOT NULL, address TEXT NOT NULL,
  PRIMARY KEY (tab_id, participant_index)
);
CREATE TABLE IF NOT EXISTS sweeps (
  tab_id TEXT PRIMARY KEY, txid TEXT NOT NULL,
  expiry_height INTEGER NOT NULL, created_at TEXT NOT NULL, broadcast_at TEXT
);
"#;

impl MetaStore {
    /// Tolerates poisoning: a panic elsewhere while the lock was held cannot leave a
    /// half-applied write, since each statement is atomic in SQLite.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn open(cfg: &Config) -> Result<Self, WatcherError> {
        Self::open_at(&cfg.data_dir.join("ztab.sqlite"))
    }

    pub fn open_at(path: &Path) -> Result<Self, WatcherError> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        }
        let conn = Connection::open(path).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        drop_offered_pczts(&conn)?;
        add_active_column(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert_tab(&self, t: &TabRow) -> Result<(), WatcherError> {
        let created_at = rfc3339(t.created_at)?;
        self.conn().execute(
            "INSERT INTO tabs (tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![t.tab_id.to_string(), t.account_uuid.to_string(), t.ufvk, t.birthday, t.participants_count, t.state.as_str(), created_at, t.active],
        ).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn get_tab(&self, tab_id: Uuid) -> Result<Option<TabRow>, WatcherError> {
        // Raw column values are read under the lock; decoding and validation happen after
        // it is released, so corrupt stored data can neither panic nor poison the mutex.
        type Raw = (String, String, String, u32, u32, String, String, bool);
        let raw: Option<Raw> = self.conn()
            .query_row(
                "SELECT tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at, active FROM tabs WHERE tab_id = ?1",
                params![tab_id.to_string()],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        raw.map(
            |(id, acct, ufvk, birthday, participants_count, state, created, active)| {
                Ok(TabRow {
                    tab_id: parse_uuid("tab_id", &id)?,
                    account_uuid: parse_uuid("account_uuid", &acct)?,
                    ufvk,
                    birthday,
                    participants_count,
                    state: TabState::parse(&state).ok_or_else(|| {
                        WatcherError::Wallet(format!(
                            "stored tab state {state:?} is not a known state"
                        ))
                    })?,
                    created_at: parse_rfc3339(&created)?,
                    active,
                })
            },
        )
        .transpose()
    }

    pub fn set_tab_state(&self, tab_id: Uuid, state: TabState) -> Result<(), WatcherError> {
        self.conn()
            .execute(
                "UPDATE tabs SET state = ?2 WHERE tab_id = ?1",
                params![tab_id.to_string(), state.as_str()],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    /// Pauses (`false`) or resumes (`true`) a tab. Returns `false` when no such tab exists.
    pub fn set_active(&self, tab_id: Uuid, active: bool) -> Result<bool, WatcherError> {
        let n = self
            .conn()
            .execute(
                "UPDATE tabs SET active = ?2 WHERE tab_id = ?1",
                params![tab_id.to_string(), active],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(n > 0)
    }

    /// Stores the tab's participant addresses (index, encoded address), replacing any
    /// stored for the same indices.
    pub fn put_tab_addresses(
        &self,
        tab_id: Uuid,
        addresses: &[(u32, String)],
    ) -> Result<(), WatcherError> {
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        for (index, address) in addresses {
            tx.execute(
                "INSERT OR REPLACE INTO tab_addresses (tab_id, participant_index, address) VALUES (?1, ?2, ?3)",
                params![tab_id.to_string(), index, address],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        }
        tx.commit().map_err(|e| WatcherError::Wallet(e.to_string()))
    }

    /// The tab's stored participant addresses, by index.
    pub fn tab_addresses(&self, tab_id: Uuid) -> Result<Vec<(u32, String)>, WatcherError> {
        let conn = self.conn();
        let mut st = conn
            .prepare(
                "SELECT participant_index, address FROM tab_addresses WHERE tab_id = ?1 ORDER BY participant_index",
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let rows = st
            .query_map(params![tab_id.to_string()], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| WatcherError::Wallet(e.to_string()))?
            .collect::<Result<_, _>>()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(rows)
    }

    pub fn sightings_for_tab(&self, tab_id: Uuid) -> Result<Vec<Sighting>, WatcherError> {
        let conn = self.conn();
        let mut st = conn
            .prepare(
                "SELECT txid, participant_index, value_zat, first_seen_at FROM mempool_sightings WHERE tab_id = ?1 ORDER BY first_seen_at, txid",
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let rows = st
            .query_map(params![tab_id.to_string()], |r| {
                Ok(Sighting {
                    txid: r.get(0)?,
                    participant_index: r.get(1)?,
                    value_zat: r.get::<_, i64>(2)? as u64,
                    first_seen_at: r.get(3)?,
                })
            })
            .map_err(|e| WatcherError::Wallet(e.to_string()))?
            .collect::<Result<_, _>>()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(rows)
    }

    /// Records a sighting; a repeat of the same (txid, tab, participant) keeps the original
    /// `first_seen_at`.
    pub fn upsert_sighting(&self, s: &Sighting, tab_id: Uuid) -> Result<(), WatcherError> {
        let value = i64::try_from(s.value_zat)
            .map_err(|_| WatcherError::Wallet("sighting value exceeds i64".into()))?;
        self.conn()
            .execute(
                "INSERT INTO mempool_sightings (txid, tab_id, participant_index, value_zat, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(txid, tab_id, participant_index) DO UPDATE SET value_zat = excluded.value_zat",
                params![s.txid, tab_id.to_string(), s.participant_index, value, s.first_seen_at],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    /// Deletes sightings first seen before `cutoff`; returns how many were removed.
    /// Timestamps are compared as instants (RFC 3339 text does not sort reliably).
    pub fn prune_sightings_older_than(
        &self,
        cutoff: OffsetDateTime,
    ) -> Result<usize, WatcherError> {
        let conn = self.conn();
        let rows: Vec<(String, String, u32, String)> = {
            let mut st = conn
                .prepare(
                    "SELECT txid, tab_id, participant_index, first_seen_at FROM mempool_sightings",
                )
                .map_err(|e| WatcherError::Wallet(e.to_string()))?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map_err(|e| WatcherError::Wallet(e.to_string()))?
                .collect::<Result<_, _>>()
                .map_err(|e| WatcherError::Wallet(e.to_string()))?;
            rows
        };
        let mut removed = 0;
        for (txid, tab_id, index, seen) in rows {
            if parse_rfc3339(&seen)? < cutoff {
                removed += conn
                    .execute(
                        "DELETE FROM mempool_sightings WHERE txid = ?1 AND tab_id = ?2 AND participant_index = ?3",
                        params![txid, tab_id, index],
                    )
                    .map_err(|e| WatcherError::Wallet(e.to_string()))?;
            }
        }
        Ok(removed)
    }

    pub fn transparent_source(&self, txid: &str) -> Result<Option<bool>, WatcherError> {
        self.conn()
            .query_row(
                "SELECT transparent_source FROM tx_sources WHERE txid = ?1",
                params![txid],
                |r| r.get::<_, i64>(0).map(|v| v != 0),
            )
            .optional()
            .map_err(|e| WatcherError::Wallet(e.to_string()))
    }

    pub fn set_transparent_source(&self, txid: &str, v: bool) -> Result<(), WatcherError> {
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO tx_sources (txid, transparent_source) VALUES (?1, ?2)",
                params![txid, v as i64],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    /// The known transparent-source flags among `txids`.
    pub fn transparent_sources<'a>(
        &self,
        txids: impl IntoIterator<Item = &'a str>,
    ) -> Result<std::collections::HashMap<String, bool>, WatcherError> {
        let mut out = std::collections::HashMap::new();
        for t in txids {
            if let Some(v) = self.transparent_source(t)? {
                out.insert(t.to_string(), v);
            }
        }
        Ok(out)
    }

    /// Records `txid` as the tab's offered sweep, replacing any earlier offer. The PCZT
    /// itself is not kept: it round-trips through the client.
    pub fn put_sweep(
        &self,
        tab_id: Uuid,
        txid: &str,
        expiry_height: u32,
    ) -> Result<(), WatcherError> {
        let created_at = rfc3339(OffsetDateTime::now_utc())?;
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO sweeps (tab_id, txid, expiry_height, created_at, broadcast_at) VALUES (?1, ?2, ?3, ?4, NULL)",
                params![tab_id.to_string(), txid, expiry_height, created_at],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn get_sweep(&self, tab_id: Uuid) -> Result<Option<SweepRow>, WatcherError> {
        type Raw = (String, u32, String, Option<String>);
        let raw: Option<Raw> = self
            .conn()
            .query_row(
                "SELECT txid, expiry_height, created_at, broadcast_at FROM sweeps WHERE tab_id = ?1",
                params![tab_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        raw.map(|(txid, expiry_height, created, broadcast)| {
            Ok(SweepRow {
                tab_id,
                txid,
                expiry_height,
                created_at: parse_rfc3339(&created)?,
                broadcast_at: broadcast.as_deref().map(parse_rfc3339).transpose()?,
            })
        })
        .transpose()
    }

    /// Stamps the tab's offered sweep as broadcast now, only if it is still `txid`;
    /// `Conflict` if the tab's offer is missing or is a different transaction.
    pub fn mark_broadcast(&self, tab_id: Uuid, txid: &str) -> Result<(), WatcherError> {
        let now = rfc3339(OffsetDateTime::now_utc())?;
        let n = self
            .conn()
            .execute(
                "UPDATE sweeps SET broadcast_at = ?2 WHERE tab_id = ?1 AND txid = ?3",
                params![tab_id.to_string(), now, txid],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        if n == 0 {
            return Err(WatcherError::Conflict(
                "the tab's offered sweep is a different transaction".into(),
            ));
        }
        Ok(())
    }

    pub fn open_tabs(&self) -> Result<Vec<TabRow>, WatcherError> {
        let conn = self.conn();
        let mut st = conn
            .prepare("SELECT tab_id FROM tabs WHERE state IN ('open','sweeping') AND active = 1")
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let ids: Vec<String> = st
            .query_map([], |r| r.get(0))
            .map_err(|e| WatcherError::Wallet(e.to_string()))?
            .collect::<Result<_, _>>()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        drop(st);
        drop(conn);
        let mut tabs = Vec::with_capacity(ids.len());
        for id in ids {
            let id = parse_uuid("tab_id", &id)?;
            if let Some(t) = self.get_tab(id)? {
                tabs.push(t);
            }
        }
        Ok(tabs)
    }
}

/// Databases created before tabs could be paused lack the `active` column.
fn add_active_column(conn: &Connection) -> Result<(), WatcherError> {
    let has_column: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'active'",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )
        .map_err(|e| WatcherError::Wallet(e.to_string()))?;
    if !has_column {
        conn.execute_batch("ALTER TABLE tabs ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
    }
    Ok(())
}

/// Databases created before the PCZT stopped being stored at rest carry a `pczt_b64`
/// column in `sweeps`; it is dropped (with its contents) on open.
fn drop_offered_pczts(conn: &Connection) -> Result<(), WatcherError> {
    let has_column: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sweeps') WHERE name = 'pczt_b64'",
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )
        .map_err(|e| WatcherError::Wallet(e.to_string()))?;
    if has_column {
        conn.execute_batch("ALTER TABLE sweeps DROP COLUMN pczt_b64; VACUUM;")
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
    }
    Ok(())
}

fn parse_uuid(field: &str, s: &str) -> Result<Uuid, WatcherError> {
    s.parse()
        .map_err(|e| WatcherError::Wallet(format!("stored {field} is not a valid uuid: {e}")))
}

/// Blocks after which an unmined transaction can no longer be mined: the default expiry
/// delta wallets set after NU7 (`expiry_height = target_height + 120`). A sighting older
/// than this many block intervals belongs to a transaction that expired, was evicted or was
/// replaced, so it is no longer a mempool fact.
pub const SIGHTING_EXPIRY_BLOCKS: u64 = 120;

/// Sightings first seen before the returned instant are stale.
pub fn sighting_cutoff(now: OffsetDateTime, block_interval_seconds: u64) -> OffsetDateTime {
    let secs = SIGHTING_EXPIRY_BLOCKS.saturating_mul(block_interval_seconds);
    now - time::Duration::seconds(i64::try_from(secs).unwrap_or(i64::MAX / 2))
}

pub fn rfc3339(t: OffsetDateTime) -> Result<String, WatcherError> {
    t.format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| WatcherError::Wallet(format!("format timestamp: {e}")))
}

pub fn parse_rfc3339(s: &str) -> Result<OffsetDateTime, WatcherError> {
    OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|e| WatcherError::Wallet(format!("stored timestamp {s:?} is not RFC 3339: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn row(state: TabState) -> TabRow {
        TabRow {
            tab_id: Uuid::new_v4(),
            account_uuid: Uuid::new_v4(),
            ufvk: "uviewtest1abc".into(),
            birthday: 4_503_583,
            participants_count: 4,
            state,
            created_at: time::OffsetDateTime::now_utc()
                .replace_nanosecond(0)
                .unwrap(),
            active: true,
        }
    }

    fn store(tmp: &tempfile::TempDir) -> MetaStore {
        MetaStore::open_at(&tmp.path().join("ztab.sqlite")).unwrap()
    }

    #[test]
    fn sightings_upsert_and_read_per_tab() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let s = Sighting {
            txid: "aa".into(),
            participant_index: 1,
            value_zat: 500,
            first_seen_at: "2026-01-01T00:00:00Z".into(),
        };
        store.upsert_sighting(&s, a).unwrap();
        // Re-sighting keeps the original first_seen_at and updates the value.
        store
            .upsert_sighting(
                &Sighting {
                    value_zat: 600,
                    first_seen_at: "2026-02-02T00:00:00Z".into(),
                    ..s.clone()
                },
                a,
            )
            .unwrap();
        let got = store.sightings_for_tab(a).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value_zat, 600);
        assert_eq!(got[0].first_seen_at, s.first_seen_at);
        assert!(store.sightings_for_tab(b).unwrap().is_empty());
    }

    #[test]
    fn prune_removes_only_sightings_older_than_cutoff() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let tab = Uuid::new_v4();
        let at = |txid: &str, seen: &str| Sighting {
            txid: txid.into(),
            participant_index: 0,
            value_zat: 1,
            first_seen_at: seen.into(),
        };
        store
            .upsert_sighting(&at("old", "2026-01-01T00:00:00Z"), tab)
            .unwrap();
        // Fractional seconds sort before 'Z' as text; compared as instants this is newer.
        store
            .upsert_sighting(&at("fresh", "2026-01-01T01:00:00.5Z"), tab)
            .unwrap();
        let cutoff = parse_rfc3339("2026-01-01T01:00:00Z").unwrap();
        assert_eq!(store.prune_sightings_older_than(cutoff).unwrap(), 1);
        let left = store.sightings_for_tab(tab).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].txid, "fresh");
        assert_eq!(store.prune_sightings_older_than(cutoff).unwrap(), 0);
    }

    #[test]
    fn sighting_cutoff_is_expiry_blocks_of_intervals_ago() {
        let now = parse_rfc3339("2026-10-15T12:00:00Z").unwrap();
        assert_eq!(
            sighting_cutoff(now, 75),
            now - time::Duration::seconds(120 * 75)
        );
    }

    #[test]
    fn transparent_source_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        assert_eq!(store.transparent_source("aa").unwrap(), None);
        store.set_transparent_source("aa", true).unwrap();
        store.set_transparent_source("bb", false).unwrap();
        assert_eq!(store.transparent_source("aa").unwrap(), Some(true));
        let m = store.transparent_sources(["aa", "bb", "cc"]).unwrap();
        assert_eq!(m.len(), 2);
        assert!(!m["bb"]);
        store.set_transparent_source("aa", false).unwrap();
        assert_eq!(store.transparent_source("aa").unwrap(), Some(false));
    }

    #[test]
    fn insert_and_get_tab_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let row = row(TabState::Open);
        store.insert_tab(&row).unwrap();
        let got = store.get_tab(row.tab_id).unwrap().unwrap();
        assert_eq!(got.tab_id, row.tab_id);
        assert_eq!(got.account_uuid, row.account_uuid);
        assert_eq!(got.ufvk, row.ufvk);
        assert_eq!(got.birthday, 4_503_583);
        assert_eq!(got.participants_count, 4);
        assert_eq!(got.state, TabState::Open);
        assert_eq!(got.created_at, row.created_at);
        assert!(store.get_tab(Uuid::new_v4()).unwrap().is_none());
    }

    #[test]
    fn insert_same_tab_twice_is_a_constraint_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let row = row(TabState::Open);
        store.insert_tab(&row).unwrap();
        let err = store.insert_tab(&row).unwrap_err().to_string();
        assert!(
            err.contains("UNIQUE constraint failed"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn set_tab_state_updates_the_row() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let row = row(TabState::Open);
        store.insert_tab(&row).unwrap();
        store.set_tab_state(row.tab_id, TabState::Sweeping).unwrap();
        assert_eq!(
            store.get_tab(row.tab_id).unwrap().unwrap().state,
            TabState::Sweeping
        );
    }

    #[test]
    fn open_tabs_includes_open_and_sweeping_only() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let rows: Vec<TabRow> = [
            TabState::Open,
            TabState::Sweeping,
            TabState::Closed,
            TabState::Abandoned,
        ]
        .into_iter()
        .map(row)
        .collect();
        for r in &rows {
            store.insert_tab(r).unwrap();
        }
        let mut got: Vec<Uuid> = store
            .open_tabs()
            .unwrap()
            .iter()
            .map(|t| t.tab_id)
            .collect();
        got.sort();
        let mut want = vec![rows[0].tab_id, rows[1].tab_id];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn open_tabs_excludes_inactive() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let (a, b) = (row(TabState::Open), row(TabState::Open));
        store.insert_tab(&a).unwrap();
        store.insert_tab(&b).unwrap();
        assert!(store.set_active(a.tab_id, false).unwrap());
        let ids = |s: &MetaStore| {
            let mut v: Vec<Uuid> = s.open_tabs().unwrap().iter().map(|t| t.tab_id).collect();
            v.sort();
            v
        };
        assert_eq!(ids(&store), vec![b.tab_id]);
        assert!(!store.get_tab(a.tab_id).unwrap().unwrap().active);
        assert!(store.set_active(a.tab_id, true).unwrap());
        let mut want = vec![a.tab_id, b.tab_id];
        want.sort();
        assert_eq!(ids(&store), want);
        assert!(!store.set_active(Uuid::new_v4(), false).unwrap());
    }

    #[test]
    fn active_column_is_added_to_old_databases() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ztab.sqlite");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE tabs (tab_id TEXT PRIMARY KEY, account_uuid TEXT NOT NULL UNIQUE, ufvk TEXT NOT NULL,
                   birthday INTEGER NOT NULL, participants_count INTEGER NOT NULL,
                   state TEXT NOT NULL, created_at TEXT NOT NULL);
                 INSERT INTO tabs VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'u', 1, 2, 'open', '2026-10-15T00:00:00Z');",
            )
            .unwrap();
        }
        let store = MetaStore::open_at(&path).unwrap();
        let old = store
            .get_tab("00000000-0000-0000-0000-000000000001".parse().unwrap())
            .unwrap()
            .unwrap();
        assert!(old.active);
        let r = row(TabState::Open);
        store.insert_tab(&r).unwrap();
        assert!(store.get_tab(r.tab_id).unwrap().unwrap().active);
        assert_eq!(store.open_tabs().unwrap().len(), 2);
    }

    #[test]
    fn corrupt_stored_rows_are_errors_not_panics_or_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        for (col, bad) in [
            ("state", "bogus"),
            ("created_at", "yesterday"),
            ("tab_id", "not-a-uuid"),
        ] {
            let r = row(TabState::Open);
            store.insert_tab(&r).unwrap();
            store
                .conn()
                .execute(
                    &format!("UPDATE tabs SET {col} = ?1 WHERE tab_id = ?2"),
                    params![bad, r.tab_id.to_string()],
                )
                .unwrap();
            let lookup = if col == "tab_id" {
                // Row is no longer addressable by its original id; list it instead.
                store.open_tabs()
            } else {
                store.get_tab(r.tab_id).map(|t| vec![t.unwrap()])
            };
            assert!(
                matches!(lookup, Err(WatcherError::Wallet(_))),
                "{col}: {lookup:?}"
            );
            // Mutex must still be usable afterwards.
            store.conn().execute("DELETE FROM tabs", []).unwrap();
        }
    }

    #[test]
    fn an_old_database_loses_its_stored_pczts_on_open() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ztab.sqlite");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE sweeps (tab_id TEXT PRIMARY KEY, txid TEXT NOT NULL, pczt_b64 TEXT NOT NULL,
                   expiry_height INTEGER NOT NULL, created_at TEXT NOT NULL, broadcast_at TEXT);
                 INSERT INTO sweeps VALUES ('00000000-0000-0000-0000-000000000001', 'aa', 'UENaVA', 7, '2026-10-15T00:00:00Z', NULL);",
            )
            .unwrap();
        }
        let store = MetaStore::open_at(&path).unwrap();
        let cols: Vec<String> = {
            let c = store.conn();
            let mut st = c
                .prepare("SELECT name FROM pragma_table_info('sweeps')")
                .unwrap();
            let v = st
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            v
        };
        assert!(!cols.iter().any(|c| c == "pczt_b64"), "{cols:?}");
        let row = store.get_sweep(Uuid::from_u128(1)).unwrap().unwrap();
        assert_eq!((row.txid.as_str(), row.expiry_height), ("aa", 7));
        // Reopening is a no-op.
        drop(store);
        MetaStore::open_at(&path).unwrap();
    }

    #[test]
    fn sweep_put_replaces_offer_and_mark_broadcast_stamps_it() {
        let tmp = tempfile::tempdir().unwrap();
        let store = store(&tmp);
        let tab = Uuid::new_v4();
        assert_eq!(store.get_sweep(tab).unwrap(), None);
        assert!(matches!(
            store.mark_broadcast(tab, "aa"),
            Err(WatcherError::Conflict(_))
        ));
        store.put_sweep(tab, "aa", 100).unwrap();
        let first = store.get_sweep(tab).unwrap().unwrap();
        assert_eq!((first.txid.as_str(), first.expiry_height), ("aa", 100));
        assert_eq!(first.broadcast_at, None);
        // Keyed by txid: stamping another transaction touches nothing.
        assert!(matches!(
            store.mark_broadcast(tab, "zz"),
            Err(WatcherError::Conflict(_))
        ));
        assert_eq!(store.get_sweep(tab).unwrap().unwrap().broadcast_at, None);
        store.mark_broadcast(tab, "aa").unwrap();
        assert!(store
            .get_sweep(tab)
            .unwrap()
            .unwrap()
            .broadcast_at
            .is_some());
        // A new offer replaces the old one, including its broadcast stamp.
        store.put_sweep(tab, "bb", 200).unwrap();
        let second = store.get_sweep(tab).unwrap().unwrap();
        assert_eq!(
            (
                second.txid.as_str(),
                second.expiry_height,
                second.broadcast_at
            ),
            ("bb", 200, None)
        );
        // Rows are per tab.
        assert_eq!(store.get_sweep(Uuid::new_v4()).unwrap(), None);
    }
}
