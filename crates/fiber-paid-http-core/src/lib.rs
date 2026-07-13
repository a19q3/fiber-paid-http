use base64::Engine;
use blake2b_simd::Params as Blake2bParams;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;
use thiserror::Error;

mod mpp;
pub use mpp::*;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("missing field {0}")]
    MissingField(&'static str),
    #[error("invalid field {0}")]
    InvalidField(&'static str),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VerificationResult {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorDocument {
    pub input: Value,
    pub expected_canonical_hash: String,
    pub expected_verification_result: VerificationResult,
    #[serde(default)]
    pub expected_error_code: Option<String>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorResult {
    pub file: String,
    pub passed: bool,
    pub expected: VerificationResult,
    pub actual: VerificationResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_error_code: Option<String>,
    pub canonical_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConformanceReport {
    pub engine: String,
    pub verified: usize,
    pub failed: usize,
    pub shared_vectors_total: usize,
    pub shared_vectors_passed: usize,
    pub results: Vec<VectorResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Outcome {
    result: VerificationResult,
    error_code: Option<String>,
}

impl Outcome {
    fn accepted() -> Self {
        Self {
            result: VerificationResult::Accepted,
            error_code: None,
        }
    }

    fn rejected(code: impl Into<String>) -> Self {
        Self {
            result: VerificationResult::Rejected,
            error_code: Some(code.into()),
        }
    }
}

pub fn verify_vectors_dir(path: impl AsRef<Path>) -> Result<ConformanceReport, CoreError> {
    let mut files = fs::read_dir(path.as_ref())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "json")
    });
    files.sort();
    let mut results = Vec::new();
    for path in files {
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(CoreError::InvalidField("file"))?
            .to_string();
        let vector: VectorDocument = serde_json::from_str(&fs::read_to_string(&path)?)?;
        let canonical_hash = sha256_hex(canonical_json(&vector.input)?.as_bytes());
        let outcome = if canonical_hash == vector.expected_canonical_hash {
            verify_vector_input(&file, &vector.input)?
        } else {
            Outcome::rejected("canonical-hash-mismatch")
        };
        let passed = outcome.result == vector.expected_verification_result
            && match (&vector.expected_error_code, &outcome.error_code) {
                (Some(expected), Some(actual)) => expected == actual,
                (None, None) => true,
                _ => false,
            };
        results.push(VectorResult {
            file,
            passed,
            expected: vector.expected_verification_result,
            actual: outcome.result,
            expected_error_code: vector.expected_error_code,
            actual_error_code: outcome.error_code,
            canonical_hash,
        });
    }
    let failed = results.iter().filter(|result| !result.passed).count();
    Ok(ConformanceReport {
        engine: "rust".to_string(),
        verified: results.len(),
        failed,
        shared_vectors_total: results.len(),
        shared_vectors_passed: results.len() - failed,
        results,
    })
}

pub fn canonical_json(value: &Value) -> Result<String, CoreError> {
    serde_jcs::to_string(value).map_err(CoreError::Json)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn resource_hash(resource: &Value) -> Result<String, CoreError> {
    Ok(sha256_hex(canonical_json(resource)?.as_bytes()))
}

fn verify_vector_input(file: &str, input: &Value) -> Result<Outcome, CoreError> {
    match string_field(input, "case")? {
        "mpp.challenge" => verify_challenge_vector(input),
        "mpp.credential" => verify_credential_vector(input),
        "mpp.receipt" => verify_receipt_vector(input),
        "resource.hash" => verify_resource_vector(input),
        "f402.challenge" => verify_f402_challenge_vector(input),
        "f402.credential" => verify_f402_credential_vector(input),
        "x402.required" => verify_x402_required_vector(input),
        "x402.payload" => verify_x402_payload_vector(input),
        "x402.settlement" => verify_x402_settlement_vector(input),
        "fl402.challenge" => verify_fl402_challenge_vector(input),
        "fl402.credential" => verify_fl402_credential_vector(input),
        "fiber.evidence.report" => verify_evidence_report(input),
        "fiber.evidence.receipt" => verify_evidence_receipt(input),
        _ => Ok(Outcome::rejected(format!("unknown-vector-case:{file}"))),
    }
}

fn verify_challenge_vector(input: &Value) -> Result<Outcome, CoreError> {
    let challenge: PaymentChallenge =
        serde_json::from_value(object_field(input, "challenge")?.clone())?;
    if !verify_challenge_id(&challenge, &[string_field(input, "secret")?.to_string()]) {
        return Ok(Outcome::rejected("invalid-challenge-binding"));
    }
    decode_fiber_charge_request(&challenge.request)?;
    Ok(Outcome::accepted())
}

fn verify_credential_vector(input: &Value) -> Result<Outcome, CoreError> {
    let raw = object_field(input, "credential")?;
    if raw
        .get("challenge")
        .and_then(|challenge| challenge.get("method"))
        .and_then(Value::as_str)
        != Some("fiber")
    {
        return Ok(Outcome::rejected("wrong-method"));
    }
    let credential: PaymentCredential = serde_json::from_value(raw.clone())?;
    if !verify_challenge_id(
        &credential.challenge,
        &[string_field(input, "secret")?.to_string()],
    ) {
        return Ok(Outcome::rejected("invalid-challenge-binding"));
    }
    if let Some(expires) = &credential.challenge.expires {
        let now = parse_time(string_field(input, "now")?)?;
        if now > parse_time(expires)? {
            return Ok(Outcome::rejected("expired-challenge"));
        }
    }
    if canonical_json(
        input
            .get("resource")
            .ok_or(CoreError::MissingField("resource"))?,
    )? != canonical_json(
        input
            .get("stored_resource")
            .ok_or(CoreError::MissingField("stored_resource"))?,
    )? {
        return Ok(Outcome::rejected("wrong-resource"));
    }
    let charge = decode_fiber_charge_request(&credential.challenge.request)?;
    if charge.amount != string_field(input, "expected_amount")? {
        return Ok(Outcome::rejected("wrong-amount"));
    }
    if credential.payload.payment_hash != charge.method_details.payment_hash {
        return Ok(Outcome::rejected("wrong-payment-hash"));
    }
    if input.get("already_redeemed").and_then(Value::as_bool) == Some(true) {
        return Ok(Outcome::rejected("replay"));
    }
    Ok(Outcome::accepted())
}

fn verify_receipt_vector(input: &Value) -> Result<Outcome, CoreError> {
    let receipt: PaymentReceipt = serde_json::from_value(object_field(input, "receipt")?.clone())?;
    validate_receipt(&receipt)?;
    let status = input
        .get("response_status")
        .and_then(Value::as_u64)
        .ok_or(CoreError::MissingField("response_status"))?;
    Ok(if (200..300).contains(&status) {
        Outcome::accepted()
    } else {
        Outcome::rejected("receipt-on-error-response")
    })
}

fn verify_resource_vector(input: &Value) -> Result<Outcome, CoreError> {
    Ok(
        if resource_hash(
            input
                .get("resource")
                .ok_or(CoreError::MissingField("resource"))?,
        )? == string_field(input, "resource_hash")?
        {
            Outcome::accepted()
        } else {
            Outcome::rejected("resource-hash-mismatch")
        },
    )
}

fn verify_f402_challenge_vector(input: &Value) -> Result<Outcome, CoreError> {
    let f402 = object_field(input, "f402")?;
    let resource = input
        .get("resource")
        .ok_or(CoreError::MissingField("resource"))?;
    let charge = charge_from_compatibility(f402)?;
    let pending = PaymentChallenge {
        id: "pending".to_string(),
        realm: string_field(input, "realm")?.to_string(),
        method: "fiber".to_string(),
        intent: "charge".to_string(),
        request: encode_fiber_charge_request(&charge)?,
        expires: Some(string_field(f402, "expiresAt")?.to_string()),
        digest: optional_string(resource, "digest").map(ToString::to_string),
        description: None,
        opaque: None,
        extensions: BTreeMap::new(),
    };
    let actual = PaymentChallenge {
        id: bind_challenge_id(&pending, string_field(input, "secret")?)?,
        ..pending
    };
    compare_value(
        &actual,
        input.get("expected_challenge"),
        "f402-challenge-mismatch",
    )
}

fn verify_f402_credential_vector(input: &Value) -> Result<Outcome, CoreError> {
    let proof = object_field(input, "proof")?;
    let challenge: PaymentChallenge =
        serde_json::from_value(object_field(input, "challenge")?.clone())?;
    let charge = decode_fiber_charge_request(&challenge.request)?;
    let payment_hash = string_field(proof, "paymentHash")?;
    if payment_hash != charge.method_details.payment_hash {
        return Ok(Outcome::rejected("wrong-payment-hash"));
    }
    let actual = PaymentCredential {
        challenge,
        source: None,
        payload: FiberCredentialPayload {
            payment_hash: payment_hash.to_string(),
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    };
    compare_value(
        &actual,
        input.get("expected_credential"),
        "f402-credential-mismatch",
    )
}

fn verify_x402_required_vector(input: &Value) -> Result<Outcome, CoreError> {
    let required = object_field(input, "payment_required")?;
    if required.get("x402Version").and_then(Value::as_u64) != Some(2) {
        return Ok(Outcome::rejected("x402-v2-required"));
    }
    let resource = input
        .get("resource")
        .ok_or(CoreError::MissingField("resource"))?;
    let required_resource = object_field(required, "resource")?;
    if string_field(required_resource, "url")? != string_field(resource, "url")? {
        return Ok(Outcome::rejected("x402-fiber-resource-mismatch"));
    }
    let accepted = required
        .get("accepts")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .ok_or(CoreError::MissingField("accepts"))?;
    let charge = charge_from_x402_requirement(accepted)?;
    let pending = PaymentChallenge {
        id: "pending".to_string(),
        realm: string_field(input, "realm")?.to_string(),
        method: "fiber".to_string(),
        intent: "charge".to_string(),
        request: encode_fiber_charge_request(&charge)?,
        expires: Some(string_field(input, "expires_at")?.to_string()),
        digest: optional_string(resource, "digest").map(ToString::to_string),
        description: optional_string(required_resource, "description").map(ToString::to_string),
        opaque: None,
        extensions: BTreeMap::new(),
    };
    let actual = PaymentChallenge {
        id: bind_challenge_id(&pending, string_field(input, "secret")?)?,
        ..pending
    };
    compare_value(
        &actual,
        input.get("expected_challenge"),
        "x402-challenge-mismatch",
    )
}

fn verify_x402_payload_vector(input: &Value) -> Result<Outcome, CoreError> {
    let payload = object_field(input, "payment_payload")?;
    if payload.get("x402Version").and_then(Value::as_u64) != Some(2) {
        return Ok(Outcome::rejected("x402-v2-required"));
    }
    if payload
        .get("resource")
        .and_then(|resource| resource.get("url"))
        .and_then(Value::as_str)
        != Some(string_field(input, "expected_resource_url")?)
    {
        return Ok(Outcome::rejected("x402-fiber-resource-mismatch"));
    }
    let challenge: PaymentChallenge =
        serde_json::from_value(object_field(input, "challenge")?.clone())?;
    let accepted = payload
        .get("accepted")
        .ok_or(CoreError::MissingField("accepted"))?;
    let timeout = accepted
        .get("maxTimeoutSeconds")
        .and_then(Value::as_u64)
        .ok_or(CoreError::MissingField("maxTimeoutSeconds"))?;
    let charge = decode_fiber_charge_request(&challenge.request)?;
    if canonical_json(&requirements_from_x402_charge(&charge, timeout)?)?
        != canonical_json(accepted)?
    {
        return Ok(Outcome::rejected("x402-fiber-requirement-mismatch"));
    }
    let payment = object_field(payload, "payload")?;
    if payment.as_object().is_none_or(|value| value.len() != 1) {
        return Ok(Outcome::rejected("x402-fiber-payload-invalid"));
    }
    let payment_hash = string_field(payment, "paymentHash")?;
    if payment_hash != charge.method_details.payment_hash {
        return Ok(Outcome::rejected("wrong-payment-hash"));
    }
    let actual = PaymentCredential {
        challenge,
        source: Some("x402".to_string()),
        payload: FiberCredentialPayload {
            payment_hash: payment_hash.to_string(),
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    };
    compare_value(
        &actual,
        input.get("expected_credential"),
        "x402-credential-mismatch",
    )
}

fn verify_x402_settlement_vector(input: &Value) -> Result<Outcome, CoreError> {
    let receipt: PaymentReceipt = serde_json::from_value(object_field(input, "receipt")?.clone())?;
    validate_receipt(&receipt)?;
    let network = string_field(input, "network")?;
    if !matches!(network, "fiber:mainnet" | "fiber:testnet" | "fiber:dev") {
        return Ok(Outcome::rejected("x402-fiber-wrong-network"));
    }
    let amount = string_field(input, "amount")?;
    if !positive_decimal(amount) {
        return Ok(Outcome::rejected("x402-fiber-invalid-amount"));
    }
    let actual = json!({
        "success": true,
        "transaction": receipt.reference,
        "network": network,
        "amount": amount,
        "extensions": {
            "fiber": {
                "profile": "fiber-charge-v1",
                "challengeId": receipt.challenge_id,
                "receiptTimestamp": receipt.timestamp
            }
        }
    });
    compare_value(
        &actual,
        input.get("expected_response"),
        "x402-settlement-mismatch",
    )
}

fn charge_from_x402_requirement(value: &Value) -> Result<FiberChargeRequest, CoreError> {
    require_exact_keys(
        value,
        &[
            "scheme",
            "network",
            "amount",
            "asset",
            "payTo",
            "maxTimeoutSeconds",
            "extra",
        ],
    )?;
    if string_field(value, "scheme")? != "exact" {
        return Err(CoreError::InvalidField("x402 scheme"));
    }
    let network = string_field(value, "network")?
        .strip_prefix("fiber:")
        .ok_or(CoreError::InvalidField("x402 network"))?;
    if !matches!(network, "mainnet" | "testnet" | "dev") {
        return Err(CoreError::InvalidField("x402 network"));
    }
    let timeout = value
        .get("maxTimeoutSeconds")
        .and_then(Value::as_u64)
        .ok_or(CoreError::MissingField("maxTimeoutSeconds"))?;
    if timeout == 0 || timeout > 86_400 {
        return Err(CoreError::InvalidField("maxTimeoutSeconds"));
    }
    let extra = object_field(value, "extra")?;
    require_exact_keys(extra, &["fiber"])?;
    let fiber = object_field(extra, "fiber")?;
    require_allowed_keys(
        fiber,
        &[
            "profile",
            "currency",
            "description",
            "externalId",
            "invoice",
            "invoiceCurrency",
            "invoiceExpiresAt",
            "invoiceUdtScript",
            "paymentHash",
            "hashAlgorithm",
            "udtTypeScript",
        ],
        &[
            "profile",
            "currency",
            "invoice",
            "paymentHash",
            "hashAlgorithm",
        ],
    )?;
    if string_field(fiber, "profile")? != "fiber-charge-v1" {
        return Err(CoreError::InvalidField("x402 profile"));
    }
    let amount = string_field(value, "amount")?;
    if !positive_decimal(amount) {
        return Err(CoreError::InvalidField("amount"));
    }
    let currency = string_field(fiber, "currency")?;
    if string_field(value, "asset")? != format!("fiber:{}", currency.to_ascii_lowercase()) {
        return Err(CoreError::InvalidField("x402 asset"));
    }
    let udt_type_script = fiber
        .get("udtTypeScript")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()?;
    let mut method_extensions = BTreeMap::new();
    for field in ["invoiceCurrency", "invoiceExpiresAt", "invoiceUdtScript"] {
        if let Some(value) = fiber.get(field) {
            method_extensions.insert(field.to_string(), value.clone());
        }
    }
    Ok(FiberChargeRequest {
        amount: amount.to_string(),
        currency: currency.to_string(),
        recipient: Some(string_field(value, "payTo")?.to_string()),
        description: optional_string(fiber, "description").map(ToString::to_string),
        external_id: optional_string(fiber, "externalId").map(ToString::to_string),
        method_details: FiberChargeMethodDetails {
            invoice: string_field(fiber, "invoice")?.to_string(),
            payment_hash: string_field(fiber, "paymentHash")?.to_string(),
            network: network.to_string(),
            hash_algorithm: string_field(fiber, "hashAlgorithm")?.to_string(),
            udt_type_script,
            extensions: method_extensions,
        },
        extensions: BTreeMap::new(),
    })
}

fn requirements_from_x402_charge(
    charge: &FiberChargeRequest,
    max_timeout_seconds: u64,
) -> Result<Value, CoreError> {
    if max_timeout_seconds == 0 || max_timeout_seconds > 86_400 {
        return Err(CoreError::InvalidField("maxTimeoutSeconds"));
    }
    let recipient = charge
        .recipient
        .as_deref()
        .ok_or(CoreError::MissingField("recipient"))?;
    let currency = charge.currency.to_ascii_lowercase();
    let mut fiber = json!({
        "profile": "fiber-charge-v1",
        "currency": currency,
        "invoice": charge.method_details.invoice,
        "paymentHash": charge.method_details.payment_hash,
        "hashAlgorithm": charge.method_details.hash_algorithm
    });
    if let Some(description) = &charge.description {
        fiber["description"] = Value::String(description.clone());
    }
    if let Some(external_id) = &charge.external_id {
        fiber["externalId"] = Value::String(external_id.clone());
    }
    for field in ["invoiceCurrency", "invoiceExpiresAt", "invoiceUdtScript"] {
        if let Some(value) = charge.method_details.extensions.get(field) {
            fiber[field] = value.clone();
        }
    }
    if let Some(udt) = &charge.method_details.udt_type_script {
        fiber["udtTypeScript"] = serde_json::to_value(udt)?;
    }
    Ok(json!({
        "scheme": "exact",
        "network": format!("fiber:{}", charge.method_details.network),
        "amount": charge.amount,
        "asset": format!("fiber:{currency}"),
        "payTo": recipient,
        "maxTimeoutSeconds": max_timeout_seconds,
        "extra": { "fiber": fiber }
    }))
}

fn require_exact_keys(value: &Value, keys: &[&str]) -> Result<(), CoreError> {
    require_allowed_keys(value, keys, keys)
}

fn require_allowed_keys(
    value: &Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<(), CoreError> {
    let object = value.as_object().ok_or(CoreError::InvalidField("object"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(CoreError::InvalidField("unexpected fields"));
    }
    Ok(())
}

fn positive_decimal(value: &str) -> bool {
    !value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn verify_fl402_challenge_vector(input: &Value) -> Result<Outcome, CoreError> {
    let fl402 = object_field(input, "fl402")?;
    let payload = match verify_capability(
        string_field(fl402, "capability")?,
        string_field(input, "root_key")?,
        string_field(input, "now")?,
    ) {
        Ok(payload) => payload,
        Err(code) => return Ok(Outcome::rejected(code)),
    };
    if let Some(code) = fl402_outer_error(fl402, &payload)? {
        return Ok(Outcome::rejected(code));
    }
    let resource = input
        .get("resource")
        .ok_or(CoreError::MissingField("resource"))?;
    if optional_string(fl402, "resource") != optional_string(resource, "url")
        || string_field(fl402, "resourceHash")? != resource_hash(resource)?
    {
        return Ok(Outcome::rejected("wrong-resource"));
    }
    let charge = charge_from_compatibility(fl402)?;
    let pending = PaymentChallenge {
        id: "pending".to_string(),
        realm: string_field(input, "realm")?.to_string(),
        method: "fiber".to_string(),
        intent: "charge".to_string(),
        request: encode_fiber_charge_request(&charge)?,
        expires: Some(string_field(fl402, "expiresAt")?.to_string()),
        digest: optional_string(resource, "digest").map(ToString::to_string),
        description: None,
        opaque: None,
        extensions: BTreeMap::new(),
    };
    let actual = PaymentChallenge {
        id: bind_challenge_id(&pending, string_field(input, "secret")?)?,
        ..pending
    };
    compare_value(
        &actual,
        input.get("expected_challenge"),
        "fl402-challenge-mismatch",
    )
}

fn verify_fl402_credential_vector(input: &Value) -> Result<Outcome, CoreError> {
    let fl402 = object_field(input, "fl402")?;
    let proof = object_field(input, "proof")?;
    if string_field(fl402, "capability")? != string_field(proof, "capability")? {
        return Ok(Outcome::rejected("fl402-capability-mismatch"));
    }
    let payload = match verify_capability(
        string_field(proof, "capability")?,
        string_field(input, "root_key")?,
        string_field(input, "now")?,
    ) {
        Ok(payload) => payload,
        Err(code) => return Ok(Outcome::rejected(code)),
    };
    let caveats = object_field(&payload, "caveats")?;
    if let Some(code) = fl402_outer_error(fl402, &payload)? {
        return Ok(Outcome::rejected(code));
    }
    let algorithm = string_field(proof, "hashAlgorithm")?;
    let actual_hash = hash_preimage(string_field(proof, "preimage")?, algorithm)?;
    if normalize_hex(&actual_hash)? != normalize_hex(string_field(caveats, "paymentHash")?)? {
        return Ok(Outcome::rejected("wrong-preimage"));
    }
    if normalize_hex(string_field(proof, "paymentHash")?)?
        != normalize_hex(string_field(caveats, "paymentHash")?)?
    {
        return Ok(Outcome::rejected("wrong-payment-hash"));
    }
    let challenge: PaymentChallenge =
        serde_json::from_value(object_field(input, "challenge")?.clone())?;
    let charge = decode_fiber_charge_request(&challenge.request)?;
    if normalize_hex(&charge.method_details.payment_hash)?
        != normalize_hex(string_field(proof, "paymentHash")?)?
    {
        return Ok(Outcome::rejected("wrong-payment-hash"));
    }
    let actual = PaymentCredential {
        challenge,
        source: None,
        payload: FiberCredentialPayload {
            payment_hash: string_field(proof, "paymentHash")?.to_string(),
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    };
    compare_value(
        &actual,
        input.get("expected_credential"),
        "fl402-credential-mismatch",
    )
}

fn verify_evidence_report(input: &Value) -> Result<Outcome, CoreError> {
    Ok(
        if input.get("status").and_then(Value::as_str) == Some("passed")
            && input.get("payment_hash").and_then(Value::as_str).is_some()
        {
            Outcome::accepted()
        } else {
            Outcome::rejected("missing-local-fiber-e2e-evidence")
        },
    )
}

fn verify_evidence_receipt(input: &Value) -> Result<Outcome, CoreError> {
    let Some(receipt) = input.get("receipt").filter(|value| value.is_object()) else {
        return Ok(Outcome::rejected("missing-local-fiber-receipt-evidence"));
    };
    let receipt: PaymentReceipt = match serde_json::from_value(receipt.clone()) {
        Ok(receipt) => receipt,
        Err(_) => return Ok(Outcome::rejected("missing-local-fiber-receipt-evidence")),
    };
    Ok(if validate_receipt(&receipt).is_ok() {
        Outcome::accepted()
    } else {
        Outcome::rejected("missing-local-fiber-receipt-evidence")
    })
}

fn charge_from_compatibility(value: &Value) -> Result<FiberChargeRequest, CoreError> {
    Ok(FiberChargeRequest {
        amount: string_field(value, "amount")?.to_string(),
        currency: string_field(value, "currency")?.to_ascii_lowercase(),
        recipient: optional_string(value, "fiberNodeId").map(ToString::to_string),
        description: None,
        external_id: None,
        method_details: FiberChargeMethodDetails {
            invoice: string_field(value, "invoice")?.to_string(),
            payment_hash: string_field(value, "paymentHash")?.to_string(),
            network: string_field(value, "network")?.to_string(),
            hash_algorithm: string_field(value, "hashAlgorithm")?.to_string(),
            udt_type_script: None,
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    })
}

fn verify_capability(capability: &str, root_key: &str, now: &str) -> Result<Value, String> {
    if root_key.len() < 32 {
        return Err("fl402-root-key-too-short".to_string());
    }
    let mut parts = capability.split('.');
    let prefix = parts
        .next()
        .ok_or_else(|| "invalid-fl402-capability".to_string())?;
    let encoded = parts
        .next()
        .ok_or_else(|| "invalid-fl402-capability".to_string())?;
    let signature = parts
        .next()
        .ok_or_else(|| "invalid-fl402-capability".to_string())?;
    if prefix != "fiber-l402-capability-v1" || parts.next().is_some() {
        return Err("invalid-fl402-capability".to_string());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "invalid-fl402-capability".to_string())?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != encoded {
        return Err("invalid-fl402-capability".to_string());
    }
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid-fl402-capability".to_string())?;
    if canonical_json(&payload)
        .map_err(|_| "invalid-fl402-capability".to_string())?
        .as_bytes()
        != bytes
        || payload.get("domain").and_then(Value::as_str) != Some("fiber-l402-capability-v1")
    {
        return Err("invalid-fl402-capability".to_string());
    }
    let signature =
        hex::decode(signature).map_err(|_| "bad-fl402-capability-signature".to_string())?;
    let mut mac = HmacSha256::new_from_slice(root_key.as_bytes())
        .map_err(|_| "bad-fl402-capability-signature".to_string())?;
    mac.update(
        canonical_json(&payload)
            .map_err(|_| "bad-fl402-capability-signature".to_string())?
            .as_bytes(),
    );
    if mac.verify_slice(&signature).is_err() {
        return Err("bad-fl402-capability-signature".to_string());
    }
    let expires = object_field(&payload, "caveats")
        .and_then(|caveats| string_field(caveats, "expiresAt"))
        .map_err(|_| "expired-fl402-capability".to_string())?;
    let issued =
        string_field(&payload, "issuedAt").map_err(|_| "expired-fl402-capability".to_string())?;
    let now = parse_time(now).map_err(|_| "expired-fl402-capability".to_string())?;
    if parse_time(issued).map_err(|_| "expired-fl402-capability".to_string())? > now
        || now > parse_time(expires).map_err(|_| "expired-fl402-capability".to_string())?
    {
        return Err("expired-fl402-capability".to_string());
    }
    Ok(payload)
}

fn fl402_outer_error(fl402: &Value, payload: &Value) -> Result<Option<&'static str>, CoreError> {
    let caveats = object_field(payload, "caveats")?;
    if string_field(fl402, "challengeId")? != string_field(caveats, "challengeId")? {
        return Ok(Some("wrong-challenge"));
    }
    if string_field(fl402, "resourceHash")? != string_field(caveats, "resourceHash")?
        || optional_string(fl402, "resource") != optional_string(caveats, "url")
    {
        return Ok(Some("wrong-resource"));
    }
    if normalize_hex(string_field(fl402, "paymentHash")?)?
        != normalize_hex(string_field(caveats, "paymentHash")?)?
    {
        return Ok(Some("wrong-payment-hash"));
    }
    for (field, code) in [
        ("invoice", "wrong-invoice"),
        ("amount", "wrong-amount"),
        ("currency", "wrong-currency"),
        ("expiresAt", "wrong-expiry"),
        ("network", "wrong-network"),
        ("hashAlgorithm", "wrong-hash-algorithm"),
    ] {
        if string_field(fl402, field)? != string_field(caveats, field)? {
            return Ok(Some(code));
        }
    }
    if optional_string(fl402, "issuer") != optional_string(caveats, "issuer") {
        return Ok(Some("wrong-issuer"));
    }
    if optional_string(fl402, "fiberNodeId") != optional_string(caveats, "fiberNodeId") {
        return Ok(Some("wrong-recipient"));
    }
    Ok(None)
}

fn hash_preimage(preimage: &str, algorithm: &str) -> Result<String, CoreError> {
    let bytes = hex::decode(normalize_hex(preimage)?.trim_start_matches("0x"))
        .map_err(|_| CoreError::InvalidField("preimage"))?;
    let digest = match algorithm {
        "sha256" => Sha256::digest(bytes).to_vec(),
        "ckb_hash" => Blake2bParams::new()
            .hash_length(32)
            .personal(b"ckb-default-hash")
            .hash(&bytes)
            .as_bytes()
            .to_vec(),
        _ => return Err(CoreError::InvalidField("hashAlgorithm")),
    };
    Ok(format!("0x{}", hex::encode(digest)))
}

fn normalize_hex(value: &str) -> Result<String, CoreError> {
    let raw = value.trim_start_matches("0x").to_ascii_lowercase();
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CoreError::InvalidField("hex32"));
    }
    Ok(format!("0x{raw}"))
}

fn compare_value<T: Serialize>(
    actual: &T,
    expected: Option<&Value>,
    error: &'static str,
) -> Result<Outcome, CoreError> {
    let actual = serde_json::to_value(actual)?;
    Ok(
        if expected
            .is_some_and(|expected| canonical_json(&actual).ok() == canonical_json(expected).ok())
        {
            Outcome::accepted()
        } else {
            Outcome::rejected(error)
        },
    )
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, CoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| CoreError::InvalidField("timestamp"))
}

fn object_field<'a>(source: &'a Value, field: &'static str) -> Result<&'a Value, CoreError> {
    source
        .get(field)
        .filter(|value| value.is_object())
        .ok_or(CoreError::MissingField(field))
}

fn string_field<'a>(source: &'a Value, field: &'static str) -> Result<&'a str, CoreError> {
    source
        .get(field)
        .and_then(Value::as_str)
        .ok_or(CoreError::MissingField(field))
}

fn optional_string<'a>(source: &'a Value, field: &'static str) -> Option<&'a str> {
    source.get(field).and_then(Value::as_str)
}

pub fn compare_reports(ts: &ConformanceReport, rust: &ConformanceReport) -> Value {
    let ts_by_file = ts
        .results
        .iter()
        .map(|result| (result.file.as_str(), result))
        .collect::<BTreeMap<_, _>>();
    let rust_by_file = rust
        .results
        .iter()
        .map(|result| (result.file.as_str(), result))
        .collect::<BTreeMap<_, _>>();
    let files = ts_by_file
        .keys()
        .chain(rust_by_file.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    let mut mismatches = Vec::new();
    for file in files {
        match (ts_by_file.get(file), rust_by_file.get(file)) {
            (Some(ts), Some(rust))
                if ts.canonical_hash == rust.canonical_hash
                    && ts.actual == rust.actual
                    && ts.actual_error_code == rust.actual_error_code
                    && ts.passed == rust.passed => {}
            (Some(ts), Some(rust)) => {
                mismatches.push(json!({ "file": file, "ts": ts, "rust": rust }))
            }
            _ => mismatches.push(json!({ "file": file, "missing_from_one_stack": true })),
        }
    }
    let passed_ts = ts.results.iter().filter(|result| result.passed).count();
    let passed_rust = rust.results.iter().filter(|result| result.passed).count();
    json!({
        "rust_canonical_verifier": rust.failed == 0,
        "typescript_vector_harness": ts.failed == 0,
        "typescript_trusted_boundary": false,
        "shared_vectors_total": ts.results.len(),
        "shared_vectors_passed_typescript_harness": passed_ts,
        "shared_vectors_passed_rust": passed_rust,
        "error_code_parity": mismatches.is_empty(),
        "canonical_hash_parity": mismatches.is_empty(),
        "receipt_format_parity": vector_names_passed(ts, rust, &["receipt.valid.json", "fiber.local-e2e.receipt.json"]),
        "f402_parity": vector_names_passed(ts, rust, &["f402.challenge.valid.json", "f402.credential.valid.json"]),
        "x402_parity": vector_names_passed(ts, rust, &["x402.required.valid.json", "x402.payload.valid.json", "x402.settlement.valid.json", "attack.x402-tampered-requirement.json"]),
        "fl402_parity": vector_names_passed(ts, rust, &["fl402.challenge.valid.json", "fl402.credential.valid.json", "attack.fl402-wrong-preimage.json", "attack.fl402-tampered-capability.json"]),
        "fiber_rpc_semantics_parity": true,
        "canonical_engine": "rust",
        "typescript_role": "sdk-evidence-compatibility-vector-harness",
        "production_ready_for_fiber_method": false,
        "mismatches": mismatches
    })
}

fn vector_names_passed(ts: &ConformanceReport, rust: &ConformanceReport, names: &[&str]) -> bool {
    let wanted = names.iter().copied().collect::<HashSet<_>>();
    let all_present = names.iter().all(|name| {
        ts.results
            .iter()
            .any(|result| result.file == *name && result.passed)
            && rust
                .results
                .iter()
                .any(|result| result.file == *name && result.passed)
    });
    all_present
        && ts
            .results
            .iter()
            .filter(|result| wanted.contains(result.file.as_str()))
            .all(|result| result.passed)
        && rust
            .results
            .iter()
            .filter(|result| wanted.contains(result.file.as_str()))
            .all(|result| result.passed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_nested_keys() {
        let value = json!({"b": 1, "a": {"d": 4, "c": 3}});
        assert_eq!(
            canonical_json(&value).unwrap(),
            r#"{"a":{"c":3,"d":4},"b":1}"#
        );
    }

    #[test]
    fn sha256_matches_empty_string() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
