use crate::{config::Config, error::WatcherError};
use rusqlite::{params, Connection, OptionalExtension};
use std::{path::Path, sync::Mutex};
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
}

pub struct MetaStore {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tabs (
  tab_id TEXT PRIMARY KEY, account_uuid TEXT NOT NULL UNIQUE, ufvk TEXT NOT NULL,
  birthday INTEGER NOT NULL, participants_count INTEGER NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mempool_sightings (
  txid TEXT NOT NULL, tab_id TEXT NOT NULL, participant_index INTEGER NOT NULL,
  value_zat INTEGER NOT NULL, first_seen_at TEXT NOT NULL,
  PRIMARY KEY (txid, tab_id, participant_index)
);
CREATE TABLE IF NOT EXISTS sweeps (
  tab_id TEXT PRIMARY KEY, txid TEXT NOT NULL, pczt_b64 TEXT NOT NULL,
  expiry_height INTEGER NOT NULL, created_at TEXT NOT NULL, broadcast_at TEXT
);
"#;

impl MetaStore {
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
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert_tab(&self, t: &TabRow) -> Result<(), WatcherError> {
        let created_at = rfc3339(t.created_at)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO tabs (tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![t.tab_id.to_string(), t.account_uuid.to_string(), t.ufvk, t.birthday, t.participants_count, t.state.as_str(), created_at],
        ).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn get_tab(&self, tab_id: Uuid) -> Result<Option<TabRow>, WatcherError> {
        // Raw column values are read under the lock; decoding and validation happen after
        // it is released, so corrupt stored data can neither panic nor poison the mutex.
        type Raw = (String, String, String, u32, u32, String, String);
        let raw: Option<Raw> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at FROM tabs WHERE tab_id = ?1",
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
                    ))
                },
            )
            .optional()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        raw.map(
            |(id, acct, ufvk, birthday, participants_count, state, created)| {
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
                })
            },
        )
        .transpose()
    }

    pub fn set_tab_state(&self, tab_id: Uuid, state: TabState) -> Result<(), WatcherError> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE tabs SET state = ?2 WHERE tab_id = ?1",
                params![tab_id.to_string(), state.as_str()],
            )
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn open_tabs(&self) -> Result<Vec<TabRow>, WatcherError> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn
            .prepare("SELECT tab_id FROM tabs WHERE state IN ('open','sweeping')")
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

fn parse_uuid(field: &str, s: &str) -> Result<Uuid, WatcherError> {
    s.parse()
        .map_err(|e| WatcherError::Wallet(format!("stored {field} is not a valid uuid: {e}")))
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
        }
    }

    fn store(tmp: &tempfile::TempDir) -> MetaStore {
        MetaStore::open_at(&tmp.path().join("ztab.sqlite")).unwrap()
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
                .conn
                .lock()
                .unwrap()
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
            store
                .conn
                .lock()
                .unwrap()
                .execute("DELETE FROM tabs", [])
                .unwrap();
        }
    }
}
