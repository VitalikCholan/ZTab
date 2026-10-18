use super::AppState;
use crate::{
    error::WatcherError,
    meta::{TabRow, TabState},
    remote,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct RegisterTab {
    pub tab_id: Uuid,
    pub ufvk: String,
    pub birthday: u32,
    pub participants_count: u32,
}

#[derive(Serialize)]
pub struct AddressOut {
    pub index: u32,
    pub address: String,
}

#[derive(Serialize)]
pub struct RegisterOut {
    pub tab_id: Uuid,
    pub addresses: Vec<AddressOut>,
}

pub fn validate_register(r: &RegisterTab, tip: u32) -> Result<(), WatcherError> {
    if r.participants_count == 0 || r.participants_count > 64 {
        return Err(WatcherError::Unprocessable(
            "participants_count must be 1..=64".into(),
        ));
    }
    if r.birthday.saturating_add(1000) < tip {
        return Err(WatcherError::Unprocessable(format!(
            "birthday {} is older than tip-1000 ({})",
            r.birthday,
            tip.saturating_sub(1000)
        )));
    }
    Ok(())
}

fn out(tab_id: Uuid, addresses: Vec<(u32, String)>) -> (StatusCode, Json<RegisterOut>) {
    (
        StatusCode::CREATED,
        Json(RegisterOut {
            tab_id,
            addresses: addresses
                .into_iter()
                .map(|(index, address)| AddressOut { index, address })
                .collect(),
        }),
    )
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterTab>,
) -> Result<(StatusCode, Json<RegisterOut>), WatcherError> {
    if let Some(resp) = existing_registration(&state, &body)? {
        return Ok(resp);
    }
    state.wallet.parse_ufvk(&body.ufvk)?;
    let mut client = state.client.lock().await;
    // The client lock serializes registrations: re-check now that we hold it.
    if let Some(resp) = existing_registration(&state, &body)? {
        return Ok(resp);
    }
    let (tip, _) = remote::latest_height(&mut client).await?;
    validate_register(&body, u32::from(tip))?;
    let account = state
        .wallet
        .import_tab_account(&mut client, body.tab_id, &body.ufvk, body.birthday)
        .await?;
    let tab = TabRow {
        tab_id: body.tab_id,
        account_uuid: account.expose_uuid(),
        ufvk: body.ufvk.clone(),
        birthday: body.birthday,
        participants_count: body.participants_count,
        state: TabState::Open,
        created_at: time::OffsetDateTime::now_utc(),
        active: true,
    };
    state.meta.insert_tab(&tab)?;
    drop(client);
    // Derived through the wallet (persisting them there) and stored in `tab_addresses`.
    let addresses = crate::facts::ensure_tab_addresses(&state.wallet, &state.meta, &tab)?;
    tracing::info!(tab = %body.tab_id, participants = body.participants_count, "tab registered");
    Ok(out(body.tab_id, addresses))
}

fn existing_registration(
    state: &AppState,
    body: &RegisterTab,
) -> Result<Option<(StatusCode, Json<RegisterOut>)>, WatcherError> {
    let Some(existing) = state.meta.get_tab(body.tab_id)? else {
        return Ok(None);
    };
    if existing.ufvk != body.ufvk {
        return Err(WatcherError::Conflict(
            "tab_id already registered with a different ufvk".into(),
        ));
    }
    let addresses = crate::facts::ensure_tab_addresses(&state.wallet, &state.meta, &existing)?;
    Ok(Some(out(body.tab_id, addresses)))
}

#[derive(Deserialize)]
pub struct SetActive {
    pub active: bool,
}

/// Pauses (`false`) or resumes (`true`) a tab. A paused tab is skipped by the mempool loop,
/// fact refresh and sweep advancement; its stored `state` is untouched.
pub async fn set_active(
    State(state): State<AppState>,
    Path(tab_id): Path<Uuid>,
    Json(body): Json<SetActive>,
) -> Result<StatusCode, WatcherError> {
    if !state.meta.set_active(tab_id, body.active)? {
        return Err(WatcherError::NotFound(format!("tab {tab_id}")));
    }
    tracing::info!(tab = %tab_id, active = body.active, "tab active flag set");
    Ok(StatusCode::NO_CONTENT)
}

/// Serves facts from the databases and health atomics only; never touches the lightwalletd
/// client, so it keeps answering while the upstream is unreachable.
pub async fn get_tab(
    State(state): State<AppState>,
    Path(tab_id): Path<Uuid>,
) -> Result<Json<crate::facts::TabFacts>, WatcherError> {
    use std::sync::atomic::Ordering::Relaxed;
    let tab = state
        .meta
        .get_tab(tab_id)?
        .ok_or_else(|| WatcherError::NotFound(format!("tab {tab_id}")))?;
    let tip = state.health.tip_height.load(Relaxed);
    let synced = state.health.synced_height.load(Relaxed);
    let last_ok = *state
        .health
        .last_ok_at
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let stale = last_ok.is_none_or(|t| {
        (time::OffsetDateTime::now_utc() - t).whole_seconds()
            > 3 * state.cfg.block_interval_seconds as i64
    });
    Ok(Json(crate::facts::tab_facts(
        &state.wallet,
        &state.meta,
        &state.cfg,
        &tab,
        tip,
        synced,
        stale,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_rejects_bad_counts() {
        assert!(validate_register(
            &RegisterTab {
                tab_id: uuid::Uuid::new_v4(),
                ufvk: "u".into(),
                birthday: 1,
                participants_count: 0
            },
            5000
        )
        .is_err());
        assert!(validate_register(
            &RegisterTab {
                tab_id: uuid::Uuid::new_v4(),
                ufvk: "u".into(),
                birthday: 1,
                participants_count: 65
            },
            5000
        )
        .is_err());
    }
    #[test]
    fn validate_rejects_old_birthday() {
        let r = RegisterTab {
            tab_id: uuid::Uuid::new_v4(),
            ufvk: "u".into(),
            birthday: 1000,
            participants_count: 2,
        };
        assert!(matches!(
            validate_register(&r, 5000),
            Err(WatcherError::Unprocessable(_))
        ));
        assert!(validate_register(
            &RegisterTab {
                birthday: 4500,
                ..r
            },
            5000
        )
        .is_ok());
    }
}
