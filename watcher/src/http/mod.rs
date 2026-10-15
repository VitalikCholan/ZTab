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
}

async fn auth(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.uri().path() == "/v1/health" {
        return Ok(next.run(req).await);
    }
    let expected = format!("Bearer {}", state.cfg.api_token);
    match req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v == expected => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/tabs", post(tabs::register))
        .route("/v1/tabs/{tab_id}", get(tabs::get_tab))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
