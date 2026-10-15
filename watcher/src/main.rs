#![forbid(unsafe_code)]
use ztab_watcher::config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cfg = Config::from_env()?;
    tracing::info!(listen = %cfg.listen, network = ?cfg.network, "ztab-watcher starting");
    Ok(())
}
