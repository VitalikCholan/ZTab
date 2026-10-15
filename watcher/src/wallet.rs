use crate::{config::Config, error::WatcherError, remote::LwdClient, rng::OsRng};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use uuid::Uuid;
use zcash_client_backend::{
    data_api::{chain::ChainState, Account, AccountBirthday, AccountPurpose, WalletWrite},
    proto::service,
};
use zcash_client_sqlite::{
    chain::init::init_blockmeta_db, util::SystemClock, wallet::init::init_wallet_db, AccountUuid,
    FsBlockDb, WalletDb,
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

pub struct WalletStore {
    network: Network,
    db: Mutex<Db>,
    cache: Mutex<FsBlockDb>,
    blocks_dir: PathBuf,
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
        Ok(Self {
            network: cfg.network,
            db: Mutex::new(db),
            cache: Mutex::new(cache),
            blocks_dir: blocks_root.join("blocks"),
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }
    pub fn db(&self) -> MutexGuard<'_, Db> {
        self.db.lock().unwrap()
    }
    pub fn cache(&self) -> MutexGuard<'_, FsBlockDb> {
        self.cache.lock().unwrap()
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
        let ufvk = self.parse_ufvk(ufvk)?;
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
        let account_birthday = AccountBirthday::from_parts(chain_state, None);
        let mut db = self.db();
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
}
