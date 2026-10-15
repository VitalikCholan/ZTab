use std::{future::Future, sync::Arc, time::Duration};

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

/// Budget for a unary RPC (tip, tree state, one transaction, send).
pub const UNARY_TIMEOUT: Duration = Duration::from_secs(30);
/// Budget for a streaming RPC to return its response headers (the stream's start).
pub const STREAM_START_TIMEOUT: Duration = Duration::from_secs(60);
/// Budget for dialing lightwalletd (TCP + TLS) before a request fails.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// HTTP/2 PING interval and the time to wait for its ACK: a half-open connection is
/// detected and dropped instead of hanging an RPC (and the shared client lock) forever.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const KEEPALIVE_TIMEOUT: Duration = Duration::from_secs(10);
/// Budget for bootstrapping Tor and dialing lightwalletd through it.
const TOR_CONNECT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(60);

/// Runs `fut` (an RPC or any remote step) with a deadline: an error or an elapsed budget
/// becomes `Remote("<what>: ...")`.
pub async fn with_timeout<T, E, F>(what: &str, budget: Duration, fut: F) -> Result<T, WatcherError>
where
    E: std::fmt::Display,
    F: Future<Output = Result<T, E>>,
{
    match tokio::time::timeout(budget, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(WatcherError::Remote(format!("{what}: {e}"))),
        Err(_) => Err(WatcherError::Remote(format!(
            "{what}: timed out after {}s",
            budget.as_secs()
        ))),
    }
}

/// A client for the configured lightwalletd. Direct connections are lazy (dialed on first
/// use, re-dialed after failures), so this only fails on a bad URL. Tor connections
/// bootstrap the Tor client first and fail if that does.
pub async fn connect(cfg: &Config) -> Result<LwdClient, WatcherError> {
    match cfg.connection {
        Connection::Direct => connect_direct(&cfg.lightwalletd_url),
        Connection::Tor => {
            with_timeout("tor connect", TOR_CONNECT_TIMEOUT, async {
                connect_tor(cfg).await
            })
            .await
        }
    }
}

/// The shared client for startup, never failing on an unreachable lightwalletd: a direct
/// client is lazy; for Tor, a placeholder that dials nothing (requests fail fast) is
/// returned and the Tor connection is established in the background with backoff, then
/// swapped in. The HTTP server can therefore serve `/v1/health` and stored facts at once.
pub async fn startup_client(
    cfg: &Arc<Config>,
) -> Result<Arc<tokio::sync::Mutex<LwdClient>>, WatcherError> {
    match cfg.connection {
        Connection::Direct => Ok(Arc::new(tokio::sync::Mutex::new(connect_direct(
            &cfg.lightwalletd_url,
        )?))),
        Connection::Tor => {
            let placeholder = CompactTxStreamerClient::new(
                Channel::from_static("http://127.0.0.1:1").connect_lazy(),
            );
            let client = Arc::new(tokio::sync::Mutex::new(placeholder));
            tokio::spawn(connect_in_background(cfg.clone(), client.clone()));
            Ok(client)
        }
    }
}

async fn connect_in_background(cfg: Arc<Config>, client: Arc<tokio::sync::Mutex<LwdClient>>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(&cfg).await {
            Ok(c) => {
                *client.lock().await = c;
                tracing::info!("connected to lightwalletd");
                return;
            }
            Err(e) => {
                tracing::warn!(kind = e.kind(), "lightwalletd connect failed; retrying");
                tracing::debug!(error = %e, "lightwalletd connect failure");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_RECONNECT_BACKOFF);
            }
        }
    }
}

/// Parses the lightwalletd URL, refusing plaintext to a non-local host (see
/// [`crate::config::check_lightwalletd_url`]) even if the config check was bypassed.
fn parse_uri(url: &str) -> Result<Uri, WatcherError> {
    crate::config::check_lightwalletd_url(url)?;
    url.parse()
        .map_err(|e| WatcherError::Config(format!("ZTAB_LIGHTWALLETD_URL: {e}")))
}

fn connect_direct(url: &str) -> Result<LwdClient, WatcherError> {
    let uri = parse_uri(url)?;
    let host = uri
        .host()
        .ok_or_else(|| WatcherError::Config("lightwalletd url has no host".into()))?
        .to_string();
    let mut channel = Channel::builder(uri.clone())
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(Some(KEEPALIVE_INTERVAL))
        .http2_keep_alive_interval(KEEPALIVE_INTERVAL)
        .keep_alive_timeout(KEEPALIVE_TIMEOUT)
        .keep_alive_while_idle(true);
    // TLS exactly when the URL says https; a TLS failure is a `Remote` error, never a
    // retry over plaintext.
    if uri.scheme_str() == Some("https") {
        let tls = ClientTlsConfig::new()
            .domain_name(host)
            .assume_http2(true)
            .with_webpki_roots();
        channel = channel
            .tls_config(tls)
            .map_err(|e| WatcherError::Remote(e.to_string()))?;
    }
    Ok(CompactTxStreamerClient::new(channel.connect_lazy()))
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
    let latest = with_timeout(
        "get_latest_block",
        UNARY_TIMEOUT,
        client.get_latest_block(service::ChainSpec::default()),
    )
    .await?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_never_resolving_call_times_out_as_remote_error() {
        let started = std::time::Instant::now();
        let r: Result<(), _> = with_timeout(
            "get_tree_state",
            Duration::from_millis(50),
            std::future::pending::<Result<(), String>>(),
        )
        .await;
        match r {
            Err(WatcherError::Remote(m)) => {
                assert!(m.starts_with("get_tree_state: timed out"), "{m}")
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(started.elapsed() < Duration::from_secs(5));
        // Errors and values pass through.
        let e = with_timeout("x", UNARY_TIMEOUT, async { Err::<(), _>("boom") }).await;
        assert!(matches!(e, Err(WatcherError::Remote(m)) if m == "x: boom"));
        let v = with_timeout("x", UNARY_TIMEOUT, async { Ok::<_, String>(7) }).await;
        assert_eq!(v.unwrap(), 7);
    }

    #[tokio::test]
    async fn direct_connect_is_lazy_and_does_not_fail_on_an_unreachable_server() {
        // Port 1 on localhost refuses connections; building the client must not dial it.
        let mut client = connect_direct("http://127.0.0.1:1").unwrap();
        let r = latest_height(&mut client).await;
        assert!(matches!(r, Err(WatcherError::Remote(_))), "{r:?}");
        assert!(connect_direct("not a url").is_err());
        // Plaintext to a public host is refused before anything is dialed.
        assert!(matches!(
            connect_direct("http://testnet.zec.rocks:443"),
            Err(WatcherError::Config(_))
        ));
        // A failed TLS connect is a Remote error (no plaintext retry exists to fall back to).
        let mut tls = connect_direct("https://127.0.0.1:1").unwrap();
        assert!(matches!(
            latest_height(&mut tls).await,
            Err(WatcherError::Remote(_))
        ));
    }
}
