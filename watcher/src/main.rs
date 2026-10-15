#![forbid(unsafe_code)]
use std::sync::Arc;
use ztab_watcher::{
    config::Config,
    http::{router, AppState, HealthState},
    meta::MetaStore,
    remote,
    wallet::WalletStore,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cfg = Arc::new(Config::from_env()?);
    let wallet = Arc::new(WalletStore::open(&cfg)?);
    let meta = Arc::new(MetaStore::open(&cfg)?);
    let client = Arc::new(tokio::sync::Mutex::new(remote::connect(&cfg).await?));
    let state = AppState {
        cfg: cfg.clone(),
        wallet,
        meta,
        client,
        health: Arc::new(HealthState::default()),
        sweep_locks: Default::default(),
    };
    tokio::spawn(ztab_watcher::sync::run_sync_loop(state.clone()));
    tokio::spawn(ztab_watcher::mempool::run_mempool_loop(state.clone()));
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    tracing::info!(listen = %cfg.listen, network = ?cfg.network, "ztab-watcher listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
