use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub listen: Option<String>,
    pub storage: Option<String>,
    pub upstream: Option<String>,
    pub server_id: Option<String>,
}

pub fn inspect_config(path: impl AsRef<Path>) -> Result<Value, ServerError> {
    let config: ServerConfig = serde_json::from_str(&fs::read_to_string(path)?)?;
    Ok(json!({
        "engine": "rust",
        "command": "server",
        "status": "config-ok",
        "listen": config.listen,
        "storage": config.storage,
        "upstream": config.upstream,
        "server_id": config.server_id
    }))
}

pub fn gateway_router(config: ServerConfig) -> Router {
    let state = GatewayState { server_id: config.server_id.unwrap_or_else(|| "fiber-mpp-rs".to_string()) };
    Router::new().fallback(any(move || gateway_402(state.clone())))
}

#[derive(Clone)]
struct GatewayState {
    server_id: String,
}

async fn gateway_402(state: GatewayState) -> Response {
    let mut response = (
        StatusCode::PAYMENT_REQUIRED,
        Json(json!({
            "engine": "rust",
            "type": "https://fiber-mpp.local/problems/payment-required",
            "title": "payment-required",
            "status": 402,
            "serverId": state.server_id
        })),
    )
        .into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn gateway_returns_visible_402() {
        let app = gateway_router(ServerConfig {
            listen: None,
            storage: None,
            upstream: None,
            server_id: Some("test-rust-server".to_string()),
        });
        let response = app.oneshot(Request::builder().uri("/paid").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(response.headers().get(header::CACHE_CONTROL), Some(&HeaderValue::from_static("no-store")));
    }
}
