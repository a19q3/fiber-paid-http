use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::time::Duration;
use thiserror::Error;

pub const NEW_INVOICE_METHOD: &str = "new_invoice";
pub const SEND_PAYMENT_METHOD: &str = "send_payment";
pub const GET_PAYMENT_METHOD: &str = "get_payment";
pub const GET_INVOICE_METHOD: &str = "get_invoice";

#[derive(Debug, Error)]
pub enum FiberRpcError {
    #[error("invalid decimal quantity")]
    InvalidQuantity,
    #[error("invalid invoice hash algorithm")]
    InvalidHashAlgorithm,
    #[error("missing payment hash")]
    MissingPaymentHash,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("fiber rpc {method} failed: {message}")]
    Rpc { method: String, message: String },
    #[error("fiber rpc {method} response did not include result")]
    MissingResult { method: String },
    #[error("invalid settlement polling configuration")]
    InvalidPollingConfig,
    #[error("fiber invoice reached terminal status {0}")]
    InvoiceTerminal(String),
    #[error("timed out waiting for Fiber invoice to reach Paid; last status {last_status}")]
    InvoiceTimeout { last_status: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiberRpcSemantics {
    pub invoice_creation_method: &'static str,
    pub payment_send_method: &'static str,
    pub payment_status_method: &'static str,
    pub invoice_status_method: &'static str,
    pub numeric_encoding: &'static str,
    pub payment_success_status: &'static str,
    pub invoice_paid_status: &'static str,
}

pub fn live_proven_semantics() -> FiberRpcSemantics {
    FiberRpcSemantics {
        invoice_creation_method: NEW_INVOICE_METHOD,
        payment_send_method: SEND_PAYMENT_METHOD,
        payment_status_method: GET_PAYMENT_METHOD,
        invoice_status_method: GET_INVOICE_METHOD,
        numeric_encoding: "hex-json-quantity",
        payment_success_status: "Success",
        invoice_paid_status: "Paid",
    }
}

pub fn to_fiber_hex_quantity(value: &str) -> Result<String, FiberRpcError> {
    let parsed = value
        .parse::<u128>()
        .map_err(|_| FiberRpcError::InvalidQuantity)?;
    Ok(format!("0x{parsed:x}"))
}

pub fn new_invoice_params(
    amount: &str,
    currency: &str,
    expiry_seconds: Option<u64>,
    hash_algorithm: Option<&str>,
) -> Result<Value, FiberRpcError> {
    let mut params = json!({
        "amount": to_fiber_hex_quantity(amount)?,
        "currency": currency
    });
    if let Some(expiry) = expiry_seconds {
        params["expiry"] = Value::String(format!("0x{expiry:x}"));
    }
    if let Some(hash_algorithm) = hash_algorithm {
        if !matches!(hash_algorithm, "ckb_hash" | "sha256") {
            return Err(FiberRpcError::InvalidHashAlgorithm);
        }
        params["hash_algorithm"] = Value::String(hash_algorithm.to_string());
    }
    Ok(params)
}

pub fn send_payment_params(invoice: &str, timeout_seconds: Option<u64>) -> Value {
    let mut params = json!({ "invoice": invoice });
    if let Some(timeout) = timeout_seconds {
        params["timeout"] = Value::String(format!("0x{timeout:x}"));
    }
    params
}

pub fn get_payment_params(payment_hash: &str) -> Value {
    json!({ "payment_hash": payment_hash })
}

pub fn get_invoice_params(payment_hash: &str) -> Value {
    json!({ "payment_hash": payment_hash })
}

pub fn is_payment_success_status(status: &str) -> bool {
    status == "Success"
}

pub fn is_invoice_paid_status(status: &str) -> bool {
    status == "Paid"
}

pub fn is_invoice_pending_status(status: &str) -> bool {
    matches!(status, "Open" | "Received")
}

pub fn is_invoice_terminal_status(status: &str) -> bool {
    matches!(status, "Cancelled" | "Expired")
}

pub async fn wait_for_invoice_paid(
    rpc: &FiberRpcClient,
    payment_hash: &str,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<Value, FiberRpcError> {
    wait_for_invoice_paid_with(|| rpc.get_invoice(payment_hash), timeout, poll_interval).await
}

pub async fn wait_for_invoice_paid_with<F, Fut>(
    mut get_invoice: F,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<Value, FiberRpcError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Value, FiberRpcError>>,
{
    if timeout.is_zero() || poll_interval.is_zero() || poll_interval > timeout {
        return Err(FiberRpcError::InvalidPollingConfig);
    }
    let started = tokio::time::Instant::now();
    let mut last_status = "unknown".to_string();
    loop {
        let invoice = get_invoice().await?;
        let status = invoice
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        last_status.clear();
        last_status.push_str(status);
        if is_invoice_paid_status(status) {
            return Ok(invoice);
        }
        if is_invoice_terminal_status(status) {
            return Err(FiberRpcError::InvoiceTerminal(status.to_string()));
        }
        if started.elapsed() >= timeout {
            return Err(FiberRpcError::InvoiceTimeout { last_status });
        }
        tokio::time::sleep(poll_interval).await;
    }
}

pub fn extract_invoice_payment_hash(invoice: &Value) -> Result<String, FiberRpcError> {
    invoice
        .get("invoice")
        .and_then(|invoice| invoice.get("data"))
        .and_then(|data| data.get("payment_hash"))
        .and_then(Value::as_str)
        .or_else(|| invoice.get("payment_hash").and_then(Value::as_str))
        .map(ToString::to_string)
        .ok_or(FiberRpcError::MissingPaymentHash)
}

#[derive(Debug, Clone)]
pub struct FiberRpcClient {
    url: String,
    auth: Option<String>,
    client: reqwest::Client,
}

impl FiberRpcClient {
    pub fn new(url: impl Into<String>, auth: Option<String>) -> Self {
        Self {
            url: url.into(),
            auth,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn request(&self, method: &str, params: Vec<Value>) -> Result<Value, FiberRpcError> {
        let mut request = self.client.post(&self.url).json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }));
        if let Some(auth) = &self.auth {
            request = request.header(reqwest::header::AUTHORIZATION, auth);
        }
        let payload: Value = request.send().await?.error_for_status()?.json().await?;
        if let Some(error) = payload.get("error") {
            return Err(FiberRpcError::Rpc {
                method: method.to_string(),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| error.to_string()),
            });
        }
        payload
            .get("result")
            .cloned()
            .ok_or_else(|| FiberRpcError::MissingResult {
                method: method.to_string(),
            })
    }

    pub async fn new_invoice(
        &self,
        amount: &str,
        currency: &str,
        expiry_seconds: Option<u64>,
        hash_algorithm: Option<&str>,
    ) -> Result<Value, FiberRpcError> {
        self.request(
            NEW_INVOICE_METHOD,
            vec![new_invoice_params(
                amount,
                currency,
                expiry_seconds,
                hash_algorithm,
            )?],
        )
        .await
    }

    pub async fn get_invoice(&self, payment_hash: &str) -> Result<Value, FiberRpcError> {
        self.request(GET_INVOICE_METHOD, vec![get_invoice_params(payment_hash)])
            .await
    }

    pub async fn send_payment(
        &self,
        invoice: &str,
        timeout_seconds: Option<u64>,
    ) -> Result<Value, FiberRpcError> {
        self.request(
            SEND_PAYMENT_METHOD,
            vec![send_payment_params(invoice, timeout_seconds)],
        )
        .await
    }

    pub async fn get_payment(&self, payment_hash: &str) -> Result<Value, FiberRpcError> {
        self.request(GET_PAYMENT_METHOD, vec![get_payment_params(payment_hash)])
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[test]
    fn encodes_hex_quantities() {
        assert_eq!(to_fiber_hex_quantity("100").unwrap(), "0x64");
        assert_eq!(
            new_invoice_params("100", "Fibt", Some(120), Some("sha256")).unwrap(),
            json!({
                "amount": "0x64",
                "currency": "Fibt",
                "expiry": "0x78",
                "hash_algorithm": "sha256"
            })
        );
    }

    #[test]
    fn exposes_live_proven_method_names() {
        let semantics = live_proven_semantics();
        assert_eq!(semantics.invoice_creation_method, "new_invoice");
        assert_eq!(semantics.payment_send_method, "send_payment");
        assert_eq!(semantics.payment_status_method, "get_payment");
        assert_eq!(semantics.invoice_status_method, "get_invoice");
    }

    #[tokio::test]
    async fn polls_open_received_then_paid() {
        let statuses = Arc::new(Mutex::new(VecDeque::from(["Open", "Received", "Paid"])));
        let result = wait_for_invoice_paid_with(
            {
                let statuses = Arc::clone(&statuses);
                move || {
                    let status = statuses.lock().unwrap().pop_front().unwrap_or("Paid");
                    async move { Ok(json!({ "status": status })) }
                }
            },
            Duration::from_millis(100),
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "Paid");
    }

    #[tokio::test]
    async fn rejects_terminal_invoice_status() {
        let error = wait_for_invoice_paid_with(
            || async { Ok(json!({ "status": "Expired" })) },
            Duration::from_millis(100),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, FiberRpcError::InvoiceTerminal(status) if status == "Expired"));
    }

    #[tokio::test]
    async fn rejects_invalid_polling_configuration() {
        let error = wait_for_invoice_paid_with(
            || async { Ok(json!({ "status": "Open" })) },
            Duration::ZERO,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, FiberRpcError::InvalidPollingConfig));
    }
}
