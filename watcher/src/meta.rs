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
        self.conn.lock().unwrap().execute(
            "INSERT INTO tabs (tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![t.tab_id.to_string(), t.account_uuid.to_string(), t.ufvk, t.birthday, t.participants_count, t.state.as_str(), rfc3339(t.created_at)],
        ).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        Ok(())
    }

    pub fn get_tab(&self, tab_id: Uuid) -> Result<Option<TabRow>, WatcherError> {
        self.conn.lock().unwrap().query_row(
            "SELECT tab_id, account_uuid, ufvk, birthday, participants_count, state, created_at FROM tabs WHERE tab_id = ?1",
            params![tab_id.to_string()],
            |r| Ok(TabRow {
                tab_id: r.get::<_, String>(0)?.parse().unwrap(), account_uuid: r.get::<_, String>(1)?.parse().unwrap(),
                ufvk: r.get(2)?, birthday: r.get(3)?, participants_count: r.get(4)?,
                state: TabState::parse(&r.get::<_, String>(5)?).unwrap_or(TabState::Open),
                created_at: parse_rfc3339(&r.get::<_, String>(6)?),
            }),
        ).optional().map_err(|e| WatcherError::Wallet(e.to_string()))
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
        ids.iter()
            .filter_map(|s| s.parse().ok())
            .map(|id| self.get_tab(id))
            .filter_map(|r| r.transpose())
            .collect()
    }
}

pub fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
pub fn parse_rfc3339(s: &str) -> OffsetDateTime {
    OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn insert_and_get_tab_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MetaStore::open_at(&tmp.path().join("ztab.sqlite")).unwrap();
        let row = TabRow {
            tab_id: Uuid::new_v4(),
            account_uuid: Uuid::new_v4(),
            ufvk: "uviewtest1abc".into(),
            birthday: 4_503_583,
            participants_count: 4,
            state: TabState::Open,
            created_at: time::OffsetDateTime::now_utc()
                .replace_nanosecond(0)
                .unwrap(),
        };
        store.insert_tab(&row).unwrap();
        let got = store.get_tab(row.tab_id).unwrap().unwrap();
        assert_eq!(got.ufvk, row.ufvk);
        assert_eq!(got.participants_count, 4);
        assert_eq!(got.state, TabState::Open);
        assert!(store.get_tab(Uuid::new_v4()).unwrap().is_none());
    }

    #[test]
    fn insert_same_tab_twice_is_a_constraint_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MetaStore::open_at(&tmp.path().join("ztab.sqlite")).unwrap();
        let row = TabRow {
            tab_id: Uuid::new_v4(),
            account_uuid: Uuid::new_v4(),
            ufvk: "u".into(),
            birthday: 1,
            participants_count: 1,
            state: TabState::Open,
            created_at: time::OffsetDateTime::now_utc(),
        };
        store.insert_tab(&row).unwrap();
        assert!(store.insert_tab(&row).is_err());
    }
}
