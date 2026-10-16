pub mod health;
pub mod sweep;
pub mod tabs;
use crate::{config::Config, meta::MetaStore, remote::LwdClient, wallet::WalletStore};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU32},
    Arc,
};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Default)]
pub struct HealthState {
    pub tip_height: AtomicU32,
    pub synced_height: AtomicU32,
    pub mempool_subscribed: AtomicBool,
    pub last_ok_at: std::sync::Mutex<Option<time::OffsetDateTime>>,
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub wallet: Arc<WalletStore>,
    pub meta: Arc<MetaStore>,
    pub client: Arc<AsyncMutex<LwdClient>>,
    pub health: Arc<HealthState>,
    pub sweep_locks: Arc<crate::sweep::SweepLocks>,
}

async fn auth(
    State(token): State<Arc<str>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.uri().path() == "/v1/health" {
        return Ok(next.run(req).await);
    }
    let expected = format!("Bearer {token}");
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .is_some_and(|v| token_matches(v.as_bytes(), expected.as_bytes()));
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Compares SHA-256 digests with a constant-time equality, so neither content nor length
/// of the secret leaks through timing.
fn token_matches(given: &[u8], expected: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    use subtle::ConstantTimeEq;
    let g = Sha256::digest(given);
    let e = Sha256::digest(expected);
    g.ct_eq(&e).into()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health::health))
        .route("/v1/tabs", post(tabs::register))
        .route("/v1/tabs/{tab_id}", get(tabs::get_tab))
        .route(
            "/v1/tabs/{tab_id}/sweep",
            post(sweep::offer).get(sweep::status),
        )
        .route("/v1/tabs/{tab_id}/broadcast", post(sweep::broadcast))
        .route_layer(middleware::from_fn_with_state(
            Arc::<str>::from(state.cfg.api_token.as_str()),
            auth,
        ))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request as HttpRequest};
    use tower::ServiceExt;

    fn app(token: &str) -> Router {
        Router::new()
            .route("/x", get(|| async { "ok" }))
            .route_layer(middleware::from_fn_with_state(
                Arc::<str>::from(token),
                auth,
            ))
    }

    async fn status(app: Router, hdr: Option<&str>) -> StatusCode {
        let mut r = HttpRequest::builder().uri("/x");
        if let Some(h) = hdr {
            r = r.header(header::AUTHORIZATION, h);
        }
        app.oneshot(r.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn bearer_auth() {
        assert_eq!(status(app("s3"), Some("Bearer s3")).await, StatusCode::OK);
        assert_eq!(
            status(app("s3"), Some("Bearer s4")).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(app("s3"), Some("Bearer s3x")).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(status(app("s3"), None).await, StatusCode::UNAUTHORIZED);
    }
}
