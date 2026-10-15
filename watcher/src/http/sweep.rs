use super::AppState;
use crate::{
    error::WatcherError,
    meta::TabRow,
    sweep::{self, SweepOffer, SweepStatus},
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct OfferRequest {
    pub recipient_address: String,
    pub memo: Option<String>,
}

#[derive(Deserialize)]
pub struct BroadcastRequest {
    pub pczt_b64: String,
}

#[derive(Serialize)]
pub struct BroadcastOut {
    pub txid: String,
}

fn load_tab(state: &AppState, tab_id: Uuid) -> Result<TabRow, WatcherError> {
    state
        .meta
        .get_tab(tab_id)?
        .ok_or_else(|| WatcherError::NotFound(format!("tab {tab_id}")))
}

/// `POST /v1/tabs/{tab_id}/sweep`: a proved, unsigned PCZT sweeping the whole tab.
pub async fn offer(
    State(state): State<AppState>,
    Path(tab_id): Path<Uuid>,
    Json(body): Json<OfferRequest>,
) -> Result<Json<SweepOffer>, WatcherError> {
    let tab = load_tab(&state, tab_id)?;
    let offer =
        sweep::create_proved_pczt(&state, &tab, &body.recipient_address, body.memo.as_deref())
            .await?;
    Ok(Json(offer))
}

/// `POST /v1/tabs/{tab_id}/broadcast`: broadcasts the signed form of the offered sweep.
pub async fn broadcast(
    State(state): State<AppState>,
    Path(tab_id): Path<Uuid>,
    Json(body): Json<BroadcastRequest>,
) -> Result<Json<BroadcastOut>, WatcherError> {
    let tab = load_tab(&state, tab_id)?;
    let txid = sweep::broadcast_signed(&state, &tab, &body.pczt_b64).await?;
    Ok(Json(BroadcastOut { txid }))
}

/// `GET /v1/tabs/{tab_id}/sweep`: sweep progress; advances `sweeping` to `closed`/`open`.
pub async fn status(
    State(state): State<AppState>,
    Path(tab_id): Path<Uuid>,
) -> Result<Json<SweepStatus>, WatcherError> {
    let tab = load_tab(&state, tab_id)?;
    Ok(Json(sweep::sweep_status(&state, &tab).await?))
}
