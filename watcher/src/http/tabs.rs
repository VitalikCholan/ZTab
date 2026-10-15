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
    if let Some(existing) = state.meta.get_tab(body.tab_id)? {
        if existing.ufvk != body.ufvk {
            return Err(WatcherError::Conflict(
                "tab_id already registered with a different ufvk".into(),
            ));
        }
        let account = crate::wallet::account_uuid(existing.account_uuid);
        let addresses = state
            .wallet
            .participant_addresses(account, existing.participants_count)?;
        return Ok(out(body.tab_id, addresses));
    }
    state.wallet.parse_ufvk(&body.ufvk)?;
    let mut client = state.client.lock().await;
    let (tip, _) = remote::latest_height(&mut client).await?;
    validate_register(&body, u32::from(tip))?;
    let account = state
        .wallet
        .import_tab_account(&mut client, body.tab_id, &body.ufvk, body.birthday)
        .await?;
    drop(client);
    state.meta.insert_tab(&TabRow {
        tab_id: body.tab_id,
        account_uuid: account.expose_uuid(),
        ufvk: body.ufvk.clone(),
        birthday: body.birthday,
        participants_count: body.participants_count,
        state: TabState::Open,
        created_at: time::OffsetDateTime::now_utc(),
    })?;
    let addresses = state
        .wallet
        .participant_addresses(account, body.participants_count)?;
    tracing::info!(tab = %body.tab_id, participants = body.participants_count, "tab registered");
    Ok(out(body.tab_id, addresses))
}

pub async fn get_tab(
    State(_state): State<AppState>,
    Path(_tab_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, WatcherError> {
    Err(WatcherError::NotFound("implemented in Task 6".into()))
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
