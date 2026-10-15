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
