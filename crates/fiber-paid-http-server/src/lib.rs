use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use fiber_paid_http_core::{canonical_json, resource_hash, sha256_hex, sign_value};
use fiber_paid_http_fiber::{extract_invoice_payment_hash, is_invoice_paid_status, FiberRpcClient};
use fiber_paid_http_fl402::{
    decode_fl402_macaroon, fl402_proof_to_credential, issue_fl402_macaroon, verify_fl402_proof,
};
use fiber_paid_http_storage::{ChallengeRecord, DeliveryOutcome, ReplayStore, SqliteStore};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    future::Future,
    net::SocketAddr,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
};
use thiserror::Error;
use tokio::net::TcpListener;

const PAYMENT_AUTH_SCHEME: &str = "Payment";
const PAYMENT_RECEIPT_HEADER: &str = "Payment-Receipt";
const DEFAULT_BODY_LIMIT_BYTES: usize = 1024 * 1024;

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
    #[error("fl402 error: {0}")]
    Fl402(#[from] fiber_paid_http_fl402::Fl402Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("gateway rejected request: {code}")]
    Payment { code: String, status: StatusCode },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub listen: Option<String>,
    pub storage: Option<String>,
    pub upstream: Option<String>,
    pub server_id: Option<String>,
    pub price: Option<AmountConfig>,
    pub secret_env: Option<String>,
    #[serde(default)]
    pub previous_secret_envs: Vec<String>,
    pub challenge_ttl_seconds: Option<i64>,
    pub default_fiber_amount_shannons: Option<String>,
    pub fiber: Option<FiberConfig>,
    pub fl402: Option<Fl402Config>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmountConfig {
    pub value: String,
    pub currency: String,
    pub display: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiberConfig {
    pub mode: Option<String>,
    pub rpc_url: Option<String>,
    pub payee_rpc_url: Option<String>,
    pub rpc_auth_env: Option<String>,
    pub payee_rpc_auth_env: Option<String>,
    pub currency: Option<String>,
    pub asset: Option<String>,
    pub payee_node_id: Option<String>,
    pub settlement_timeout_ms: Option<u64>,
    pub settlement_poll_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fl402Config {
    pub root_key_env: Option<String>,
    pub hash_algorithm: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub server_id: String,
    pub upstream: String,
    pub price: AmountConfig,
    pub secret: String,
    pub previous_secrets: Vec<String>,
    pub storage_path: String,
    pub challenge_ttl_seconds: i64,
    pub default_fiber_amount_shannons: String,
    pub body_limit_bytes: usize,
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
}

#[derive(Debug, Clone)]
pub struct FiberChallengeInput {
    pub challenge_id: String,
    pub amount_shannons: String,
    pub expires_at: String,
    pub description: String,
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
    fn create_challenge(&self, input: FiberChallengeInput) -> BoxGatewayFuture<Value>;
    fn verify_paid(&self, challenge: Value, proof: Value) -> BoxGatewayFuture<Value>;
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
    mode: String,
    asset: String,
    currency: String,
    node_id: Option<String>,
    label: String,
    rpc: FiberRpcClient,
}

impl RpcGatewayFiber {
    pub fn from_config(config: &FiberConfig) -> Result<Self, ServerError> {
        let mode = config
            .mode
            .clone()
            .ok_or_else(|| ServerError::Config("fiber.mode is required".to_string()))?;
        if mode != "local" && mode != "testnet" {
            return Err(ServerError::Config(
                "fiber.mode must be local or testnet".to_string(),
            ));
        }
        let url = config
            .payee_rpc_url
            .clone()
            .or_else(|| config.rpc_url.clone())
            .ok_or_else(|| {
                ServerError::Config("fiber.payee_rpc_url or fiber.rpc_url is required".to_string())
            })?;
        let auth = config
            .payee_rpc_auth_env
            .as_ref()
            .or(config.rpc_auth_env.as_ref())
            .and_then(|name| std::env::var(name).ok());
        Ok(Self {
            mode,
            asset: config.asset.clone().unwrap_or_else(|| "CKB".to_string()),
            currency: config
                .currency
                .clone()
                .unwrap_or_else(|| "Fibt".to_string()),
            node_id: config.payee_node_id.clone(),
            label: "rust-fiber-rpc".to_string(),
            rpc: FiberRpcClient::new(url, auth),
        })
    }
}

impl GatewayFiber for RpcGatewayFiber {
    fn create_challenge(&self, input: FiberChallengeInput) -> BoxGatewayFuture<Value> {
        let rpc = self.rpc.clone();
        let asset = self.asset.clone();
        let currency = self.currency.clone();
        let node_id = self.node_id.clone();
        let label = self.label.clone();
        Box::pin(async move {
            let expiry_seconds = expiry_seconds_from_now(&input.expires_at);
            let invoice = rpc
                .new_invoice(&input.amount_shannons, &currency, Some(expiry_seconds))
                .await?;
            let payment_hash = extract_invoice_payment_hash(&invoice)?;
            Ok(strip_nulls(json!({
                "method": "fiber",
                "intent": "charge",
                "asset": asset,
                "amountShannons": input.amount_shannons,
                "paymentHash": payment_hash,
                "invoice": invoice.get("invoice_address").and_then(Value::as_str),
                "fiberNodeId": node_id,
                "fiberRpcLabel": label,
                "expiresAt": input.expires_at
            })))
        })
    }

    fn verify_paid(&self, challenge: Value, proof: Value) -> BoxGatewayFuture<Value> {
        let rpc = self.rpc.clone();
        let mode = self.mode.clone();
        let label = self.label.clone();
        Box::pin(async move {
            verify_fiber_proof_shape(&challenge, &proof, &mode)?;
            let payment_hash = required_string(&challenge, "paymentHash")?;
            let invoice = rpc.get_invoice(&payment_hash).await?;
            let status = invoice.get("status").and_then(Value::as_str).unwrap_or("");
            if !is_invoice_paid_status(status) {
                return Err(payment_error("fiber-payment-not-settled"));
            }
            Ok(json!({
                "status": "settled",
                "paymentHash": payment_hash,
                "invoiceId": challenge.get("invoice").and_then(Value::as_str),
                "provider": label,
                "observedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            }))
        })
    }
}

#[derive(Clone, Default)]
pub struct ReqwestUpstreamClient {
    client: reqwest::Client,
}

impl UpstreamClient for ReqwestUpstreamClient {
    fn call(
        &self,
        request: UpstreamRequest,
        upstream_base: String,
    ) -> BoxGatewayFuture<UpstreamResponse> {
        let client = self.client.clone();
        Box::pin(async move {
            let target = upstream_url(&upstream_base, &request.uri)?;
            let mut builder = client.request(request.method.clone(), target);
            for (name, value) in request.headers.iter() {
                if name == header::AUTHORIZATION || name == PAYMENT_RECEIPT_HEADER {
                    continue;
                }
                builder = builder.header(name, value);
            }
            let response = builder.body(request.body).send().await?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = response.bytes().await?.to_vec();
            Ok(UpstreamResponse {
                status,
                headers,
                body,
            })
        })
    }
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
        "server_id": config.server_id,
        "production_gateway": true,
        "fl402_enabled": config.fl402.is_some(),
        "features": [
            "signed-challenge-issuance",
            "sqlite-challenge-replay-receipt-storage",
            "fiber-rpc-method-adapter",
            "payment-receipt-issuance",
            "fl402-l402-authorization",
            "reverse-proxy"
        ]
    }))
}

pub fn gateway_router(config: ServerConfig) -> Result<Router, ServerError> {
    let state = GatewayState::from_config(config)?;
    Ok(gateway_router_with_state(state))
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
    let app = gateway_router(config)?;
    let address: SocketAddr = listen
        .parse()
        .map_err(|_| ServerError::Config(format!("invalid listen address {listen}")))?;
    let listener = TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

impl GatewayState {
    pub fn from_config(config: ServerConfig) -> Result<Self, ServerError> {
        let gateway_config = resolve_gateway_config(&config)?;
        let store = SqliteStore::open(&gateway_config.storage_path)?;
        let fiber_config = config
            .fiber
            .as_ref()
            .ok_or_else(|| ServerError::Config("fiber config is required".to_string()))?;
        Ok(Self {
            config: Arc::new(gateway_config),
            store: Arc::new(Mutex::new(store)),
            fiber: Arc::new(RpcGatewayFiber::from_config(fiber_config)?),
            upstream: Arc::new(ReqwestUpstreamClient::default()),
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
        }
    }
}

async fn gateway_handler(State(state): State<GatewayState>, request: Request<Body>) -> Response {
    match handle_gateway_request(state, request).await {
        Ok(response) => response,
        Err(error) => error_response(error),
    }
}

async fn handle_gateway_request(
    state: GatewayState,
    request: Request<Body>,
) -> Result<Response, ServerError> {
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, state.config.body_limit_bytes)
        .await
        .map_err(|_| ServerError::Config("request body could not be read".to_string()))?
        .to_vec();
    let descriptor = resource_descriptor(&parts.method, &parts.uri, &parts.headers, &body)?;
    let authorization = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let credential = if let Some(credential) = parse_payment_authorization(authorization)? {
        credential
    } else if let Some(credential) = parse_fl402_authorization(&state, authorization)? {
        credential
    } else {
        return issue_challenge(state, descriptor, &parts.method).await;
    };

    let credential_hash = sha256_hex(canonical_json(&credential)?.as_bytes());
    let receipt = verify_credential(&state, &descriptor, &credential, &credential_hash).await?;
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
        .await?;

    let status = if upstream.status.as_u16() >= 500 {
        "failed"
    } else {
        "delivered"
    };
    {
        let store = state
            .store
            .lock()
            .map_err(|_| ServerError::Config("store lock poisoned".to_string()))?;
        store.save_delivery_outcome(&DeliveryOutcome {
            receipt_id: required_string(&receipt, "receiptId")?,
            challenge_id: required_string(&receipt, "challengeId")?,
            credential_hash,
            status: status.to_string(),
            response_status: i64::from(upstream.status.as_u16()),
            error_code: (status == "failed").then(|| "upstream-error".to_string()),
            error_message: None,
            recorded_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })?;
    }

    response_with_receipt(upstream, &receipt)
}

async fn issue_challenge(
    state: GatewayState,
    resource: Value,
    method: &Method,
) -> Result<Response, ServerError> {
    let now = Utc::now();
    let expires_at = now + Duration::seconds(state.config.challenge_ttl_seconds);
    let challenge_id = random_id("chal");
    let expires_at = expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let method_challenge = state
        .fiber
        .create_challenge(FiberChallengeInput {
            challenge_id: challenge_id.clone(),
            amount_shannons: state.config.default_fiber_amount_shannons.clone(),
            expires_at: expires_at.clone(),
            description: format!(
                "Fiber Paid HTTP {} {}",
                method.as_str(),
                resource
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("resource")
            ),
        })
        .await?;
    let challenge = json!({
        "domain": "fiber-paid-http-challenge-v1",
        "challengeId": challenge_id,
        "resource": resource,
        "amount": state.config.price,
        "methods": [method_challenge],
        "nonce": random_hex(16),
        "issuedAt": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "expiresAt": expires_at,
        "serverId": state.config.server_id,
        "maxUses": 1
    });
    let signature = sign_value(&challenge, &state.config.secret)?;
    let resource_hash = resource_hash(challenge.get("resource").ok_or(ServerError::Config(
        "challenge missing resource".to_string(),
    ))?)?;
    let fl402 = state
        .config
        .fl402
        .as_ref()
        .map(|fl402| fl402_challenge_from_payment_challenge(fl402, &challenge, &resource_hash))
        .transpose()?;
    {
        let store = state
            .store
            .lock()
            .map_err(|_| ServerError::Config("store lock poisoned".to_string()))?;
        store.save_challenge(
            required_string(&challenge, "challengeId")?.as_str(),
            &ChallengeRecord {
                challenge: challenge.clone(),
                signature: signature.clone(),
                resource_hash,
                created_at: required_string(&challenge, "issuedAt")?,
                expires_at: required_string(&challenge, "expiresAt")?,
            },
        )?;
    }
    let signed = json!({ "challenge": challenge, "signature": signature });
    let mut body = json!({
        "type": "https://paymentauth.org/problems/payment-required",
        "title": "Payment Required",
        "status": 402,
        "detail": "Payment is required.",
        "challengeId": signed.get("challenge").and_then(|challenge| challenge.get("challengeId")),
        "challenge": signed.get("challenge"),
        "challengeSignature": signed.get("signature"),
        "methods": signed.get("challenge").and_then(|challenge| challenge.get("methods"))
    });
    if let Some(fl402) = fl402.clone() {
        body["fl402"] = fl402;
    }
    let mut response = (StatusCode::PAYMENT_REQUIRED, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let mut authenticate = www_authenticate_header(&signed)?;
    if let Some(fl402) = fl402 {
        authenticate.push_str(", ");
        authenticate.push_str(&l402_www_authenticate_header(&fl402)?);
    }
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_str(&authenticate)
            .map_err(|_| ServerError::Config("invalid challenge header".to_string()))?,
    );
    Ok(response)
}

async fn verify_credential(
    state: &GatewayState,
    descriptor: &Value,
    credential: &Value,
    credential_hash: &str,
) -> Result<Value, ServerError> {
    if required_string(credential, "domain")? != "fiber-paid-http-credential-v1" {
        return Err(payment_error("invalid-credential"));
    }
    let challenge_id = required_string(credential, "challengeId")?;
    let record = {
        let store = state
            .store
            .lock()
            .map_err(|_| ServerError::Config("store lock poisoned".to_string()))?;
        if store.was_used(credential_hash)? {
            return Err(payment_error("replay"));
        }
        store.get_challenge(&challenge_id)?
    }
    .ok_or_else(|| payment_error("unknown-challenge"))?;

    let signature_valid = std::iter::once(&state.config.secret)
        .chain(state.config.previous_secrets.iter())
        .any(|secret| {
            sign_value(&record.challenge, secret)
                .map(|expected| expected == record.signature)
                .unwrap_or(false)
        });
    if !signature_valid {
        return Err(payment_error("bad-challenge-signature"));
    }
    assert_not_expired(&record.challenge)?;

    let current_resource_hash = resource_hash(descriptor)?;
    if required_string(credential, "resourceHash")? != record.resource_hash
        || current_resource_hash != record.resource_hash
    {
        return Err(payment_error("wrong-resource"));
    }
    let method = required_string(credential, "method")?;
    if method != "fiber" {
        return Err(payment_error("wrong-method"));
    }
    let method_challenge = record
        .challenge
        .get("methods")
        .and_then(Value::as_array)
        .and_then(|methods| {
            methods.iter().find(|method_value| {
                method_value.get("method").and_then(Value::as_str) == Some(method.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| payment_error("wrong-method"))?;
    let proof = credential
        .get("paymentProof")
        .cloned()
        .ok_or_else(|| payment_error("invalid-fiber-proof"))?;
    let settlement = state.fiber.verify_paid(method_challenge, proof).await?;
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    {
        let mut store = state
            .store
            .lock()
            .map_err(|_| ServerError::Config("store lock poisoned".to_string()))?;
        if !store.mark_challenge_used(&challenge_id, &now)? {
            return Err(payment_error("replay"));
        }
        if !store.mark_used(credential_hash, credential)? {
            return Err(payment_error("replay"));
        }
    }

    let receipt = json!({
        "domain": "fiber-paid-http-receipt-v1",
        "receiptId": random_id("rcpt"),
        "challengeId": challenge_id,
        "method": method,
        "resourceHash": record.resource_hash,
        "amount": {
            "value": state.config.price.value,
            "currency": state.config.price.currency
        },
        "settlement": settlement,
        "serverId": state.config.server_id,
        "issuedAt": now
    });
    let mut receipt_object = receipt
        .as_object()
        .cloned()
        .ok_or(ServerError::Config("receipt is not an object".to_string()))?;
    receipt_object.insert(
        "signature".to_string(),
        Value::String(sign_value(
            &Value::Object(receipt_object.clone()),
            &state.config.secret,
        )?),
    );
    let signed = Value::Object(receipt_object);
    {
        let store = state
            .store
            .lock()
            .map_err(|_| ServerError::Config("store lock poisoned".to_string()))?;
        store.save_receipt(&required_string(&signed, "receiptId")?, &signed)?;
    }
    Ok(signed)
}

fn response_with_receipt(
    upstream: UpstreamResponse,
    receipt: &Value,
) -> Result<Response, ServerError> {
    let mut response = Response::new(Body::from(upstream.body));
    *response.status_mut() = upstream.status;
    for (name, value) in upstream.headers.iter() {
        if name == header::CONTENT_LENGTH {
            continue;
        }
        response.headers_mut().insert(name.clone(), value.clone());
    }
    response.headers_mut().insert(
        HeaderName::from_static("payment-receipt"),
        HeaderValue::from_str(&encode_json(receipt)?)
            .map_err(|_| ServerError::Config("invalid receipt header".to_string()))?,
    );
    Ok(response)
}

fn error_response(error: ServerError) -> Response {
    let (status, code, detail) = match error {
        ServerError::Payment { code, status } => (status, code.clone(), code),
        other => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal-error".to_string(),
            other.to_string(),
        ),
    };
    let mut response = (
        status,
        Json(json!({
            "type": "https://fiber-paid-http.local/problems/payment-error",
            "title": code,
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

fn resolve_gateway_config(config: &ServerConfig) -> Result<GatewayConfig, ServerError> {
    let secret_env = config
        .secret_env
        .clone()
        .unwrap_or_else(|| "FIBER_PAID_HTTP_SECRET".to_string());
    let secret =
        env_var_with_default_legacy(&secret_env, "FIBER_PAID_HTTP_SECRET", "FIBER_MPP_SECRET")
            .ok_or_else(|| ServerError::Config(format!("set {secret_env}")))?;
    if secret.len() < 32 {
        return Err(ServerError::Config(format!(
            "{secret_env} must be at least 32 characters"
        )));
    }
    let fiber_mode = config
        .fiber
        .as_ref()
        .and_then(|fiber| fiber.mode.clone())
        .ok_or_else(|| ServerError::Config("fiber.mode is required".to_string()))?;
    let previous_secrets = config
        .previous_secret_envs
        .iter()
        .map(|name| {
            std::env::var(name)
                .map_err(|_| ServerError::Config(format!("set previous secret env {name}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
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
        upstream: config
            .upstream
            .clone()
            .ok_or_else(|| ServerError::Config("upstream is required".to_string()))?,
        price: config.price.clone().unwrap_or_else(|| AmountConfig {
            value: "1".to_string(),
            currency: "CKB".to_string(),
            display: Some("1 CKB".to_string()),
        }),
        secret,
        previous_secrets,
        storage_path: sqlite_path(
            config
                .storage
                .as_deref()
                .unwrap_or("sqlite://./fiber-paid-http-rs.sqlite"),
        )?,
        challenge_ttl_seconds: config.challenge_ttl_seconds.unwrap_or(120),
        default_fiber_amount_shannons: config
            .default_fiber_amount_shannons
            .clone()
            .unwrap_or_else(|| "1000".to_string()),
        body_limit_bytes: DEFAULT_BODY_LIMIT_BYTES,
        fiber_mode,
        fl402,
    })
}

fn resolve_fl402_config(config: &Fl402Config) -> Result<Fl402GatewayConfig, ServerError> {
    let root_key_env = config
        .root_key_env
        .clone()
        .unwrap_or_else(|| "FIBER_PAID_HTTP_FL402_ROOT_KEY".to_string());
    let root_key = env_var_with_default_legacy(
        &root_key_env,
        "FIBER_PAID_HTTP_FL402_ROOT_KEY",
        "FIBER_MPP_FL402_ROOT_KEY",
    )
    .ok_or_else(|| ServerError::Config(format!("set {root_key_env}")))?;
    if root_key.len() < 16 {
        return Err(ServerError::Config(format!(
            "{root_key_env} must be at least 16 characters"
        )));
    }
    let hash_algorithm = config
        .hash_algorithm
        .clone()
        .unwrap_or_else(|| "ckb_hash".to_string());
    if hash_algorithm != "ckb_hash" && hash_algorithm != "sha256" {
        return Err(ServerError::Config(
            "fl402.hash_algorithm must be ckb_hash or sha256".to_string(),
        ));
    }
    Ok(Fl402GatewayConfig {
        root_key,
        hash_algorithm,
    })
}

fn env_var_with_default_legacy(
    name: &str,
    default_name: &str,
    legacy_name: &str,
) -> Option<String> {
    std::env::var(name).ok().or_else(|| {
        if name == default_name {
            std::env::var(legacy_name).ok()
        } else {
            None
        }
    })
}

fn sqlite_path(uri: &str) -> Result<String, ServerError> {
    uri.strip_prefix("sqlite://")
        .map(ToString::to_string)
        .ok_or_else(|| ServerError::Config("storage must use sqlite://path".to_string()))
}

fn resource_descriptor(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Value, ServerError> {
    let url = request_url(uri, headers)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let mut descriptor = json!({
        "method": method.as_str().to_ascii_uppercase(),
        "url": url
    });
    if method != Method::GET && method != Method::HEAD {
        descriptor["bodyHash"] = Value::String(sha256_hex(body));
    }
    if let Some(content_type) = content_type {
        descriptor["contentType"] = Value::String(content_type.to_string());
    }
    Ok(descriptor)
}

fn request_url(uri: &Uri, headers: &HeaderMap) -> Result<String, ServerError> {
    if uri.scheme().is_some() {
        return Ok(uri.to_string());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .unwrap_or("localhost");
    Ok(format!("http://{host}{uri}"))
}

fn upstream_url(base: &str, uri: &Uri) -> Result<String, ServerError> {
    let base = base.trim_end_matches('/');
    let path = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    Ok(format!("{base}{path}"))
}

fn parse_payment_authorization(header: Option<&str>) -> Result<Option<Value>, ServerError> {
    let Some(header) = header else {
        return Ok(None);
    };
    let mut parts = header.trim().splitn(2, char::is_whitespace);
    if parts.next() != Some(PAYMENT_AUTH_SCHEME) {
        return Ok(None);
    }
    let Some(token) = parts.next() else {
        return Ok(None);
    };
    Ok(Some(decode_json(token)?))
}

fn parse_fl402_authorization(
    state: &GatewayState,
    header: Option<&str>,
) -> Result<Option<Value>, ServerError> {
    let Some(config) = state.config.fl402.as_ref() else {
        return Ok(None);
    };
    let Some((macaroon, preimage)) = parse_l402_authorization(header)? else {
        return Ok(None);
    };
    let (payload, _) =
        decode_fl402_macaroon(&macaroon).map_err(|error| payment_error(&error.to_string()))?;
    let caveats = payload
        .get("caveats")
        .filter(|value| value.is_object())
        .ok_or_else(|| payment_error("invalid-fl402-macaroon"))?;
    let challenge_id = payment_string(caveats, "challengeId", "invalid-fl402-macaroon")?;
    let resource_hash = payment_string(caveats, "resourceHash", "wrong-resource")?;
    let hash_algorithm = caveats
        .get("hashAlgorithm")
        .and_then(Value::as_str)
        .unwrap_or("ckb_hash")
        .to_string();
    let challenge = strip_nulls(json!({
        "challengeId": challenge_id.clone(),
        "macaroon": macaroon.clone(),
        "invoice": payment_string(caveats, "invoice", "wrong-invoice")?,
        "paymentHash": payment_string(caveats, "paymentHash", "wrong-payment-hash")?,
        "amount": payment_string(caveats, "amount", "wrong-amount")?,
        "currency": payment_string(caveats, "currency", "wrong-amount")?,
        "expiresAt": payment_string(caveats, "expiresAt", "expired-fl402-macaroon")?,
        "resource": payment_string(caveats, "url", "wrong-resource")?,
        "resourceHash": resource_hash.clone(),
        "issuer": caveats.get("issuer").and_then(Value::as_str),
        "fiberNodeId": caveats.get("fiberNodeId").and_then(Value::as_str),
        "hashAlgorithm": hash_algorithm.clone()
    }));
    let observed_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let proof = strip_nulls(json!({
        "macaroon": macaroon,
        "preimage": preimage,
        "invoice": payment_string(caveats, "invoice", "wrong-invoice")?,
        "paymentHash": payment_string(caveats, "paymentHash", "wrong-payment-hash")?,
        "amountShannons": payment_string(caveats, "amount", "wrong-amount")?,
        "mode": state.config.fiber_mode.clone(),
        "status": "settled",
        "observedAt": observed_at.clone(),
        "hashAlgorithm": hash_algorithm
    }));
    verify_fl402_proof(&challenge, &proof, &config.root_key, None)
        .map_err(|error| payment_error(&error.to_string()))?;
    fl402_proof_to_credential(&proof, &challenge_id, &resource_hash, &observed_at)
        .map(Some)
        .map_err(|error| payment_error(&error.to_string()))
}

fn parse_l402_authorization(header: Option<&str>) -> Result<Option<(String, String)>, ServerError> {
    let Some(header) = header else {
        return Ok(None);
    };
    let mut parts = header.trim().splitn(2, char::is_whitespace);
    if parts.next() != Some("L402") {
        return Ok(None);
    }
    let Some(credentials) = parts.next() else {
        return Err(payment_error("invalid-l402-authorization"));
    };
    let mut credentials = credentials.split(':');
    let macaroon = credentials
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| payment_error("invalid-l402-authorization"))?;
    let preimage = credentials
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| payment_error("invalid-l402-authorization"))?;
    if credentials.next().is_some() {
        return Err(payment_error("invalid-l402-authorization"));
    }
    Ok(Some((macaroon.to_string(), preimage.to_string())))
}

fn fl402_challenge_from_payment_challenge(
    config: &Fl402GatewayConfig,
    challenge: &Value,
    resource_hash: &str,
) -> Result<Value, ServerError> {
    let method = find_method(challenge, "fiber").ok_or_else(|| payment_error("wrong-method"))?;
    let resource = challenge.get("resource").ok_or(ServerError::Config(
        "challenge missing resource".to_string(),
    ))?;
    let challenge_id = required_string(challenge, "challengeId")?;
    let caveats = strip_nulls(json!({
        "challengeId": challenge_id.clone(),
        "resourceHash": resource_hash,
        "method": required_string(resource, "method")?,
        "url": required_string(resource, "url")?,
        "amount": required_string(method, "amountShannons")?,
        "currency": required_string(method, "asset")?,
        "paymentHash": required_string(method, "paymentHash")?,
        "invoice": required_string(method, "invoice")?,
        "expiresAt": required_string(method, "expiresAt")?,
        "issuer": challenge.get("serverId").and_then(Value::as_str),
        "fiberNodeId": method.get("fiberNodeId").and_then(Value::as_str),
        "hashAlgorithm": config.hash_algorithm.clone()
    }));
    let payload = json!({
        "domain": "fl402-macaroon-v1",
        "caveats": caveats,
        "nonce": random_hex(16),
        "issuedAt": required_string(challenge, "issuedAt")?
    });
    let macaroon = issue_fl402_macaroon(&payload, &config.root_key)?;
    Ok(strip_nulls(json!({
        "challengeId": challenge_id,
        "macaroon": macaroon,
        "invoice": required_string(method, "invoice")?,
        "paymentHash": required_string(method, "paymentHash")?,
        "amount": required_string(method, "amountShannons")?,
        "currency": required_string(method, "asset")?,
        "expiresAt": required_string(method, "expiresAt")?,
        "resource": required_string(resource, "url")?,
        "resourceHash": resource_hash,
        "issuer": challenge.get("serverId").and_then(Value::as_str),
        "fiberNodeId": method.get("fiberNodeId").and_then(Value::as_str),
        "hashAlgorithm": config.hash_algorithm.clone()
    })))
}

fn l402_www_authenticate_header(fl402: &Value) -> Result<String, ServerError> {
    Ok(format!(
        r#"L402 macaroon="{}", invoice="{}", payment_hash="{}", amount="{}", currency="{}""#,
        required_string(fl402, "macaroon")?,
        required_string(fl402, "invoice")?,
        required_string(fl402, "paymentHash")?,
        required_string(fl402, "amount")?,
        required_string(fl402, "currency")?
    ))
}

fn www_authenticate_header(signed: &Value) -> Result<String, ServerError> {
    let challenge = signed.get("challenge").ok_or(ServerError::Config(
        "signed challenge missing challenge".to_string(),
    ))?;
    let challenge_id = required_string(challenge, "challengeId")?;
    let methods = challenge
        .get("methods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| method.get("method").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|| "fiber".to_string());
    Ok(format!(
        r#"Payment id="{challenge_id}", method="fiber", methods="{methods}", intent="charge", challenge="{}""#,
        encode_json(signed)?
    ))
}

fn payment_string(value: &Value, field: &'static str, code: &str) -> Result<String, ServerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| payment_error(code))
}

fn find_method<'a>(challenge: &'a Value, name: &str) -> Option<&'a Value> {
    challenge
        .get("methods")?
        .as_array()?
        .iter()
        .find(|method| method.get("method").and_then(Value::as_str) == Some(name))
}

fn verify_fiber_proof_shape(
    challenge: &Value,
    proof: &Value,
    mode: &str,
) -> Result<(), ServerError> {
    if required_string(proof, "kind")? != "fiber-payment-proof-v1" {
        return Err(payment_error("invalid-fiber-proof"));
    }
    if required_string(proof, "mode")? != mode {
        return Err(payment_error("wrong-fiber-mode"));
    }
    if required_string(proof, "paymentHash")? != required_string(challenge, "paymentHash")? {
        return Err(payment_error("wrong-payment-hash"));
    }
    if let (Ok(expected), Ok(actual)) = (
        required_string(challenge, "amountShannons"),
        required_string(proof, "amountShannons"),
    ) {
        if expected != actual {
            return Err(payment_error("wrong-amount"));
        }
    }
    Ok(())
}

fn assert_not_expired(challenge: &Value) -> Result<(), ServerError> {
    let expires_at = DateTime::parse_from_rfc3339(&required_string(challenge, "expiresAt")?)
        .map_err(|_| payment_error("expired-challenge"))?
        .with_timezone(&Utc);
    if expires_at < Utc::now() {
        return Err(payment_error("expired-challenge"));
    }
    Ok(())
}

fn required_string(value: &Value, field: &str) -> Result<String, ServerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| ServerError::Config(format!("missing {field}")))
}

fn encode_json(value: &Value) -> Result<String, ServerError> {
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(value)?))
}

fn decode_json(token: &str) -> Result<Value, ServerError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| payment_error("invalid-authorization"))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}_{}", random_hex(16))
}

fn random_hex(len: usize) -> String {
    let mut bytes = vec![0_u8; len];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn expiry_seconds_from_now(expires_at: &str) -> u64 {
    DateTime::parse_from_rfc3339(expires_at)
        .map(|expires_at| {
            let millis = (expires_at.with_timezone(&Utc) - Utc::now())
                .num_milliseconds()
                .max(1000);
            ((millis + 999) / 1000) as u64
        })
        .unwrap_or(120)
}

fn strip_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key, strip_nulls(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(strip_nulls).collect()),
        other => other,
    }
}

fn payment_error(code: &str) -> ServerError {
    ServerError::Payment {
        code: code.to_string(),
        status: StatusCode::PAYMENT_REQUIRED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use serde_json::json;
    use tempfile::tempdir;
    use tower::ServiceExt;

    const PAYMENT_PREIMAGE: &str =
        "0x1111111111111111111111111111111111111111111111111111111111111111";
    const PAYMENT_HASH: &str = "0x02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc";
    const INVOICE: &str = "fibd1qrustgatewayfixture";

    #[derive(Clone)]
    struct FixtureFiber;

    impl GatewayFiber for FixtureFiber {
        fn create_challenge(&self, input: FiberChallengeInput) -> BoxGatewayFuture<Value> {
            Box::pin(async move {
                Ok(json!({
                    "method": "fiber",
                    "intent": "charge",
                    "asset": "CKB",
                    "amountShannons": input.amount_shannons,
                    "paymentHash": PAYMENT_HASH,
                    "invoice": INVOICE,
                    "fiberRpcLabel": "fixture-fiber",
                    "expiresAt": input.expires_at
                }))
            })
        }

        fn verify_paid(&self, challenge: Value, proof: Value) -> BoxGatewayFuture<Value> {
            Box::pin(async move {
                verify_fiber_proof_shape(&challenge, &proof, "local")?;
                Ok(json!({
                    "status": "settled",
                    "paymentHash": PAYMENT_HASH,
                    "invoiceId": INVOICE,
                    "provider": "fixture-fiber",
                    "observedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                }))
            })
        }
    }

    #[derive(Clone)]
    struct FixtureUpstream;

    impl UpstreamClient for FixtureUpstream {
        fn call(
            &self,
            _request: UpstreamRequest,
            _upstream_base: String,
        ) -> BoxGatewayFuture<UpstreamResponse> {
            Box::pin(async move {
                Ok(UpstreamResponse {
                    status: StatusCode::OK,
                    headers: HeaderMap::new(),
                    body: serde_json::to_vec(&json!({ "ok": true })).unwrap(),
                })
            })
        }
    }

    #[tokio::test]
    async fn rust_gateway_issues_signed_challenge_accepts_payment_and_rejects_replay() {
        let (app, config, _dir) = test_app();
        let unpaid = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/paid")
                    .header("host", "rust.local")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unpaid.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(
            unpaid.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
        let body = to_bytes(unpaid.into_body(), DEFAULT_BODY_LIMIT_BYTES)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        let challenge = body.get("challenge").unwrap();
        let challenge_id = required_string(challenge, "challengeId").unwrap();
        let resource_hash = resource_hash(challenge.get("resource").unwrap()).unwrap();
        let credential = json!({
            "domain": "fiber-paid-http-credential-v1",
            "challengeId": challenge_id,
            "method": "fiber",
            "resourceHash": resource_hash,
            "paymentProof": {
                "kind": "fiber-payment-proof-v1",
                "mode": "local",
                "paymentHash": PAYMENT_HASH,
                "invoice": INVOICE,
                "amountShannons": "1000",
                "status": "settled",
                "observedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            },
            "submittedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        let auth = format!("Payment {}", encode_json(&credential).unwrap());
        let paid = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/paid")
                    .header("host", "rust.local")
                    .header(header::AUTHORIZATION, auth.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(paid.status(), StatusCode::OK);
        assert!(paid
            .headers()
            .get(HeaderName::from_static("payment-receipt"))
            .is_some());

        let replay = app
            .oneshot(
                Request::builder()
                    .uri("/paid")
                    .header("host", "rust.local")
                    .header(header::AUTHORIZATION, auth)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::PAYMENT_REQUIRED);

        let store = SqliteStore::open(config.storage_path).unwrap();
        let receipt_count: i64 = store
            .get_receipt(
                required_string(
                    &decode_json(
                        paid.headers()
                            .get(HeaderName::from_static("payment-receipt"))
                            .unwrap()
                            .to_str()
                            .unwrap(),
                    )
                    .unwrap(),
                    "receiptId",
                )
                .unwrap()
                .as_str(),
            )
            .unwrap()
            .map(|_| 1)
            .unwrap_or(0);
        assert_eq!(receipt_count, 1);
    }

    #[tokio::test]
    async fn rust_gateway_accepts_fl402_l402_authorization() {
        let (app, _config, _dir) = test_app();
        let unpaid = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/paid")
                    .header("host", "rust.local")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unpaid.status(), StatusCode::PAYMENT_REQUIRED);
        assert!(unpaid
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("L402 "));
        let body = to_bytes(unpaid.into_body(), DEFAULT_BODY_LIMIT_BYTES)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        let fl402 = body.get("fl402").unwrap();
        assert_eq!(
            required_string(fl402, "challengeId").unwrap(),
            required_string(body.get("challenge").unwrap(), "challengeId").unwrap()
        );
        let auth = format!(
            "L402 {}:{}",
            required_string(fl402, "macaroon").unwrap(),
            PAYMENT_PREIMAGE
        );
        let paid = app
            .oneshot(
                Request::builder()
                    .uri("/paid")
                    .header("host", "rust.local")
                    .header(header::AUTHORIZATION, auth)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(paid.status(), StatusCode::OK);
        let receipt = decode_json(
            paid.headers()
                .get(HeaderName::from_static("payment-receipt"))
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["settlement"]["paymentHash"], PAYMENT_HASH);
    }

    #[tokio::test]
    async fn inspect_config_reports_production_gateway_features() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("gateway.json");
        fs::write(
            &config_path,
            serde_json::to_string(&json!({
                "listen": "127.0.0.1:0",
                "storage": "sqlite://store.sqlite",
                "upstream": "http://upstream.local",
                "server_id": "rust-test"
            }))
            .unwrap(),
        )
        .unwrap();
        let report = inspect_config(config_path).unwrap();
        assert_eq!(
            report.get("production_gateway").and_then(Value::as_bool),
            Some(true)
        );
    }

    fn test_app() -> (Router, GatewayConfig, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let storage_path = dir.path().join("gateway.sqlite").display().to_string();
        let config = GatewayConfig {
            server_id: "rust-test".to_string(),
            upstream: "http://upstream.local".to_string(),
            price: AmountConfig {
                value: "1".to_string(),
                currency: "CKB".to_string(),
                display: None,
            },
            secret: "rust-gateway-secret-at-least-32-chars".to_string(),
            previous_secrets: vec![],
            storage_path: storage_path.clone(),
            challenge_ttl_seconds: 120,
            default_fiber_amount_shannons: "1000".to_string(),
            body_limit_bytes: DEFAULT_BODY_LIMIT_BYTES,
            fiber_mode: "local".to_string(),
            fl402: Some(Fl402GatewayConfig {
                root_key: "rust-fl402-root-key-at-least-16".to_string(),
                hash_algorithm: "sha256".to_string(),
            }),
        };
        let store = SqliteStore::open(&storage_path).unwrap();
        let state = GatewayState::for_test(
            config.clone(),
            store,
            Arc::new(FixtureFiber),
            Arc::new(FixtureUpstream),
        );
        (gateway_router_with_state(state), config, dir)
    }
}
