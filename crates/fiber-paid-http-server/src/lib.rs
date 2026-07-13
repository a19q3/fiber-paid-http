use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use fiber_paid_http_core::{
    bind_challenge_id, body_digest, canonical_json, credential_hash, decode_authorization_header,
    decode_fiber_charge_request, encode_fiber_charge_request, encode_jcs_base64url, resource_hash,
    verify_challenge_id, www_authenticate_header, FiberChargeMethodDetails, FiberChargeRequest,
    FiberCredentialPayload, FiberUdtTypeScript, PaymentChallenge, PaymentCredential,
    PaymentReceipt,
};
use fiber_paid_http_fiber::{
    extract_invoice_payment_hash, wait_for_invoice_paid, FiberRpcClient, FiberRpcError,
};
use fiber_paid_http_fl402::{
    decode_fl402_capability, issue_fl402_capability, verify_fl402_proof, FL402_CAPABILITY_PREFIX,
};
use fiber_paid_http_storage::{ChallengeRecord, DeliveryOutcome, RedemptionRecord, SqliteStore};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    future::{Future, IntoFuture},
    net::SocketAddr,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::net::TcpListener;

const PAYMENT_RECEIPT_HEADER: &str = "payment-receipt";
const DEFAULT_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const DEFAULT_UPSTREAM_RESPONSE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS: u64 = 30_000;

type BoxGatewayFuture<T> = Pin<Box<dyn Future<Output = Result<T, ServerError>> + Send>>;

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("storage error: {0}")]
    Storage(#[from] fiber_paid_http_storage::StorageError),
    #[error("core error: {0}")]
    Core(#[from] fiber_paid_http_core::CoreError),
    #[error("fiber rpc error: {0}")]
    Fiber(#[from] fiber_paid_http_fiber::FiberRpcError),
    #[error("F-L402 error: {0}")]
    Fl402(#[from] fiber_paid_http_fl402::Fl402Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("request body too large")]
    PayloadTooLarge,
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("payment rejected: {0}")]
    Payment(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub listen: Option<String>,
    pub storage: Option<String>,
    pub upstream: Option<String>,
    pub server_id: Option<String>,
    pub realm: Option<String>,
    pub public_base_url: Option<String>,
    pub allow_insecure_http: Option<bool>,
    pub charge: Option<ChargeConfig>,
    pub secret_env: Option<String>,
    #[serde(default)]
    pub previous_secret_envs: Vec<String>,
    pub challenge_ttl_seconds: Option<i64>,
    pub operations: Option<OperationsConfig>,
    pub fiber: Option<FiberConfig>,
    pub fl402: Option<Fl402Config>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationsConfig {
    pub health_path: Option<String>,
    pub readiness_path: Option<String>,
    pub metrics_path: Option<String>,
    pub request_body_limit_bytes: Option<usize>,
    pub upstream_response_limit_bytes: Option<usize>,
    pub upstream_timeout_ms: Option<u64>,
    pub shutdown_grace_ms: Option<u64>,
    pub rate_limit: Option<RateLimitConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    pub window_ms: Option<u64>,
    pub max_requests: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChargeConfig {
    pub amount: String,
    pub currency: String,
    pub description: Option<String>,
    pub external_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiberConfig {
    pub mode: Option<String>,
    pub currency: Option<String>,
    pub rpc_url: Option<String>,
    pub payee_rpc_url: Option<String>,
    pub rpc_auth_env: Option<String>,
    pub payee_rpc_auth_env: Option<String>,
    pub payee_node_id: Option<String>,
    pub settlement_timeout_ms: Option<u64>,
    pub settlement_poll_ms: Option<u64>,
    pub hash_algorithm: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fl402Config {
    pub root_key_env: Option<String>,
    pub hash_algorithm: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub server_id: String,
    pub realm: String,
    pub public_base_url: String,
    pub upstream: String,
    pub charge: ChargeConfig,
    pub secret: String,
    pub previous_secrets: Vec<String>,
    pub storage_path: String,
    pub challenge_ttl_seconds: i64,
    pub body_limit_bytes: usize,
    pub upstream_response_limit_bytes: usize,
    pub upstream_timeout: Duration,
    pub shutdown_grace: Duration,
    pub health_path: String,
    pub readiness_path: String,
    pub metrics_path: String,
    pub rate_limit_window: Duration,
    pub rate_limit_max_requests: u64,
    pub fiber_mode: String,
    pub fl402: Option<Fl402GatewayConfig>,
}

#[derive(Debug, Clone)]
pub struct Fl402GatewayConfig {
    pub root_key: String,
    pub hash_algorithm: String,
}

#[derive(Clone)]
pub struct GatewayState {
    config: Arc<GatewayConfig>,
    store: Arc<Mutex<SqliteStore>>,
    fiber: Arc<dyn GatewayFiber>,
    upstream: Arc<dyn UpstreamClient>,
    runtime: Arc<Mutex<GatewayRuntime>>,
}

struct GatewayRuntime {
    started_at: DateTime<Utc>,
    requests_total: u64,
    responses_by_status: BTreeMap<u16, u64>,
    readiness_checks: u64,
    readiness_failures: u64,
    rate_limit_rejections: u64,
    rate_window_started: Instant,
    rate_window_requests: u64,
}

#[derive(Debug, Clone)]
pub struct FiberChargeInput {
    pub amount: String,
    pub currency: String,
    pub description: Option<String>,
    pub external_id: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone)]
pub struct UpstreamRequest {
    pub method: Method,
    pub uri: Uri,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct UpstreamResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

pub trait GatewayFiber: Send + Sync {
    fn create_charge(&self, input: FiberChargeInput) -> BoxGatewayFuture<FiberChargeRequest>;
    fn verify_paid(
        &self,
        request: FiberChargeRequest,
        payload: FiberCredentialPayload,
    ) -> BoxGatewayFuture<Value>;
    fn readiness(&self) -> BoxGatewayFuture<Value>;
}

pub trait UpstreamClient: Send + Sync {
    fn call(
        &self,
        request: UpstreamRequest,
        upstream_base: String,
    ) -> BoxGatewayFuture<UpstreamResponse>;
}

#[derive(Clone)]
pub struct RpcGatewayFiber {
    network: String,
    invoice_currency: String,
    node_id: Option<String>,
    hash_algorithm: String,
    settlement_timeout: Duration,
    settlement_poll: Duration,
    rpc: FiberRpcClient,
}

impl RpcGatewayFiber {
    pub fn from_config(config: &FiberConfig) -> Result<Self, ServerError> {
        let mode = required_option(&config.mode, "fiber.mode")?;
        if mode != "local" && mode != "testnet" {
            return Err(config_error("fiber.mode must be local or testnet"));
        }
        let url = config
            .payee_rpc_url
            .clone()
            .or_else(|| config.rpc_url.clone())
            .ok_or_else(|| config_error("fiber.payee_rpc_url or fiber.rpc_url is required"))?;
        let auth = config
            .payee_rpc_auth_env
            .as_ref()
            .or(config.rpc_auth_env.as_ref())
            .map(|name| std::env::var(name).map_err(|_| config_error(format!("set {name}"))))
            .transpose()?;
        let timeout_ms = config.settlement_timeout_ms.unwrap_or(30_000);
        let poll_ms = config.settlement_poll_ms.unwrap_or(500);
        if timeout_ms == 0 || poll_ms == 0 || poll_ms > timeout_ms {
            return Err(config_error(
                "Fiber settlement polling must satisfy 0 < poll <= timeout",
            ));
        }
        let hash_algorithm = config
            .hash_algorithm
            .clone()
            .unwrap_or_else(|| "ckb_hash".to_string());
        if !matches!(hash_algorithm.as_str(), "ckb_hash" | "sha256") {
            return Err(config_error(
                "fiber.hash_algorithm must be ckb_hash or sha256",
            ));
        }
        Ok(Self {
            network: if mode == "testnet" { "testnet" } else { "dev" }.to_string(),
            invoice_currency: config.currency.clone().unwrap_or_else(|| {
                if mode == "testnet" {
                    "Fibt".to_string()
                } else {
                    "Fibd".to_string()
                }
            }),
            node_id: config.payee_node_id.clone(),
            hash_algorithm,
            settlement_timeout: Duration::from_millis(timeout_ms),
            settlement_poll: Duration::from_millis(poll_ms),
            rpc: FiberRpcClient::new(url, auth),
        })
    }
}

impl GatewayFiber for RpcGatewayFiber {
    fn create_charge(&self, input: FiberChargeInput) -> BoxGatewayFuture<FiberChargeRequest> {
        let rpc = self.rpc.clone();
        let network = self.network.clone();
        let invoice_currency = self.invoice_currency.clone();
        let recipient = self.node_id.clone();
        let hash_algorithm = self.hash_algorithm.clone();
        Box::pin(async move {
            let invoice_result = rpc
                .new_invoice(
                    &input.amount,
                    &invoice_currency,
                    Some(expiry_seconds_from_now(&input.expires_at)),
                    Some(&hash_algorithm),
                )
                .await?;
            let invoice = invoice_result
                .get("invoice_address")
                .and_then(Value::as_str)
                .ok_or_else(|| config_error("new_invoice result missing invoice_address"))?
                .to_string();
            let payment_hash = extract_invoice_payment_hash(&invoice_result)?;
            let metadata = validate_invoice_record(
                &invoice_result,
                Some(&invoice),
                &payment_hash,
                &input.amount,
                &invoice_currency,
                &network,
                &hash_algorithm,
                None,
                None,
                true,
            )?;
            let mut method_extensions = BTreeMap::new();
            method_extensions.insert(
                "invoiceCurrency".to_string(),
                Value::String(invoice_currency.clone()),
            );
            method_extensions.insert(
                "invoiceExpiresAt".to_string(),
                Value::String(metadata.expires_at),
            );
            if let Some(udt_script) = metadata.udt_script {
                method_extensions.insert("invoiceUdtScript".to_string(), Value::String(udt_script));
            }
            Ok(FiberChargeRequest {
                amount: input.amount,
                currency: input.currency,
                recipient,
                description: input.description,
                external_id: input.external_id,
                method_details: FiberChargeMethodDetails {
                    invoice,
                    payment_hash,
                    network,
                    hash_algorithm,
                    udt_type_script: None,
                    extensions: method_extensions,
                },
                extensions: BTreeMap::new(),
            })
        })
    }

    fn verify_paid(
        &self,
        request: FiberChargeRequest,
        payload: FiberCredentialPayload,
    ) -> BoxGatewayFuture<Value> {
        let rpc = self.rpc.clone();
        let timeout = self.settlement_timeout;
        let poll = self.settlement_poll;
        let invoice_currency = self.invoice_currency.clone();
        Box::pin(async move {
            if payload.payment_hash != request.method_details.payment_hash {
                return Err(payment_error("wrong-payment-hash"));
            }
            let invoice =
                match wait_for_invoice_paid(&rpc, &payload.payment_hash, timeout, poll).await {
                    Ok(invoice) => invoice,
                    Err(FiberRpcError::InvoiceTerminal(_)) => {
                        return Err(payment_error("fiber-invoice-not-payable"));
                    }
                    Err(error) => return Err(error.into()),
                };
            let expected_currency = request
                .method_details
                .extensions
                .get("invoiceCurrency")
                .and_then(Value::as_str)
                .ok_or_else(|| payment_error("missing-invoice-currency-binding"))?;
            if expected_currency != invoice_currency {
                return Err(payment_error("wrong-currency"));
            }
            let expected_expiry = request
                .method_details
                .extensions
                .get("invoiceExpiresAt")
                .and_then(Value::as_str)
                .ok_or_else(|| payment_error("missing-invoice-expiry-binding"))?;
            let expected_udt_script = request
                .method_details
                .extensions
                .get("invoiceUdtScript")
                .and_then(Value::as_str);
            validate_invoice_record(
                &invoice,
                Some(&request.method_details.invoice),
                &request.method_details.payment_hash,
                &request.amount,
                expected_currency,
                &request.method_details.network,
                &request.method_details.hash_algorithm,
                request.method_details.udt_type_script.as_ref(),
                Some((expected_expiry, expected_udt_script)),
                false,
            )?;
            Ok(json!({
                "status": "settled",
                "paymentHash": payload.payment_hash,
                "invoiceStatus": invoice.get("status"),
                "observedAt": now_string()
            }))
        })
    }

    fn readiness(&self) -> BoxGatewayFuture<Value> {
        let rpc = self.rpc.clone();
        Box::pin(async move {
            let node = rpc.request("node_info", vec![]).await?;
            let peers = rpc.request("list_peers", vec![]).await?;
            let channels = rpc.request("list_channels", vec![json!({})]).await?;
            let peer_count = named_array(&peers, "peers").len();
            let channel_values = named_array(&channels, "channels");
            let ready_channels = channel_values
                .iter()
                .filter(|channel| channel_state_name(channel).is_some_and(is_ready_channel_state))
                .count();
            if peer_count == 0 || ready_channels == 0 {
                return Err(config_error(
                    "Fiber node readiness requires at least one peer and one ready channel",
                ));
            }
            Ok(json!({
                "node": node,
                "peerCount": peer_count,
                "readyChannels": ready_channels
            }))
        })
    }
}

#[derive(Clone)]
pub struct ReqwestUpstreamClient {
    client: reqwest::Client,
    response_limit_bytes: usize,
}

impl UpstreamClient for ReqwestUpstreamClient {
    fn call(
        &self,
        request: UpstreamRequest,
        upstream_base: String,
    ) -> BoxGatewayFuture<UpstreamResponse> {
        let client = self.client.clone();
        let response_limit_bytes = self.response_limit_bytes;
        Box::pin(async move {
            let target = upstream_url(&upstream_base, &request.uri)?;
            let mut builder = client.request(request.method, target);
            for (name, value) in &request.headers {
                if forwardable_header(name, &request.headers) {
                    builder = builder.header(name, value);
                }
            }
            let mut response = builder.body(request.body).send().await?;
            let status = response.status();
            let headers = response.headers().clone();
            if response
                .content_length()
                .is_some_and(|length| length > response_limit_bytes as u64)
            {
                return Err(upstream_error("response exceeds configured limit"));
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if body.len().saturating_add(chunk.len()) > response_limit_bytes {
                    return Err(upstream_error("response exceeds configured limit"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(UpstreamResponse {
                status,
                headers,
                body,
            })
        })
    }
}

impl ReqwestUpstreamClient {
    fn new(timeout: Duration, response_limit_bytes: usize) -> Result<Self, ServerError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            response_limit_bytes,
        })
    }
}

pub fn inspect_config(path: impl AsRef<Path>) -> Result<Value, ServerError> {
    let config: ServerConfig = serde_json::from_str(&fs::read_to_string(path)?)?;
    resolve_gateway_config(&config)?;
    Ok(json!({
        "engine": "rust",
        "command": "server",
        "status": "config-ok",
        "productionGateway": true,
        "protocol": "MPP",
        "trustedVerifier": "rust",
        "fl402Enabled": config.fl402.is_some()
    }))
}

pub fn gateway_router(config: ServerConfig) -> Result<Router, ServerError> {
    Ok(gateway_router_with_state(GatewayState::from_config(
        config,
    )?))
}

pub fn gateway_router_with_state(state: GatewayState) -> Router {
    Router::new()
        .fallback(any(gateway_handler))
        .with_state(state)
}

pub async fn serve_config(path: impl AsRef<Path>) -> Result<(), ServerError> {
    let config: ServerConfig = serde_json::from_str(&fs::read_to_string(path)?)?;
    let listen = config
        .listen
        .clone()
        .unwrap_or_else(|| "127.0.0.1:8790".to_string());
    let address: SocketAddr = listen
        .parse()
        .map_err(|_| config_error(format!("invalid listen address {listen}")))?;
    let state = GatewayState::from_config(config)?;
    let shutdown_grace = state.config.shutdown_grace;
    let listener = TcpListener::bind(address).await?;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let mut deadline_rx = shutdown_rx.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(true);
    });
    let server = axum::serve(listener, gateway_router_with_state(state))
        .with_graceful_shutdown(async move {
            wait_for_shutdown(&mut shutdown_rx).await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result?,
        _ = wait_for_shutdown(&mut deadline_rx) => {
            match tokio::time::timeout(shutdown_grace, &mut server).await {
                Ok(result) => result?,
                Err(_) => {
                    eprintln!("Fiber Paid HTTP shutdown grace elapsed; closing remaining connections");
                }
            }
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut signal) => {
                    signal.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn wait_for_shutdown(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    if !*receiver.borrow() {
        let _ = receiver.changed().await;
    }
}

impl GatewayState {
    pub fn from_config(config: ServerConfig) -> Result<Self, ServerError> {
        let resolved = resolve_gateway_config(&config)?;
        let store = SqliteStore::open(&resolved.storage_path)?;
        let fiber = RpcGatewayFiber::from_config(
            config
                .fiber
                .as_ref()
                .ok_or_else(|| config_error("fiber config is required"))?,
        )?;
        let upstream = ReqwestUpstreamClient::new(
            resolved.upstream_timeout,
            resolved.upstream_response_limit_bytes,
        )?;
        Ok(Self {
            config: Arc::new(resolved),
            store: Arc::new(Mutex::new(store)),
            fiber: Arc::new(fiber),
            upstream: Arc::new(upstream),
            runtime: Arc::new(Mutex::new(new_gateway_runtime())),
        })
    }

    pub fn for_test(
        config: GatewayConfig,
        store: SqliteStore,
        fiber: Arc<dyn GatewayFiber>,
        upstream: Arc<dyn UpstreamClient>,
    ) -> Self {
        Self {
            config: Arc::new(config),
            store: Arc::new(Mutex::new(store)),
            fiber,
            upstream,
            runtime: Arc::new(Mutex::new(new_gateway_runtime())),
        }
    }
}

async fn gateway_handler(State(state): State<GatewayState>, request: Request<Body>) -> Response {
    let response = match handle_gateway_request(state.clone(), request).await {
        Ok(response) => response,
        Err(error) => error_response(error),
    };
    record_response(&state, response.status());
    response
}

async fn handle_gateway_request(
    state: GatewayState,
    request: Request<Body>,
) -> Result<Response, ServerError> {
    let (parts, body) = request.into_parts();
    if parts.method == Method::GET && parts.uri.path() == state.config.health_path {
        return Ok(no_store(
            Json(json!({
                "status": "ok",
                "service": "fiber-paid-http-rs",
                "serverId": state.config.server_id.clone(),
                "startedAt": runtime_started_at(&state)?
            }))
            .into_response(),
        ));
    }
    if parts.method == Method::GET && parts.uri.path() == state.config.readiness_path {
        return readiness_response(&state).await;
    }
    if parts.method == Method::GET && parts.uri.path() == state.config.metrics_path {
        return metrics_response(&state);
    }
    if let Some(retry_after) = rate_limit_retry_after(&state)? {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "type": "https://paymentauth.org/problems/rate-limit-exceeded",
                "title": "rate-limit-exceeded",
                "status": 429,
                "detail": "Too many gateway requests"
            })),
        )
            .into_response();
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header_value(&retry_after.to_string())?);
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(response);
    }
    let body = to_bytes(body, state.config.body_limit_bytes)
        .await
        .map_err(|_| ServerError::PayloadTooLarge)?
        .to_vec();
    let resource = resource_descriptor(
        &state.config,
        &parts.method,
        &parts.uri,
        &parts.headers,
        &body,
    )?;
    let authorization = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let credential = match credential_from_authorization(&state, authorization) {
        Ok(Some(credential)) => credential,
        Ok(None)
        | Err(ServerError::Payment(_))
        | Err(ServerError::Fl402(_))
        | Err(ServerError::Core(_)) => {
            return issue_challenge(&state, &resource).await;
        }
        Err(error) => return Err(error),
    };
    let redemption = match verify_credential(&state, &resource, credential).await {
        Ok(redemption) => redemption,
        Err(ServerError::Payment(_)) | Err(ServerError::Core(_)) => {
            return issue_challenge(&state, &resource).await;
        }
        Err(error) => return Err(error),
    };

    let upstream = state
        .upstream
        .call(
            UpstreamRequest {
                method: parts.method,
                uri: parts.uri,
                headers: parts.headers,
                body,
            },
            state.config.upstream.clone(),
        )
        .await;
    match upstream {
        Ok(upstream) => finish_upstream(&state, redemption, upstream),
        Err(error) => {
            save_delivery(
                &state,
                &redemption,
                "failed",
                None,
                None,
                Some("upstream-error"),
                Some("upstream request failed"),
            )?;
            Err(error)
        }
    }
}

fn new_gateway_runtime() -> GatewayRuntime {
    GatewayRuntime {
        started_at: Utc::now(),
        requests_total: 0,
        responses_by_status: BTreeMap::new(),
        readiness_checks: 0,
        readiness_failures: 0,
        rate_limit_rejections: 0,
        rate_window_started: Instant::now(),
        rate_window_requests: 0,
    }
}

fn runtime_started_at(state: &GatewayState) -> Result<String, ServerError> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| config_error("runtime lock poisoned"))?;
    Ok(runtime
        .started_at
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn record_response(state: &GatewayState, status: StatusCode) {
    if let Ok(mut runtime) = state.runtime.lock() {
        runtime.requests_total = runtime.requests_total.saturating_add(1);
        let count = runtime
            .responses_by_status
            .entry(status.as_u16())
            .or_default();
        *count = count.saturating_add(1);
    }
}

fn rate_limit_retry_after(state: &GatewayState) -> Result<Option<u64>, ServerError> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| config_error("runtime lock poisoned"))?;
    let elapsed = runtime.rate_window_started.elapsed();
    if elapsed >= state.config.rate_limit_window {
        runtime.rate_window_started = Instant::now();
        runtime.rate_window_requests = 0;
    }
    if runtime.rate_window_requests >= state.config.rate_limit_max_requests {
        runtime.rate_limit_rejections = runtime.rate_limit_rejections.saturating_add(1);
        let remaining = state.config.rate_limit_window.saturating_sub(elapsed);
        return Ok(Some(remaining.as_secs().max(1)));
    }
    runtime.rate_window_requests = runtime.rate_window_requests.saturating_add(1);
    Ok(None)
}

async fn readiness_response(state: &GatewayState) -> Result<Response, ServerError> {
    {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| config_error("runtime lock poisoned"))?;
        runtime.readiness_checks = runtime.readiness_checks.saturating_add(1);
    }
    let storage_ready = lock_store(state)?.readiness()?;
    let fiber_ready = state.fiber.readiness().await.is_ok();
    let ready = storage_ready && fiber_ready;
    if !ready {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| config_error("runtime lock poisoned"))?;
        runtime.readiness_failures = runtime.readiness_failures.saturating_add(1);
    }
    Ok(no_store(
        (
            if ready {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            Json(json!({
                "status": if ready { "ready" } else { "blocked" },
                "storage": if storage_ready { "ready" } else { "blocked" },
                "fiber": if fiber_ready { "ready" } else { "blocked" }
            })),
        )
            .into_response(),
    ))
}

fn metrics_response(state: &GatewayState) -> Result<Response, ServerError> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| config_error("runtime lock poisoned"))?;
    let server_id = prometheus_label(&state.config.server_id);
    let mut lines = vec![
        "# HELP fiber_paid_http_gateway_requests_total Total gateway requests.".to_string(),
        "# TYPE fiber_paid_http_gateway_requests_total counter".to_string(),
        format!(
            "fiber_paid_http_gateway_requests_total{{server_id=\"{server_id}\"}} {}",
            runtime.requests_total
        ),
        "# HELP fiber_paid_http_gateway_readiness_checks_total Total readiness checks.".to_string(),
        "# TYPE fiber_paid_http_gateway_readiness_checks_total counter".to_string(),
        format!(
            "fiber_paid_http_gateway_readiness_checks_total{{server_id=\"{server_id}\"}} {}",
            runtime.readiness_checks
        ),
        "# HELP fiber_paid_http_gateway_readiness_failures_total Total failed readiness checks."
            .to_string(),
        "# TYPE fiber_paid_http_gateway_readiness_failures_total counter".to_string(),
        format!(
            "fiber_paid_http_gateway_readiness_failures_total{{server_id=\"{server_id}\"}} {}",
            runtime.readiness_failures
        ),
        "# HELP fiber_paid_http_gateway_rate_limit_rejections_total Total rate-limit rejections."
            .to_string(),
        "# TYPE fiber_paid_http_gateway_rate_limit_rejections_total counter".to_string(),
        format!(
            "fiber_paid_http_gateway_rate_limit_rejections_total{{server_id=\"{server_id}\"}} {}",
            runtime.rate_limit_rejections
        ),
        "# HELP fiber_paid_http_gateway_responses_total Total gateway responses by status."
            .to_string(),
        "# TYPE fiber_paid_http_gateway_responses_total counter".to_string(),
    ];
    for (status, count) in &runtime.responses_by_status {
        lines.push(format!(
            "fiber_paid_http_gateway_responses_total{{server_id=\"{server_id}\",status=\"{status}\"}} {count}"
        ));
    }
    let mut response = Response::new(Body::from(format!("{}\n", lines.join("\n"))));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    Ok(no_store(response))
}

fn prometheus_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn named_array<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .as_array()
        .or_else(|| value.get(field).and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn is_ready_channel_state(value: &str) -> bool {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .eq_ignore_ascii_case("channelready")
}

fn channel_state_name(value: &Value) -> Option<&str> {
    value
        .get("state")
        .and_then(|state| {
            state.as_str().or_else(|| {
                state
                    .as_object()
                    .and_then(|object| object.get("state_name"))
                    .and_then(Value::as_str)
            })
        })
        .or_else(|| value.get("state_name").and_then(Value::as_str))
}

fn forwardable_header(name: &HeaderName, headers: &HeaderMap) -> bool {
    name != header::AUTHORIZATION
        && name != header::HOST
        && name != header::CONTENT_LENGTH
        && name.as_str() != PAYMENT_RECEIPT_HEADER
        && !hop_by_hop_header(name)
        && !connection_nominates(headers, name)
}

fn response_header_allowed(name: &HeaderName, headers: &HeaderMap) -> bool {
    name != header::CONTENT_LENGTH
        && name.as_str() != PAYMENT_RECEIPT_HEADER
        && !hop_by_hop_header(name)
        && !connection_nominates(headers, name)
}

fn connection_nominates(headers: &HeaderMap, name: &HeaderName) -> bool {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| candidate.eq_ignore_ascii_case(name.as_str()))
}

fn hop_by_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[derive(Debug)]
struct VerifiedRedemption {
    challenge_id: String,
    credential_hash: String,
    payment_hash: String,
    settlement: Value,
}

async fn issue_challenge(state: &GatewayState, resource: &Value) -> Result<Response, ServerError> {
    let now = Utc::now();
    let expires = now + ChronoDuration::seconds(state.config.challenge_ttl_seconds);
    let expires_at = expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let charge_request = state
        .fiber
        .create_charge(FiberChargeInput {
            amount: state.config.charge.amount.clone(),
            currency: state.config.charge.currency.clone(),
            description: state.config.charge.description.clone(),
            external_id: state.config.charge.external_id.clone(),
            expires_at: expires_at.clone(),
        })
        .await?;
    let mut challenge = PaymentChallenge {
        id: String::new(),
        realm: state.config.realm.clone(),
        method: "fiber".to_string(),
        intent: "charge".to_string(),
        request: encode_fiber_charge_request(&charge_request)?,
        expires: Some(expires_at.clone()),
        digest: resource
            .get("digest")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        description: state.config.charge.description.clone(),
        opaque: Some(encode_jcs_base64url(&serde_json::json!({
            "serverId": state.config.server_id
        }))?),
        extensions: BTreeMap::new(),
    };
    challenge.id = bind_challenge_id(&challenge, &state.config.secret)?;
    let challenge_value = serde_json::to_value(&challenge)?;
    {
        let store = lock_store(state)?;
        store.save_challenge(
            &challenge.id,
            &ChallengeRecord {
                challenge: challenge_value,
                charge_request: serde_json::to_value(&charge_request)?,
                resource_binding: resource.clone(),
                created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                expires_at,
            },
        )?;
    }
    let mut response = (
        StatusCode::PAYMENT_REQUIRED,
        Json(json!({
            "type": "https://paymentauth.org/problems/payment-required",
            "title": "Payment Required",
            "status": 402,
            "detail": "Payment is required."
        })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().append(
        header::WWW_AUTHENTICATE,
        header_value(&www_authenticate_header(&challenge)?)?,
    );
    if let Some(fl402) = &state.config.fl402 {
        let challenge_header = issue_fl402_challenge(fl402, &challenge, &charge_request, resource)?;
        response
            .headers_mut()
            .append(header::WWW_AUTHENTICATE, header_value(&challenge_header)?);
    }
    Ok(response)
}

fn credential_from_authorization(
    state: &GatewayState,
    authorization: Option<&str>,
) -> Result<Option<PaymentCredential>, ServerError> {
    let Some(header) = authorization else {
        return Ok(None);
    };
    let Some((scheme, token)) = header.trim().split_once(char::is_whitespace) else {
        return Ok(None);
    };
    let token = token.trim_start();
    if scheme.eq_ignore_ascii_case("Payment") {
        return Ok(Some(decode_authorization_header(header)?));
    }
    if !scheme.eq_ignore_ascii_case("L402") {
        return Ok(None);
    }
    let fl402 = state
        .config
        .fl402
        .as_ref()
        .ok_or_else(|| payment_error("fl402-disabled"))?;
    let (capability, preimage) = token
        .rsplit_once(':')
        .ok_or_else(|| payment_error("invalid-fl402-proof"))?;
    let (payload, _) = decode_fl402_capability(capability)?;
    let caveats = payload
        .get("caveats")
        .ok_or_else(|| payment_error("invalid-fl402-capability"))?;
    let challenge_id = required_string(caveats, "challengeId")?;
    let record = lock_store(state)?
        .get_challenge(&challenge_id)?
        .ok_or_else(|| payment_error("unknown-challenge"))?;
    let challenge: PaymentChallenge = serde_json::from_value(record.challenge)?;
    let payment_hash = required_string(caveats, "paymentHash")?;
    let proof = json!({
        "capability": capability,
        "preimage": preimage,
        "paymentHash": payment_hash,
        "hashAlgorithm": required_string(caveats, "hashAlgorithm")?
    });
    let mut compatibility_challenge = json!({
        "challengeId": challenge.id,
        "capability": capability,
        "paymentHash": payment_hash,
        "resourceHash": required_string(caveats, "resourceHash")?,
        "resource": required_string(caveats, "url")?,
        "invoice": required_string(caveats, "invoice")?,
        "amount": required_string(caveats, "amount")?,
        "currency": required_string(caveats, "currency")?,
        "expiresAt": required_string(caveats, "expiresAt")?,
        "issuer": required_string(caveats, "issuer")?,
        "network": required_string(caveats, "network")?,
        "hashAlgorithm": required_string(caveats, "hashAlgorithm")?
    });
    if let Some(fiber_node_id) = caveats.get("fiberNodeId").and_then(Value::as_str) {
        compatibility_challenge["fiberNodeId"] = Value::String(fiber_node_id.to_string());
    }
    verify_fl402_proof(&compatibility_challenge, &proof, &fl402.root_key, None)?;
    Ok(Some(PaymentCredential {
        challenge,
        source: Some("l402".to_string()),
        payload: FiberCredentialPayload {
            payment_hash,
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    }))
}

async fn verify_credential(
    state: &GatewayState,
    resource: &Value,
    credential: PaymentCredential,
) -> Result<VerifiedRedemption, ServerError> {
    let record = lock_store(state)?
        .get_challenge(&credential.challenge.id)?
        .ok_or_else(|| payment_error("unknown-challenge"))?;
    let issued: PaymentChallenge = serde_json::from_value(record.challenge)?;
    if credential.challenge != issued {
        return Err(payment_error("invalid-challenge"));
    }
    let mut secrets = vec![state.config.secret.clone()];
    secrets.extend(state.config.previous_secrets.clone());
    if !verify_challenge_id(&issued, &secrets) {
        return Err(payment_error("invalid-challenge-binding"));
    }
    assert_not_expired(&issued)?;
    if canonical_json(resource)? != canonical_json(&record.resource_binding)? {
        return Err(payment_error("wrong-resource"));
    }
    let charge = decode_fiber_charge_request(&issued.request)?;
    if canonical_json(&serde_json::to_value(&charge)?)? != canonical_json(&record.charge_request)? {
        return Err(payment_error("invalid-charge-request"));
    }
    if credential.payload.payment_hash != charge.method_details.payment_hash {
        return Err(payment_error("wrong-payment-hash"));
    }
    let hash = credential_hash(&credential)?;
    let settlement = state
        .fiber
        .verify_paid(charge, credential.payload.clone())
        .await?;
    let redemption = RedemptionRecord {
        challenge_id: issued.id.clone(),
        credential_hash: hash.clone(),
        payment_hash: credential.payload.payment_hash.clone(),
        settlement: settlement.clone(),
        consumed_at: now_string(),
    };
    if !lock_store_mut(state)?.consume_redemption(&redemption)? {
        return Err(payment_error("replay"));
    }
    Ok(VerifiedRedemption {
        challenge_id: issued.id,
        credential_hash: hash,
        payment_hash: credential.payload.payment_hash,
        settlement,
    })
}

fn finish_upstream(
    state: &GatewayState,
    redemption: VerifiedRedemption,
    upstream: UpstreamResponse,
) -> Result<Response, ServerError> {
    let delivered = upstream.status.is_success();
    let receipt = delivered.then(|| PaymentReceipt {
        status: "success".to_string(),
        method: "fiber".to_string(),
        timestamp: redemption
            .settlement
            .get("observedAt")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(now_string),
        reference: redemption.payment_hash.clone(),
        challenge_id: redemption.challenge_id.clone(),
        extensions: BTreeMap::new(),
    });
    save_delivery(
        state,
        &redemption,
        if delivered { "delivered" } else { "failed" },
        Some(i64::from(upstream.status.as_u16())),
        receipt.as_ref().map(|value| value.reference.as_str()),
        (!delivered).then_some("upstream-non-success"),
        None,
    )?;
    if let Some(receipt) = &receipt {
        lock_store(state)?.save_receipt(&serde_json::to_value(receipt)?)?;
    }
    let mut response = Response::new(Body::from(upstream.body));
    *response.status_mut() = upstream.status;
    for (name, value) in &upstream.headers {
        if response_header_allowed(name, &upstream.headers) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    if let Some(receipt) = receipt {
        response.headers_mut().insert(
            HeaderName::from_static(PAYMENT_RECEIPT_HEADER),
            header_value(&encode_jcs_base64url(&receipt)?)?,
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("private"));
    }
    Ok(response)
}

fn save_delivery(
    state: &GatewayState,
    redemption: &VerifiedRedemption,
    status: &str,
    response_status: Option<i64>,
    receipt_reference: Option<&str>,
    error_code: Option<&str>,
    error_message: Option<&str>,
) -> Result<(), ServerError> {
    lock_store(state)?.save_delivery_outcome(&DeliveryOutcome {
        challenge_id: redemption.challenge_id.clone(),
        credential_hash: redemption.credential_hash.clone(),
        payment_hash: redemption.payment_hash.clone(),
        receipt_reference: receipt_reference.map(ToString::to_string),
        status: status.to_string(),
        response_status,
        error_code: error_code.map(ToString::to_string),
        error_message: error_message.map(ToString::to_string),
        recorded_at: now_string(),
    })?;
    Ok(())
}

fn issue_fl402_challenge(
    config: &Fl402GatewayConfig,
    challenge: &PaymentChallenge,
    charge: &FiberChargeRequest,
    resource: &Value,
) -> Result<String, ServerError> {
    let mut caveats = json!({
        "challengeId": challenge.id,
        "resourceHash": resource_hash(resource)?,
        "method": required_string(resource, "method")?,
        "url": required_string(resource, "url")?,
        "paymentHash": charge.method_details.payment_hash,
        "invoice": charge.method_details.invoice,
        "amount": charge.amount,
        "currency": charge.currency,
        "expiresAt": challenge.expires,
        "hashAlgorithm": config.hash_algorithm,
        "issuer": challenge.realm,
        "network": charge.method_details.network
    });
    if let Some(fiber_node_id) = &charge.recipient {
        caveats["fiberNodeId"] = Value::String(fiber_node_id.clone());
    }
    let payload = json!({
        "domain": FL402_CAPABILITY_PREFIX,
        "caveats": caveats,
        "nonce": random_hex(16),
        "issuedAt": now_string()
    });
    let capability = issue_fl402_capability(&payload, &config.root_key)?;
    Ok(format!(
        "L402 capability=\"{}\", invoice=\"{}\", payment_hash=\"{}\", amount=\"{}\", currency=\"{}\"",
        escape_quoted(&capability),
        escape_quoted(&charge.method_details.invoice),
        escape_quoted(&charge.method_details.payment_hash),
        escape_quoted(&charge.amount),
        escape_quoted(&charge.currency)
    ))
}

fn resolve_gateway_config(config: &ServerConfig) -> Result<GatewayConfig, ServerError> {
    let secret_env = config
        .secret_env
        .clone()
        .unwrap_or_else(|| "FIBER_PAID_HTTP_SECRET".to_string());
    let secret =
        std::env::var(&secret_env).map_err(|_| config_error(format!("set {secret_env}")))?;
    if secret.len() < 32 {
        return Err(config_error(format!(
            "{secret_env} must be at least 32 characters"
        )));
    }
    let realm = required_option(&config.realm, "realm")?;
    let public_base_url = required_option(&config.public_base_url, "public_base_url")?;
    let parsed_public = reqwest::Url::parse(&public_base_url)
        .map_err(|_| config_error("public_base_url must be an absolute URL"))?;
    if !parsed_public.username().is_empty()
        || parsed_public.password().is_some()
        || parsed_public.query().is_some()
        || parsed_public.fragment().is_some()
        || parsed_public.path() != "/"
    {
        return Err(config_error(
            "public_base_url must be an origin without credentials, path, query, or fragment",
        ));
    }
    let loopback = matches!(
        parsed_public.host_str(),
        Some("localhost" | "127.0.0.1" | "::1")
    );
    if parsed_public.scheme() != "https"
        && !(parsed_public.scheme() == "http"
            && loopback
            && config.allow_insecure_http == Some(true))
    {
        return Err(config_error(
            "public_base_url must use https; loopback http must be explicitly enabled",
        ));
    }
    let charge = config
        .charge
        .clone()
        .ok_or_else(|| config_error("charge is required"))?;
    if charge.amount.is_empty()
        || charge.amount.starts_with('0')
        || !charge.amount.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(config_error(
            "charge.amount must be a positive integer in the currency's smallest unit",
        ));
    }
    if charge.currency.trim().is_empty() {
        return Err(config_error("charge.currency is required"));
    }
    let challenge_ttl_seconds = config.challenge_ttl_seconds.unwrap_or(120);
    if challenge_ttl_seconds <= 0 {
        return Err(config_error("challenge_ttl_seconds must be positive"));
    }
    let upstream = required_option(&config.upstream, "upstream")?;
    let parsed_upstream = reqwest::Url::parse(&upstream)
        .map_err(|_| config_error("upstream must be an absolute URL"))?;
    if !matches!(parsed_upstream.scheme(), "http" | "https")
        || !parsed_upstream.username().is_empty()
        || parsed_upstream.password().is_some()
        || parsed_upstream.path() != "/"
        || parsed_upstream.query().is_some()
        || parsed_upstream.fragment().is_some()
    {
        return Err(config_error(
            "upstream must be an HTTP(S) origin without credentials, path, query, or fragment",
        ));
    }
    let operations = config.operations.clone().unwrap_or(OperationsConfig {
        health_path: None,
        readiness_path: None,
        metrics_path: None,
        request_body_limit_bytes: None,
        upstream_response_limit_bytes: None,
        upstream_timeout_ms: None,
        shutdown_grace_ms: None,
        rate_limit: None,
    });
    let health_path = operations
        .health_path
        .unwrap_or_else(|| "/healthz".to_string());
    let readiness_path = operations
        .readiness_path
        .unwrap_or_else(|| "/readyz".to_string());
    let metrics_path = operations
        .metrics_path
        .unwrap_or_else(|| "/metrics".to_string());
    if [&health_path, &readiness_path, &metrics_path]
        .iter()
        .any(|path| !valid_operations_path(path))
        || health_path == readiness_path
        || health_path == metrics_path
        || readiness_path == metrics_path
    {
        return Err(config_error(
            "operation paths must be distinct absolute paths without query or fragment",
        ));
    }
    let body_limit_bytes = operations
        .request_body_limit_bytes
        .unwrap_or(DEFAULT_BODY_LIMIT_BYTES);
    let upstream_response_limit_bytes = operations
        .upstream_response_limit_bytes
        .unwrap_or(DEFAULT_UPSTREAM_RESPONSE_LIMIT_BYTES);
    if body_limit_bytes < 1024 || upstream_response_limit_bytes < 1024 {
        return Err(config_error(
            "request and upstream response limits must be at least 1024 bytes",
        ));
    }
    let upstream_timeout_ms = operations
        .upstream_timeout_ms
        .unwrap_or(DEFAULT_UPSTREAM_TIMEOUT_MS);
    let shutdown_grace_ms = operations.shutdown_grace_ms.unwrap_or(10_000);
    if upstream_timeout_ms == 0 || shutdown_grace_ms < 1000 {
        return Err(config_error(
            "upstream timeout must be positive and shutdown grace must be at least 1000 ms",
        ));
    }
    let rate_limit = operations.rate_limit.unwrap_or(RateLimitConfig {
        window_ms: None,
        max_requests: None,
    });
    let rate_limit_window_ms = rate_limit.window_ms.unwrap_or(60_000);
    let rate_limit_max_requests = rate_limit.max_requests.unwrap_or(300);
    if rate_limit_window_ms < 1000 || rate_limit_max_requests == 0 {
        return Err(config_error(
            "rate limit window must be at least 1000 ms and max_requests must be positive",
        ));
    }
    let previous_secrets = config
        .previous_secret_envs
        .iter()
        .map(|name| std::env::var(name).map_err(|_| config_error(format!("set {name}"))))
        .collect::<Result<Vec<_>, _>>()?;
    if previous_secrets.iter().any(|secret| secret.len() < 32) {
        return Err(config_error(
            "previous secrets must be at least 32 characters",
        ));
    }
    let fiber_mode = required_option(
        &config.fiber.as_ref().and_then(|fiber| fiber.mode.clone()),
        "fiber.mode",
    )?;
    let fl402 = config
        .fl402
        .as_ref()
        .map(resolve_fl402_config)
        .transpose()?;
    Ok(GatewayConfig {
        server_id: config
            .server_id
            .clone()
            .unwrap_or_else(|| "fiber-paid-http-rs".to_string()),
        realm,
        public_base_url: parsed_public.to_string().trim_end_matches('/').to_string(),
        upstream: parsed_upstream
            .to_string()
            .trim_end_matches('/')
            .to_string(),
        charge,
        secret,
        previous_secrets,
        storage_path: sqlite_path(
            config
                .storage
                .as_deref()
                .unwrap_or("sqlite://./fiber-paid-http.sqlite"),
        )?,
        challenge_ttl_seconds,
        body_limit_bytes,
        upstream_response_limit_bytes,
        upstream_timeout: Duration::from_millis(upstream_timeout_ms),
        shutdown_grace: Duration::from_millis(shutdown_grace_ms),
        health_path,
        readiness_path,
        metrics_path,
        rate_limit_window: Duration::from_millis(rate_limit_window_ms),
        rate_limit_max_requests,
        fiber_mode,
        fl402,
    })
}

fn valid_operations_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains('?')
        && !value.contains('#')
}

fn resolve_fl402_config(config: &Fl402Config) -> Result<Fl402GatewayConfig, ServerError> {
    let root_key_env = config
        .root_key_env
        .clone()
        .ok_or_else(|| config_error("fl402.root_key_env is required"))?;
    let root_key =
        std::env::var(&root_key_env).map_err(|_| config_error(format!("set {root_key_env}")))?;
    if root_key.len() < 32 {
        return Err(config_error(format!(
            "{root_key_env} must be at least 32 characters"
        )));
    }
    let hash_algorithm = config
        .hash_algorithm
        .clone()
        .unwrap_or_else(|| "ckb_hash".to_string());
    if !matches!(hash_algorithm.as_str(), "ckb_hash" | "sha256") {
        return Err(config_error(
            "fl402.hash_algorithm must be ckb_hash or sha256",
        ));
    }
    Ok(Fl402GatewayConfig {
        root_key,
        hash_algorithm,
    })
}

fn resource_descriptor(
    config: &GatewayConfig,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Value, ServerError> {
    let mut resource = json!({
        "method": method.as_str(),
        "url": format!("{}{}", config.public_base_url, uri.path_and_query().map(|value| value.as_str()).unwrap_or("/"))
    });
    if !matches!(*method, Method::GET | Method::HEAD) {
        resource["digest"] = Value::String(body_digest(body));
    }
    if let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        resource["contentType"] = Value::String(content_type.to_string());
    }
    Ok(resource)
}

fn upstream_url(base: &str, uri: &Uri) -> Result<reqwest::Url, ServerError> {
    let base =
        reqwest::Url::parse(base).map_err(|_| config_error("upstream must be an absolute URL"))?;
    base.join(
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/"),
    )
    .map_err(|_| config_error("invalid upstream request URL"))
}

fn sqlite_path(uri: &str) -> Result<String, ServerError> {
    uri.strip_prefix("sqlite://")
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| config_error("storage must be a sqlite:// URI"))
}

fn assert_not_expired(challenge: &PaymentChallenge) -> Result<(), ServerError> {
    let expires = challenge
        .expires
        .as_ref()
        .ok_or_else(|| payment_error("missing-expiry"))?;
    let expires = DateTime::parse_from_rfc3339(expires)
        .map_err(|_| payment_error("invalid-expiry"))?
        .with_timezone(&Utc);
    if Utc::now() > expires {
        return Err(payment_error("expired-challenge"));
    }
    Ok(())
}

fn expiry_seconds_from_now(expires_at: &str) -> u64 {
    DateTime::parse_from_rfc3339(expires_at)
        .map(|expires| {
            (expires.with_timezone(&Utc) - Utc::now())
                .num_seconds()
                .max(1) as u64
        })
        .unwrap_or(1)
}

struct InvoiceMetadata {
    expires_at: String,
    udt_script: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn validate_invoice_record(
    record: &Value,
    expected_address: Option<&str>,
    expected_payment_hash: &str,
    expected_amount: &str,
    expected_currency: &str,
    expected_network: &str,
    expected_hash_algorithm: &str,
    expected_udt: Option<&FiberUdtTypeScript>,
    expected_metadata: Option<(&str, Option<&str>)>,
    require_unexpired: bool,
) -> Result<InvoiceMetadata, ServerError> {
    if expected_address.is_some_and(|expected| {
        record.get("invoice_address").and_then(Value::as_str) != Some(expected)
    }) {
        return Err(payment_error("wrong-invoice"));
    }
    let payment_hash = extract_invoice_payment_hash(record)?;
    if !payment_hash.eq_ignore_ascii_case(expected_payment_hash) {
        return Err(payment_error("wrong-payment-hash"));
    }
    let invoice = record
        .get("invoice")
        .filter(|value| value.is_object())
        .ok_or_else(|| payment_error("missing-invoice"))?;
    let amount = invoice
        .get("amount")
        .and_then(parse_rpc_quantity)
        .ok_or_else(|| payment_error("wrong-amount"))?;
    if amount.to_string() != expected_amount {
        return Err(payment_error("wrong-amount"));
    }
    let currency = invoice
        .get("currency")
        .and_then(Value::as_str)
        .ok_or_else(|| payment_error("wrong-currency"))?;
    if !currency.eq_ignore_ascii_case(expected_currency) {
        return Err(payment_error("wrong-currency"));
    }
    let network = match currency.to_ascii_lowercase().as_str() {
        "fibb" => "mainnet",
        "fibt" => "testnet",
        "fibd" => "dev",
        _ => return Err(payment_error("wrong-network")),
    };
    if network != expected_network {
        return Err(payment_error("wrong-network"));
    }
    let actual_hash_algorithm = invoice_hash_algorithm(record)?;
    if actual_hash_algorithm != expected_hash_algorithm {
        return Err(payment_error("wrong-hash-algorithm"));
    }
    let actual_udt = invoice_attribute(record, "udt_script").map(str::to_ascii_lowercase);
    let expected_udt = expected_udt.map(serialize_udt_type_script).transpose()?;
    if actual_udt.as_deref() != expected_udt.as_deref() {
        return Err(payment_error("wrong-udt"));
    }
    let data = invoice
        .get("data")
        .filter(|value| value.is_object())
        .ok_or_else(|| payment_error("wrong-expiry"))?;
    let timestamp_ms = data
        .get("timestamp")
        .and_then(parse_rpc_quantity)
        .ok_or_else(|| payment_error("wrong-expiry"))?;
    let expiry_seconds = invoice_attribute(record, "expiry_time")
        .and_then(|value| parse_rpc_quantity(&Value::String(value.to_string())))
        .ok_or_else(|| payment_error("wrong-expiry"))?;
    let expires_ms = timestamp_ms
        .checked_add(
            expiry_seconds
                .checked_mul(1000)
                .ok_or_else(|| payment_error("wrong-expiry"))?,
        )
        .ok_or_else(|| payment_error("wrong-expiry"))?;
    let expires_ms = i64::try_from(expires_ms).map_err(|_| payment_error("wrong-expiry"))?;
    let expires = DateTime::<Utc>::from_timestamp_millis(expires_ms)
        .ok_or_else(|| payment_error("wrong-expiry"))?;
    let expires_at = expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if require_unexpired && expires <= Utc::now() {
        return Err(payment_error("expired-challenge"));
    }
    if let Some((bound_expiry, bound_udt)) = expected_metadata {
        if expires_at != bound_expiry {
            return Err(payment_error("wrong-expiry"));
        }
        if actual_udt.as_deref() != bound_udt.map(str::to_ascii_lowercase).as_deref() {
            return Err(payment_error("wrong-udt"));
        }
    }
    Ok(InvoiceMetadata {
        expires_at,
        udt_script: actual_udt,
    })
}

fn parse_rpc_quantity(value: &Value) -> Option<u128> {
    if let Some(number) = value.as_u64() {
        return Some(u128::from(number));
    }
    let text = value.as_str()?;
    if let Some(hex) = text.strip_prefix("0x") {
        u128::from_str_radix(hex, 16).ok()
    } else {
        text.parse().ok()
    }
}

fn invoice_attribute<'a>(record: &'a Value, name: &str) -> Option<&'a str> {
    record
        .get("invoice")?
        .get("data")?
        .get("attrs")?
        .as_array()?
        .iter()
        .find_map(|attr| attr.get(name).and_then(Value::as_str))
}

fn invoice_hash_algorithm(record: &Value) -> Result<&'static str, ServerError> {
    match invoice_attribute(record, "hash_algorithm") {
        None | Some("ckb_hash") => Ok("ckb_hash"),
        Some("sha256") => Ok("sha256"),
        Some(_) => Err(payment_error("wrong-hash-algorithm")),
    }
}

fn serialize_udt_type_script(script: &FiberUdtTypeScript) -> Result<String, ServerError> {
    let code_hash = hex::decode(script.code_hash.trim_start_matches("0x"))
        .map_err(|_| payment_error("wrong-udt"))?;
    let args = hex::decode(script.args.trim_start_matches("0x"))
        .map_err(|_| payment_error("wrong-udt"))?;
    if code_hash.len() != 32 {
        return Err(payment_error("wrong-udt"));
    }
    let hash_type = match script.hash_type.to_ascii_lowercase().as_str() {
        "data" => 0,
        "type" => 1,
        "data1" => 2,
        "data2" => 4,
        _ => return Err(payment_error("wrong-udt")),
    };
    let total = 53usize
        .checked_add(args.len())
        .ok_or_else(|| payment_error("wrong-udt"))?;
    let total_u32 = u32::try_from(total).map_err(|_| payment_error("wrong-udt"))?;
    let args_len = u32::try_from(args.len()).map_err(|_| payment_error("wrong-udt"))?;
    let mut encoded = Vec::with_capacity(total);
    encoded.extend_from_slice(&total_u32.to_le_bytes());
    encoded.extend_from_slice(&16u32.to_le_bytes());
    encoded.extend_from_slice(&48u32.to_le_bytes());
    encoded.extend_from_slice(&49u32.to_le_bytes());
    encoded.extend_from_slice(&code_hash);
    encoded.push(hash_type);
    encoded.extend_from_slice(&args_len.to_le_bytes());
    encoded.extend_from_slice(&args);
    Ok(format!("0x{}", hex::encode(encoded)))
}

fn error_response(error: ServerError) -> Response {
    let (status, title, detail) = match error {
        ServerError::Payment(code) => (StatusCode::PAYMENT_REQUIRED, code.clone(), code),
        ServerError::PayloadTooLarge => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload-too-large".to_string(),
            "Request body exceeds the configured limit".to_string(),
        ),
        ServerError::Fiber(_) | ServerError::Http(_) | ServerError::Upstream(_) => (
            StatusCode::BAD_GATEWAY,
            "gateway-unavailable".to_string(),
            "Payment or protected upstream service is unavailable".to_string(),
        ),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal-error".to_string(),
            "Internal error".to_string(),
        ),
    };
    let mut response = (
        status,
        Json(json!({
            "type": "https://paymentauth.org/problems/payment-error",
            "title": title,
            "status": status.as_u16(),
            "detail": detail
        })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn lock_store(state: &GatewayState) -> Result<std::sync::MutexGuard<'_, SqliteStore>, ServerError> {
    state
        .store
        .lock()
        .map_err(|_| config_error("store lock poisoned"))
}

fn lock_store_mut(
    state: &GatewayState,
) -> Result<std::sync::MutexGuard<'_, SqliteStore>, ServerError> {
    lock_store(state)
}

fn required_option<T: Clone>(value: &Option<T>, name: &str) -> Result<T, ServerError> {
    value
        .clone()
        .ok_or_else(|| config_error(format!("{name} is required")))
}

fn required_string(value: &Value, field: &'static str) -> Result<String, ServerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| payment_error(format!("missing-{field}")))
}

fn payment_error(code: impl Into<String>) -> ServerError {
    ServerError::Payment(code.into())
}

fn config_error(message: impl Into<String>) -> ServerError {
    ServerError::Config(message.into())
}

fn upstream_error(message: impl Into<String>) -> ServerError {
    ServerError::Upstream(message.into())
}

fn header_value(value: &str) -> Result<HeaderValue, ServerError> {
    HeaderValue::from_str(value).map_err(|_| config_error("invalid response header value"))
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    hex::encode(value)
}

fn escape_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use fiber_paid_http_core::{
        authorization_header, decode_base64url_json, parse_www_authenticate_header,
    };
    use std::sync::atomic::{AtomicU16, Ordering};
    use tempfile::TempDir;
    use tower::ServiceExt;

    const PAYMENT_HASH: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Default)]
    struct FixtureFiber;

    impl GatewayFiber for FixtureFiber {
        fn create_charge(&self, input: FiberChargeInput) -> BoxGatewayFuture<FiberChargeRequest> {
            Box::pin(async move {
                Ok(FiberChargeRequest {
                    amount: input.amount,
                    currency: input.currency,
                    recipient: None,
                    description: input.description,
                    external_id: input.external_id,
                    method_details: FiberChargeMethodDetails {
                        invoice: "fibt1fixture".to_string(),
                        payment_hash: PAYMENT_HASH.to_string(),
                        network: "testnet".to_string(),
                        hash_algorithm: "ckb_hash".to_string(),
                        udt_type_script: None,
                        extensions: BTreeMap::new(),
                    },
                    extensions: BTreeMap::new(),
                })
            })
        }

        fn verify_paid(
            &self,
            request: FiberChargeRequest,
            payload: FiberCredentialPayload,
        ) -> BoxGatewayFuture<Value> {
            Box::pin(async move {
                if payload.payment_hash != request.method_details.payment_hash {
                    return Err(payment_error("wrong-payment-hash"));
                }
                Ok(json!({
                    "status": "settled",
                    "paymentHash": payload.payment_hash,
                    "observedAt": "2026-07-13T00:00:00.000Z"
                }))
            })
        }

        fn readiness(&self) -> BoxGatewayFuture<Value> {
            Box::pin(async { Ok(json!({ "peerCount": 1, "readyChannels": 1 })) })
        }
    }

    struct FixtureUpstream(AtomicU16);

    impl FixtureUpstream {
        fn with_status(status: StatusCode) -> Self {
            Self(AtomicU16::new(status.as_u16()))
        }
    }

    impl UpstreamClient for FixtureUpstream {
        fn call(
            &self,
            _request: UpstreamRequest,
            _upstream_base: String,
        ) -> BoxGatewayFuture<UpstreamResponse> {
            let status = StatusCode::from_u16(self.0.load(Ordering::Relaxed)).unwrap();
            Box::pin(async move {
                Ok(UpstreamResponse {
                    status,
                    headers: HeaderMap::new(),
                    body: b"fixture".to_vec(),
                })
            })
        }
    }

    fn test_app(status: StatusCode) -> (Router, TempDir) {
        test_app_with_limits(status, DEFAULT_BODY_LIMIT_BYTES, 300)
    }

    fn test_app_with_limits(
        status: StatusCode,
        body_limit_bytes: usize,
        rate_limit_max_requests: u64,
    ) -> (Router, TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(directory.path().join("gateway.sqlite")).unwrap();
        let config = GatewayConfig {
            server_id: "fixture-gateway".to_string(),
            realm: "api.example.com".to_string(),
            public_base_url: "https://api.example.com".to_string(),
            upstream: "http://127.0.0.1:3000".to_string(),
            charge: ChargeConfig {
                amount: "1000".to_string(),
                currency: "Fibt".to_string(),
                description: Some("fixture charge".to_string()),
                external_id: None,
            },
            secret: "0123456789abcdef0123456789abcdef".to_string(),
            previous_secrets: vec![],
            storage_path: directory
                .path()
                .join("gateway.sqlite")
                .display()
                .to_string(),
            challenge_ttl_seconds: 120,
            body_limit_bytes,
            upstream_response_limit_bytes: DEFAULT_UPSTREAM_RESPONSE_LIMIT_BYTES,
            upstream_timeout: Duration::from_secs(30),
            shutdown_grace: Duration::from_secs(10),
            health_path: "/healthz".to_string(),
            readiness_path: "/readyz".to_string(),
            metrics_path: "/metrics".to_string(),
            rate_limit_window: Duration::from_secs(60),
            rate_limit_max_requests,
            fiber_mode: "testnet".to_string(),
            fl402: None,
        };
        let state = GatewayState::for_test(
            config,
            store,
            Arc::new(FixtureFiber),
            Arc::new(FixtureUpstream::with_status(status)),
        );
        (gateway_router_with_state(state), directory)
    }

    async fn issued_challenge(app: &Router) -> PaymentChallenge {
        let response = app
            .clone()
            .oneshot(Request::builder().uri("/paid").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        let header = response
            .headers()
            .get_all(header::WWW_AUTHENTICATE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find(|value| value.starts_with("Payment "))
            .unwrap();
        parse_www_authenticate_header(header).unwrap()
    }

    fn paid_request(challenge: PaymentChallenge) -> Request<Body> {
        let credential = PaymentCredential {
            challenge,
            source: None,
            payload: FiberCredentialPayload {
                payment_hash: PAYMENT_HASH.to_string(),
                extensions: BTreeMap::new(),
            },
            extensions: BTreeMap::new(),
        };
        Request::builder()
            .uri("/paid")
            .header(
                header::AUTHORIZATION,
                authorization_header(&credential).unwrap(),
            )
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn requires_https_without_explicit_local_override() {
        std::env::set_var("TEST_MPP_SECRET", "0123456789abcdef0123456789abcdef");
        let config = ServerConfig {
            listen: None,
            storage: None,
            upstream: Some("http://127.0.0.1:3000".to_string()),
            server_id: None,
            realm: Some("example.com".to_string()),
            public_base_url: Some("http://example.com".to_string()),
            allow_insecure_http: None,
            charge: Some(ChargeConfig {
                amount: "1000".to_string(),
                currency: "Fibt".to_string(),
                description: None,
                external_id: None,
            }),
            secret_env: Some("TEST_MPP_SECRET".to_string()),
            previous_secret_envs: vec![],
            challenge_ttl_seconds: None,
            operations: None,
            fiber: Some(FiberConfig {
                mode: Some("testnet".to_string()),
                currency: None,
                rpc_url: None,
                payee_rpc_url: None,
                rpc_auth_env: None,
                payee_rpc_auth_env: None,
                payee_node_id: None,
                settlement_timeout_ms: None,
                settlement_poll_ms: None,
                hash_algorithm: None,
            }),
            fl402: None,
        };
        assert!(resolve_gateway_config(&config).is_err());
    }

    #[tokio::test]
    async fn exposes_health_readiness_metrics_and_enforces_limits() {
        let (app, _directory) = test_app_with_limits(StatusCode::OK, 1024, 1);
        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(health.headers()[header::CACHE_CONTROL], "no-store");
        let ready = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        assert_eq!(ready.headers()[header::CACHE_CONTROL], "no-store");

        let first = app
            .clone()
            .oneshot(Request::builder().uri("/paid").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::PAYMENT_REQUIRED);
        let limited = app
            .clone()
            .oneshot(Request::builder().uri("/paid").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);

        let metrics = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(metrics.status(), StatusCode::OK);
        assert_eq!(metrics.headers()[header::CACHE_CONTROL], "no-store");
        let metrics_body = to_bytes(metrics.into_body(), 64 * 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&metrics_body)
            .contains("fiber_paid_http_gateway_rate_limit_rejections_total"));

        let (body_app, _directory) = test_app_with_limits(StatusCode::OK, 1024, 100);
        let oversized = body_app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/paid")
                    .body(Body::from(vec![0_u8; 1025]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn strips_sensitive_and_hop_by_hop_proxy_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONNECTION, HeaderValue::from_static("x-remove"));
        let nominated = HeaderName::from_static("x-remove");
        assert!(!forwardable_header(&header::AUTHORIZATION, &headers));
        assert!(!forwardable_header(&header::HOST, &headers));
        assert!(!forwardable_header(&header::CONNECTION, &headers));
        assert!(!forwardable_header(
            &HeaderName::from_static(PAYMENT_RECEIPT_HEADER),
            &headers
        ));
        assert!(!forwardable_header(&nominated, &headers));
        assert!(forwardable_header(&header::CONTENT_TYPE, &headers));
        assert!(!response_header_allowed(
            &header::TRANSFER_ENCODING,
            &headers
        ));
        assert!(!response_header_allowed(
            &HeaderName::from_static(PAYMENT_RECEIPT_HEADER),
            &headers
        ));
        assert!(!response_header_allowed(&nominated, &headers));
    }

    #[tokio::test]
    async fn emits_receipt_only_after_success_and_rejects_replay() {
        let (app, _directory) = test_app(StatusCode::OK);
        let challenge = issued_challenge(&app).await;
        let response = app
            .clone()
            .oneshot(paid_request(challenge.clone()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "private");
        let receipt: PaymentReceipt =
            decode_base64url_json(response.headers()[PAYMENT_RECEIPT_HEADER].to_str().unwrap())
                .unwrap();
        assert_eq!(receipt.reference, PAYMENT_HASH);
        assert_eq!(receipt.challenge_id, challenge.id);

        let replay = app.oneshot(paid_request(challenge)).await.unwrap();
        assert_eq!(replay.status(), StatusCode::PAYMENT_REQUIRED);
        assert!(replay.headers().get(PAYMENT_RECEIPT_HEADER).is_none());
    }

    #[tokio::test]
    async fn upstream_non_success_never_receives_payment_receipt() {
        let (app, _directory) = test_app(StatusCode::INTERNAL_SERVER_ERROR);
        let challenge = issued_challenge(&app).await;
        let response = app.oneshot(paid_request(challenge)).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(response.headers().get(PAYMENT_RECEIPT_HEADER).is_none());
    }

    #[test]
    fn invoice_record_validation_is_fail_closed() {
        let valid = invoice_record();
        let metadata = validate_invoice_record(
            &valid,
            Some("fibt1fixture"),
            PAYMENT_HASH,
            "1000",
            "Fibt",
            "testnet",
            "ckb_hash",
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(metadata.expires_at, "2030-01-01T00:02:00.000Z");

        for (field, value, code) in [
            ("invoice_address", json!("fibt1wrong"), "wrong-invoice"),
            ("invoice.amount", json!("0x3e9"), "wrong-amount"),
            ("invoice.currency", json!("Fibd"), "wrong-currency"),
            (
                "invoice.data.payment_hash",
                json!(format!("0x{}", "bb".repeat(32))),
                "wrong-payment-hash",
            ),
        ] {
            let mut changed = valid.clone();
            set_json_path(&mut changed, field, value);
            assert_payment_error(
                validate_invoice_record(
                    &changed,
                    Some("fibt1fixture"),
                    PAYMENT_HASH,
                    "1000",
                    "Fibt",
                    "testnet",
                    "ckb_hash",
                    None,
                    None,
                    false,
                ),
                code,
            );
        }

        let mut wrong_hash_algorithm = valid.clone();
        wrong_hash_algorithm["invoice"]["data"]["attrs"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "hash_algorithm": "sha256" }));
        assert_payment_error(
            validate_invoice_record(
                &wrong_hash_algorithm,
                Some("fibt1fixture"),
                PAYMENT_HASH,
                "1000",
                "Fibt",
                "testnet",
                "ckb_hash",
                None,
                None,
                false,
            ),
            "wrong-hash-algorithm",
        );

        let mut wrong_udt = valid.clone();
        wrong_udt["invoice"]["data"]["attrs"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "udt_script": "0x00" }));
        assert_payment_error(
            validate_invoice_record(
                &wrong_udt,
                Some("fibt1fixture"),
                PAYMENT_HASH,
                "1000",
                "Fibt",
                "testnet",
                "ckb_hash",
                None,
                None,
                false,
            ),
            "wrong-udt",
        );

        assert_payment_error(
            validate_invoice_record(
                &valid,
                Some("fibt1fixture"),
                PAYMENT_HASH,
                "1000",
                "Fibt",
                "testnet",
                "ckb_hash",
                None,
                Some(("2030-01-01T00:02:01.000Z", None)),
                false,
            ),
            "wrong-expiry",
        );
    }

    #[test]
    fn serializes_ckb_udt_script_as_molecule_bytes() {
        let script = FiberUdtTypeScript {
            code_hash: format!("0x{}", "00".repeat(32)),
            hash_type: "data".to_string(),
            args: "0x".to_string(),
        };
        assert_eq!(
            serialize_udt_type_script(&script).unwrap(),
            "0x3500000010000000300000003100000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
    }

    fn invoice_record() -> Value {
        json!({
            "invoice_address": "fibt1fixture",
            "status": "Paid",
            "invoice": {
                "amount": "0x3e8",
                "currency": "Fibt",
                "data": {
                    "payment_hash": PAYMENT_HASH,
                    "timestamp": "0x1b8dac5b400",
                    "attrs": [{ "expiry_time": "0x78" }]
                }
            }
        })
    }

    fn set_json_path(value: &mut Value, path: &str, replacement: Value) {
        let mut current = value;
        let mut segments = path.split('.').peekable();
        while let Some(segment) = segments.next() {
            if segments.peek().is_none() {
                current[segment] = replacement;
                return;
            }
            current = &mut current[segment];
        }
    }

    fn assert_payment_error(result: Result<InvoiceMetadata, ServerError>, expected: &str) {
        assert!(matches!(result, Err(ServerError::Payment(code)) if code == expected));
    }
}
