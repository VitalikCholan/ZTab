use tonic::transport::{Channel, ClientTlsConfig, Uri};
use zcash_client_backend::proto::service::{
    self, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::BlockHeight;

use crate::{
    config::{Config, Connection},
    error::WatcherError,
};

pub type LwdClient = CompactTxStreamerClient<Channel>;

pub async fn connect(cfg: &Config) -> Result<LwdClient, WatcherError> {
    match cfg.connection {
        Connection::Direct => connect_direct(&cfg.lightwalletd_url).await,
        Connection::Tor => connect_tor(cfg).await,
    }
}

fn parse_uri(url: &str) -> Result<Uri, WatcherError> {
    url.parse()
        .map_err(|e| WatcherError::Config(format!("ZTAB_LIGHTWALLETD_URL: {e}")))
}

async fn connect_direct(url: &str) -> Result<LwdClient, WatcherError> {
    let uri = parse_uri(url)?;
    let host = uri
        .host()
        .ok_or_else(|| WatcherError::Config("lightwalletd url has no host".into()))?
        .to_string();
    let mut channel = Channel::builder(uri.clone());
    if uri.scheme_str() == Some("https") {
        let tls = ClientTlsConfig::new()
            .domain_name(host)
            .assume_http2(true)
            .with_webpki_roots();
        channel = channel
            .tls_config(tls)
            .map_err(|e| WatcherError::Remote(e.to_string()))?;
    }
    let channel = channel
        .connect()
        .await
        .map_err(|e| WatcherError::Remote(format!("connect {url}: {e}")))?;
    Ok(CompactTxStreamerClient::new(channel))
}

/// Bootstraps an embedded Tor client in `data_dir/tor` and dials lightwalletd over it.
/// Not exercised by tests (no Tor on CI); compiled against the pinned crate API.
async fn connect_tor(cfg: &Config) -> Result<LwdClient, WatcherError> {
    let tor_dir = cfg.data_dir.join("tor");
    std::fs::create_dir_all(&tor_dir).map_err(|e| WatcherError::Config(e.to_string()))?;
    let tor = zcash_client_backend::tor::Client::create(&tor_dir, |_| {})
        .await
        .map_err(|e| WatcherError::Remote(format!("tor bootstrap: {e}")))?;
    let uri = parse_uri(&cfg.lightwalletd_url)?;
    tor.connect_to_lightwalletd(uri, false)
        .await
        .map_err(|e| WatcherError::Remote(format!("tor connect: {e}")))
}

pub async fn latest_height(
    client: &mut LwdClient,
) -> Result<(BlockHeight, BlockHash), WatcherError> {
    let latest = client
        .get_latest_block(service::ChainSpec::default())
        .await
        .map_err(|e| WatcherError::Remote(e.to_string()))?
        .into_inner();
    let height = BlockHeight::from_u32(
        u32::try_from(latest.height)
            .map_err(|_| WatcherError::Remote("tip height overflow".into()))?,
    );
    let hash: [u8; 32] = latest
        .hash
        .as_slice()
        .try_into()
        .map_err(|_| WatcherError::Remote("tip hash is not 32 bytes".into()))?;
    Ok((height, BlockHash(hash)))
}
