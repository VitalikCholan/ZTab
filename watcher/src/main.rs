#![forbid(unsafe_code)]
// Later tasks consume these modules; drop this allow once they do.
#![allow(dead_code)]
mod config;
mod error;
mod rng;

use config::Config;

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
