use crate::{config::Config, error::WatcherError, remote::LwdClient, rng::OsRng};
use rusqlite::OptionalExtension;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use uuid::Uuid;
use zcash_client_backend::{
    data_api::{
        chain::ChainState, Account, AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
    },
    proto::service,
};
use zcash_client_sqlite::{
    chain::init::init_blockmeta_db, error::SqliteClientError, util::SystemClock,
    wallet::init::init_wallet_db, AccountUuid, FsBlockDb, WalletDb,
};
use zcash_keys::keys::{ReceiverRequirement, UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};
use zip32::DiversifierIndex;

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

pub struct WalletStore {
    network: Network,
    db: Mutex<Db>,
    cache: Mutex<FsBlockDb>,
    read: Mutex<rusqlite::Connection>,
    blocks_dir: PathBuf,
    /// Orchard receivers of each account's participant addresses, by diversifier index.
    orchard_receivers: Mutex<HashMap<AccountUuid, Vec<orchard::Address>>>,
}

impl WalletStore {
    pub fn open(cfg: &Config) -> Result<Self, WatcherError> {
        std::fs::create_dir_all(&cfg.data_dir).map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let blocks_root = cfg.data_dir.clone();
        std::fs::create_dir_all(blocks_root.join("blocks"))
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        let mut cache = FsBlockDb::for_path(&blocks_root)
            .map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        init_blockmeta_db(&mut cache).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        let mut db = WalletDb::for_path(
            cfg.data_dir.join("wallet.sqlite"),
            cfg.network,
            SystemClock,
            OsRng,
        )
        .map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        init_wallet_db(&mut db, None).map_err(|e| WatcherError::Wallet(format!("{e:?}")))?;
        let read = rusqlite::Connection::open_with_flags(
            cfg.data_dir.join("wallet.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| WatcherError::Wallet(format!("read connection: {e}")))?;
        Ok(Self {
            network: cfg.network,
            db: Mutex::new(db),
            cache: Mutex::new(cache),
            read: Mutex::new(read),
            blocks_dir: blocks_root.join("blocks"),
            orchard_receivers: Mutex::new(HashMap::new()),
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }
    // Locks tolerate poisoning: a poisoned guard only means a panic happened mid-call, and
    // WalletDb/FsBlockDb wrap each write in a SQLite transaction, so state stays consistent.
    pub fn db(&self) -> MutexGuard<'_, Db> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn cache(&self) -> MutexGuard<'_, FsBlockDb> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Read-only connection to the wallet database for raw SELECTs on the wallet schema.
    pub fn read_conn(&self) -> MutexGuard<'_, rusqlite::Connection> {
        self.read.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn blocks_dir(&self) -> &Path {
        &self.blocks_dir
    }

    pub fn parse_ufvk(&self, ufvk: &str) -> Result<UnifiedFullViewingKey, WatcherError> {
        UnifiedFullViewingKey::decode(&self.network, ufvk)
            .map_err(|e| WatcherError::Unprocessable(format!("ufvk: {e}")))
    }

    /// Builds the birthday from the tree state at `birthday - 1` (mirrors zcash-devtool
    /// `init::get_wallet_birthday`) and imports a view-only account named after the tab.
    pub async fn import_tab_account(
        &self,
        client: &mut LwdClient,
        tab_id: Uuid,
        ufvk: &str,
        birthday: u32,
    ) -> Result<AccountUuid, WatcherError> {
        let ufvk_parsed = self.parse_ufvk(ufvk)?;
        // Retry after a crash between import and tab insert: reuse the existing account.
        if let Some(existing) = self.account_for_ufvk(&ufvk_parsed)? {
            return Ok(existing);
        }
        let sapling = self
            .network
            .activation_height(NetworkUpgrade::Sapling)
            .expect("sapling height");
        let birthday_height = BlockHeight::from_u32(birthday).max(sapling);
        let tree_state = client
            .get_tree_state(service::BlockId {
                height: u64::from(birthday_height) - 1,
                hash: vec![],
            })
            .await
            .map_err(|e| WatcherError::Remote(format!("get_tree_state: {e}")))?
            .into_inner();
        let chain_state: ChainState = tree_state
            .to_chain_state()
            .map_err(|e| WatcherError::Remote(format!("tree state: {e}")))?;
        self.import_tab_account_from_chain_state(tab_id, ufvk, chain_state)
    }

    /// Imports a view-only account named after the tab whose birthday is the block after
    /// `chain_state`; an account already holding this UFVK is reused.
    pub fn import_tab_account_from_chain_state(
        &self,
        tab_id: Uuid,
        ufvk: &str,
        chain_state: ChainState,
    ) -> Result<AccountUuid, WatcherError> {
        let ufvk = self.parse_ufvk(ufvk)?;
        let mut db = self.db();
        if let Some(existing) = db
            .get_account_for_ufvk(&ufvk)
            .map_err(|e| WatcherError::Wallet(format!("get_account_for_ufvk: {e:?}")))?
        {
            return Ok(existing.id());
        }
        let account_birthday = AccountBirthday::from_parts(chain_state, None);
        let account = db
            .import_account_ufvk(
                &tab_id.to_string(),
                &ufvk,
                &account_birthday,
                AccountPurpose::ViewOnly,
                None,
            )
            .map_err(|e| WatcherError::Wallet(format!("import_account_ufvk: {e:?}")))?;
        Ok(account.id())
    }

    fn account_for_ufvk(
        &self,
        ufvk: &UnifiedFullViewingKey,
    ) -> Result<Option<AccountUuid>, WatcherError> {
        Ok(self
            .db()
            .get_account_for_ufvk(ufvk)
            .map_err(|e| WatcherError::Wallet(format!("get_account_for_ufvk: {e:?}")))?
            .map(|a| a.id()))
    }

    /// Orchard-only unified addresses for diversifier indices `0..count`; persisted in the
    /// wallet's `addresses` table so received notes carry an `address_id`.
    pub fn participant_addresses(
        &self,
        account: AccountUuid,
        count: u32,
    ) -> Result<Vec<(u32, String)>, WatcherError> {
        let request = UnifiedAddressRequest::custom(
            ReceiverRequirement::Require,
            ReceiverRequirement::Omit,
            ReceiverRequirement::Omit,
        )
        .map_err(|e| WatcherError::Wallet(format!("address request: {e:?}")))?;
        let mut db = self.db();
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let idx = DiversifierIndex::from(i);
            let ua = match db.get_address_for_index(account, idx, request) {
                Ok(Some(ua)) => ua,
                Ok(None) => {
                    return Err(WatcherError::Wallet(format!(
                        "no orchard address at index {i}"
                    )))
                }
                // The wallet already stores a different (full-receiver) address at this
                // index, e.g. the default address created on import. Its row supplies the
                // address_id; the Orchard-only form is derived from the UFVK directly.
                Err(SqliteClientError::DiversifierIndexReuse(..)) => {
                    let ufvk = db
                        .get_account(account)
                        .map_err(|e| WatcherError::Wallet(format!("get_account: {e:?}")))?
                        .and_then(|a| a.ufvk().cloned())
                        .ok_or_else(|| WatcherError::Wallet("account has no UFVK".into()))?;
                    ufvk.address(idx, request).map_err(|e| {
                        WatcherError::Wallet(format!("derive address at index {i}: {e:?}"))
                    })?
                }
                Err(e) => {
                    return Err(WatcherError::Wallet(format!(
                        "get_address_for_index({i}): {e:?}"
                    )))
                }
            };
            out.push((i, ua.encode(&self.network)));
        }
        Ok(out)
    }

    /// The participant index in `0..participants` whose Orchard-only address has `addr` as
    /// its Orchard receiver. Receivers are derived from the account's UFVK exactly as
    /// `participant_addresses` derives them, without writing to the wallet, and cached.
    pub fn index_for_orchard_address(
        &self,
        account: AccountUuid,
        participants: u32,
        addr: &orchard::Address,
    ) -> Result<Option<u32>, WatcherError> {
        let lookup = |receivers: &[orchard::Address]| {
            receivers
                .iter()
                .take(participants as usize)
                .position(|r| r == addr)
                .map(|i| i as u32)
        };
        {
            let cache = self
                .orchard_receivers
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(receivers) = cache.get(&account) {
                if receivers.len() >= participants as usize {
                    return Ok(lookup(receivers));
                }
            }
        }
        let ufvk = self
            .db()
            .get_account(account)
            .map_err(|e| WatcherError::Wallet(format!("get_account: {e:?}")))?
            .and_then(|a| a.ufvk().cloned())
            .ok_or_else(|| WatcherError::Wallet("account has no UFVK".into()))?;
        let request = UnifiedAddressRequest::custom(
            ReceiverRequirement::Require,
            ReceiverRequirement::Omit,
            ReceiverRequirement::Omit,
        )
        .map_err(|e| WatcherError::Wallet(format!("address request: {e:?}")))?;
        let receivers = (0..participants)
            .map(|i| {
                ufvk.address(DiversifierIndex::from(i), request)
                    .map_err(|e| {
                        WatcherError::Wallet(format!("derive address at index {i}: {e:?}"))
                    })?
                    .orchard()
                    .copied()
                    .ok_or_else(|| WatcherError::Wallet(format!("no orchard receiver at {i}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let index = lookup(&receivers);
        self.orchard_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(account, receivers);
        Ok(index)
    }

    pub fn index_for_address_id(&self, address_id: i64) -> Result<Option<u32>, WatcherError> {
        let conn = self.read_conn();
        let be: Option<Vec<u8>> = conn
            .query_row(
                "SELECT diversifier_index_be FROM addresses WHERE id = ?1",
                [address_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| WatcherError::Wallet(e.to_string()))?;
        be.map(|b| {
            index_from_be(&b)
                .ok_or_else(|| WatcherError::Wallet("diversifier index out of u32 range".into()))
        })
        .transpose()
    }
}

/// Decodes an 11-byte big-endian diversifier index; `None` if malformed or above `u32::MAX`.
pub fn index_from_be(b: &[u8]) -> Option<u32> {
    let n: [u8; 11] = b.try_into().ok()?;
    if n[..7].iter().any(|&x| x != 0) {
        return None;
    }
    Some(u32::from_be_bytes([n[7], n[8], n[9], n[10]]))
}

pub fn account_uuid(u: Uuid) -> AccountUuid {
    AccountUuid::from_uuid(u)
}

#[cfg(test)]
mod tests {
    use super::index_from_be;

    #[test]
    fn decodes_big_endian_index() {
        let mut b = [0u8; 11];
        assert_eq!(index_from_be(&b), Some(0));
        b[10] = 5;
        assert_eq!(index_from_be(&b), Some(5));
        b[9] = 1;
        assert_eq!(index_from_be(&b), Some(261));
        b[7] = 0xff;
        assert_eq!(index_from_be(&b), Some(0xff00_0105));
        b[6] = 1;
        assert_eq!(index_from_be(&b), None);
        assert_eq!(index_from_be(&[0u8; 10]), None);
    }
}
