use crate::error::WatcherError;
use std::{collections::HashMap, net::SocketAddr, path::PathBuf};
use zcash_protocol::consensus::Network;

#[derive(Clone, Debug)]
pub enum Connection {
    Direct,
    Tor,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub network: Network,
    pub lightwalletd_url: String,
    pub connection: Connection,
    pub confirmations_paid: u32,
    pub confirmations_sweep: u32,
    pub block_interval_seconds: u64,
    pub data_dir: PathBuf,
    pub listen: SocketAddr,
    pub api_token: String,
}

impl Config {
    pub fn from_env() -> Result<Self, WatcherError> {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(m: &HashMap<String, String>) -> Result<Self, WatcherError> {
        let get = |k: &str| {
            m.get(k)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let network = match get("ZTAB_NETWORK").as_deref().unwrap_or("test") {
            "test" => Network::TestNetwork,
            "main" => Network::MainNetwork,
            other => {
                return Err(WatcherError::Config(format!(
                    "ZTAB_NETWORK must be test or main, got {other}"
                )))
            }
        };
        let is_main = matches!(network, Network::MainNetwork);
        let parse_u = |k: &str, d: u64| -> Result<u64, WatcherError> {
            get(k).map_or(Ok(d), |v| {
                v.parse::<u64>()
                    .map_err(|_| WatcherError::Config(format!("{k} must be an integer")))
            })
        };
        let parse_u32 = |k: &str, d: u32| -> Result<u32, WatcherError> {
            u32::try_from(parse_u(k, u64::from(d))?)
                .map_err(|_| WatcherError::Config(format!("{k} is out of range")))
        };
        let lightwalletd_url =
            get("ZTAB_LIGHTWALLETD_URL").unwrap_or_else(|| "https://testnet.zec.rocks:443".into());
        check_lightwalletd_url(&lightwalletd_url)?;
        Ok(Config {
            network,
            lightwalletd_url,
            connection: match get("ZTAB_CONNECTION").as_deref() {
                Some("tor") => Connection::Tor,
                Some("direct") => Connection::Direct,
                None => {
                    if is_main {
                        Connection::Tor
                    } else {
                        Connection::Direct
                    }
                }
                Some(o) => {
                    return Err(WatcherError::Config(format!(
                        "ZTAB_CONNECTION must be direct or tor, got {o}"
                    )))
                }
            },
            confirmations_paid: parse_u32("ZTAB_CONFIRMATIONS_PAID", 3)?,
            confirmations_sweep: parse_u32("ZTAB_CONFIRMATIONS_SWEEP", 10)?,
            block_interval_seconds: parse_u(
                "ZTAB_BLOCK_INTERVAL_SECONDS",
                if is_main { 75 } else { 25 },
            )?,
            data_dir: PathBuf::from(
                get("ZTAB_DATA_DIR")
                    .ok_or_else(|| WatcherError::Config("ZTAB_DATA_DIR is required".into()))?,
            ),
            listen: get("ZTAB_LISTEN")
                .unwrap_or_else(|| "127.0.0.1:8787".into())
                .parse()
                .map_err(|_| WatcherError::Config("ZTAB_LISTEN must be host:port".into()))?,
            api_token: get("ZTAB_API_TOKEN")
                .ok_or_else(|| WatcherError::Config("ZTAB_API_TOKEN is required".into()))?,
        })
    }
}

/// A lightwalletd URL must be `https://`, or `http://` to a loopback or private-range host
/// (127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, `localhost`). The scheme is never
/// guessed or downgraded: TLS is used exactly when the URL says `https`.
pub fn check_lightwalletd_url(url: &str) -> Result<(), WatcherError> {
    let bad = |m: &str| WatcherError::Config(format!("ZTAB_LIGHTWALLETD_URL: {m}"));
    let uri: tonic::transport::Uri = url.parse().map_err(|_| bad("not a valid URL"))?;
    let host = uri.host().ok_or_else(|| bad("the URL has no host"))?;
    match uri.scheme_str() {
        Some("https") => Ok(()),
        Some("http") if is_local_host(host) => Ok(()),
        Some("http") => Err(bad(
            "plaintext http:// is only allowed for loopback or private-network hosts; use https://",
        )),
        _ => Err(bad(
            "the scheme must be https:// (or http:// for a local node)",
        )),
    }
}

fn is_local_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_apply_for_testnet() {
        let cfg = Config::from_map(&env(&[
            ("ZTAB_API_TOKEN", "t"),
            ("ZTAB_DATA_DIR", "/tmp/x"),
        ]))
        .unwrap();
        assert_eq!(cfg.confirmations_paid, 3);
        assert_eq!(cfg.confirmations_sweep, 10);
        assert_eq!(cfg.block_interval_seconds, 25);
        assert_eq!(cfg.lightwalletd_url, "https://testnet.zec.rocks:443");
        assert!(matches!(
            cfg.network,
            zcash_protocol::consensus::Network::TestNetwork
        ));
    }

    #[test]
    fn plaintext_lightwalletd_only_for_local_hosts() {
        let with_url = |u: &str| {
            Config::from_map(&env(&[
                ("ZTAB_API_TOKEN", "t"),
                ("ZTAB_DATA_DIR", "/tmp/x"),
                ("ZTAB_LIGHTWALLETD_URL", u),
            ]))
        };
        for u in [
            "http://testnet.zec.rocks:443",
            "http://8.8.8.8:9067",
            "http://172.32.0.1:9067",
            "grpc://127.0.0.1:9067",
            "testnet.zec.rocks:443",
        ] {
            assert!(
                matches!(with_url(u), Err(WatcherError::Config(_))),
                "{u} must be refused"
            );
        }
        for u in [
            "http://127.0.0.1:9067",
            "http://localhost:9067",
            "http://[::1]:9067",
            "http://10.1.2.3:9067",
            "http://172.16.0.5:9067",
            "http://192.168.1.10:9067",
            "https://testnet.zec.rocks:443",
            "https://zec.rocks:443",
        ] {
            assert!(with_url(u).is_ok(), "{u} must be accepted");
        }
    }

    #[test]
    fn missing_token_is_an_error() {
        let err = Config::from_map(&env(&[("ZTAB_DATA_DIR", "/tmp/x")])).unwrap_err();
        assert!(err.to_string().contains("ZTAB_API_TOKEN"));
    }

    #[test]
    fn mainnet_defaults_to_75s_blocks_and_tor() {
        let cfg = Config::from_map(&env(&[
            ("ZTAB_API_TOKEN", "t"),
            ("ZTAB_DATA_DIR", "/tmp/x"),
            ("ZTAB_NETWORK", "main"),
            ("ZTAB_LIGHTWALLETD_URL", "https://zec.rocks:443"),
        ]))
        .unwrap();
        assert_eq!(cfg.block_interval_seconds, 75);
        assert!(matches!(cfg.connection, Connection::Tor));
    }
}
