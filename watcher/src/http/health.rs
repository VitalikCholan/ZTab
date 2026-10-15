use super::AppState;
use axum::{extract::State, Json};
use std::sync::atomic::Ordering;
use time::OffsetDateTime;

/// Seconds since the last successful sync, `None` if there has never been one.
/// Clamped at zero so a backwards clock step never reports negative lag.
pub fn lag_seconds(last_ok: Option<OffsetDateTime>, now: OffsetDateTime) -> Option<i64> {
    last_ok.map(|t| (now - t).whole_seconds().max(0))
}

/// Unauthenticated liveness facts: heights, flags, lag and network only.
pub async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let o = Ordering::Relaxed;
    let last_ok = *state
        .health
        .last_ok_at
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    Json(serde_json::json!({
        "tip_height": state.health.tip_height.load(o),
        "synced_height": state.health.synced_height.load(o),
        "mempool_subscribed": state.health.mempool_subscribed.load(o),
        "lag_seconds": lag_seconds(last_ok, OffsetDateTime::now_utc()),
        "network": match state.cfg.network {
            zcash_protocol::consensus::Network::MainNetwork => "main",
            _ => "test",
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    #[test]
    fn lag_is_null_before_sync_and_clamped() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(lag_seconds(None, now), None);
        assert_eq!(
            lag_seconds(Some(now - Duration::seconds(42)), now),
            Some(42)
        );
        assert_eq!(lag_seconds(Some(now + Duration::seconds(5)), now), Some(0));
    }
}
