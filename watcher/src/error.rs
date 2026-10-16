use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

#[derive(Debug, thiserror::Error)]
pub enum WatcherError {
    #[error("config: {0}")]
    Config(String),
    #[error("wallet: {0}")]
    Wallet(String),
    #[error("remote: {0}")]
    Remote(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unprocessable: {0}")]
    Unprocessable(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl WatcherError {
    /// The variant name: safe to log at any level (carries no amounts, txids or addresses).
    pub fn kind(&self) -> &'static str {
        match self {
            WatcherError::Config(_) => "config",
            WatcherError::Wallet(_) => "wallet",
            WatcherError::Remote(_) => "remote",
            WatcherError::NotFound(_) => "not_found",
            WatcherError::Conflict(_) => "conflict",
            WatcherError::Unprocessable(_) => "unprocessable",
            WatcherError::Internal(_) => "internal",
        }
    }
}

impl IntoResponse for WatcherError {
    fn into_response(self) -> Response {
        let status = match &self {
            WatcherError::NotFound(_) => StatusCode::NOT_FOUND,
            WatcherError::Conflict(_) => StatusCode::CONFLICT,
            WatcherError::Unprocessable(_) | WatcherError::Config(_) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            WatcherError::Remote(_) => StatusCode::BAD_GATEWAY,
            WatcherError::Wallet(_) | WatcherError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        // The message can carry txids, heights or library detail: debug only.
        tracing::warn!(
            kind = self.kind(),
            status = status.as_u16(),
            "request failed"
        );
        tracing::debug!(error = %self, "request failure detail");
        // Server-side failures never reach the client in detail; client errors keep their
        // (fixed, library-free) explanation.
        let message = if status.is_server_error() {
            "internal".to_string()
        } else {
            self.to_string()
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(e: WatcherError) -> (StatusCode, String) {
        let r = e.into_response();
        let status = r.status();
        let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn server_errors_have_a_generic_body() {
        let generic = r#"{"error":"internal"}"#;
        let (status, b) = body(WatcherError::Wallet(
            "propose: InsufficientFunds { available: 12345 zat, required: 99 }".into(),
        ))
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(b, generic);
        assert!(!b.contains("12345"));
        let (status, b) = body(WatcherError::Remote(
            "send_transaction: rejected abcd".into(),
        ))
        .await;
        assert_eq!((status, b.as_str()), (StatusCode::BAD_GATEWAY, generic));
        let (status, b) = body(WatcherError::Internal(anyhow::anyhow!("boom 77 zat"))).await;
        assert_eq!(
            (status, b.as_str()),
            (StatusCode::INTERNAL_SERVER_ERROR, generic)
        );
    }

    #[tokio::test]
    async fn client_errors_keep_their_explanation() {
        let (status, b) = body(WatcherError::Conflict("tab state is closed".into())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(b, r#"{"error":"conflict: tab state is closed"}"#);
        let (status, _) = body(WatcherError::Unprocessable("recipient: x".into())).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}
