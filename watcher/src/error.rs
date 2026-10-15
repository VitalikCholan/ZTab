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
        tracing::warn!(error = %self, "request failed");
        (
            status,
            Json(serde_json::json!({ "error": self.to_string() })),
        )
            .into_response()
    }
}
