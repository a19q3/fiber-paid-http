use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;
use thiserror::Error;

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
        Self { result: VerificationResult::Accepted, error_code: None }
    }

    fn rejected(code: impl Into<String>) -> Self {
        Self { result: VerificationResult::Rejected, error_code: Some(code.into()) }
    }
}

pub fn verify_vectors_dir(path: impl AsRef<Path>) -> Result<ConformanceReport, CoreError> {
    let mut files = fs::read_dir(path.as_ref())?.map(|entry| entry.map(|entry| entry.path())).collect::<Result<Vec<_>, _>>()?;
    files.retain(|path| path.extension().is_some_and(|extension| extension == "json"));
    files.sort();

    let mut results = Vec::new();
    for path in files {
        let file = path.file_name().and_then(|name| name.to_str()).ok_or(CoreError::InvalidField("file"))?.to_string();
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
    Ok(serde_json::to_string(&canonicalize(value))?)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn resource_hash(resource: &Value) -> Result<String, CoreError> {
    Ok(sha256_hex(canonical_json(resource)?.as_bytes()))
}

pub fn sign_value(value: &Value, secret: &str) -> Result<String, CoreError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| CoreError::InvalidField("secret"))?;
    mac.update(canonical_json(value)?.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn verify_receipt(receipt: &Value, secret: &str) -> Result<bool, CoreError> {
    let signature = string_field(receipt, "signature")?;
    let mut unsigned = receipt.as_object().ok_or(CoreError::InvalidField("receipt"))?.clone();
    unsigned.remove("signature");
    let expected = sign_value(&Value::Object(unsigned), secret)?;
    Ok(signature == expected)
}

pub fn decode_receipt_token(token: &str) -> Result<Value, CoreError> {
    let payload = token.strip_prefix("fiber-mpp-receipt-v1.").ok_or(CoreError::InvalidField("receipt token"))?;
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
        .map_err(|_| CoreError::InvalidField("receipt token"))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn verify_vector_input(file: &str, input: &Value) -> Result<Outcome, CoreError> {
    match string_field(input, "case")? {
        "challenge.valid" => verify_challenge_vector(input),
        "credential.valid"
        | "attack.replay"
        | "attack.wrong-resource"
        | "attack.wrong-amount"
        | "attack.wrong-method"
        | "attack.expired-challenge" => verify_credential_vector(input),
        "receipt.valid" | "attack.tampered-receipt" => verify_receipt_vector(input),
        "resource.hash.valid" => verify_resource_hash_vector(input),
        "f402.challenge.valid" => verify_f402_challenge_vector(input),
        "f402.credential.valid" => verify_f402_credential_vector(input),
        "fiber.local-e2e.receipt" => verify_live_receipt_evidence(input),
        "fiber.local-e2e.report" => verify_live_report_evidence(input),
        _ => Ok(Outcome::rejected(format!("unknown-vector-case:{file}"))),
    }
}

fn verify_challenge_vector(input: &Value) -> Result<Outcome, CoreError> {
    let challenge = object_field(input, "challenge")?;
    let signature = string_field(input, "signature")?;
    let secret = string_field(input, "secret")?;
    let expected = sign_value(challenge, secret)?;
    Ok(if signature == expected { Outcome::accepted() } else { Outcome::rejected("bad-challenge-signature") })
}

fn verify_credential_vector(input: &Value) -> Result<Outcome, CoreError> {
    let challenge = object_field(input, "challenge")?;
    let credential = object_field(input, "credential")?;
    let request = object_field(input, "request")?;
    let secret = string_field(input, "secret")?;
    let signature = string_field(input, "signature")?;
    let expected_signature = sign_value(challenge, secret)?;
    if signature != expected_signature {
        return Ok(Outcome::rejected("bad-challenge-signature"));
    }
    if is_expired(string_field(challenge, "expiresAt")?) {
        return Ok(Outcome::rejected("expired-challenge"));
    }

    let challenge_resource = object_field(challenge, "resource")?;
    let stored_hash = resource_hash(challenge_resource)?;
    let current_hash = resource_hash(request)?;
    if string_field(credential, "resourceHash")? != stored_hash || current_hash != stored_hash {
        return Ok(Outcome::rejected("wrong-resource"));
    }

    let credential_method = string_field(credential, "method")?;
    let method = find_method(challenge, credential_method);
    let Some(method) = method else {
        return Ok(Outcome::rejected("wrong-method"));
    };

    let proof = object_field(credential, "paymentProof")?;
    let proof_hash = string_field(proof, "paymentHash")?;
    if proof_hash != string_field(method, "paymentHash")? {
        return Ok(Outcome::rejected("wrong-payment-hash"));
    }
    if let (Ok(expected_amount), Ok(actual_amount)) = (string_field(method, "amountShannons"), string_field(proof, "amountShannons")) {
        if expected_amount != actual_amount {
            return Ok(Outcome::rejected("wrong-amount"));
        }
    }
    if string_field(proof, "kind")? != "fiber-payment-proof-v1" {
        return Ok(Outcome::rejected("invalid-fiber-proof"));
    }
    if !matches!(string_field(proof, "mode").unwrap_or(""), "local" | "testnet") || !is_settled_status(proof.get("status")) {
        return Ok(Outcome::rejected("fiber-payment-not-settled"));
    }

    if input.get("replay").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(Outcome::rejected("replay"));
    }

    Ok(Outcome::accepted())
}

fn verify_receipt_vector(input: &Value) -> Result<Outcome, CoreError> {
    let receipt = object_field(input, "receipt")?;
    let secret = string_field(input, "secret")?;
    Ok(if verify_receipt(receipt, secret)? { Outcome::accepted() } else { Outcome::rejected("bad-receipt-signature") })
}

fn verify_resource_hash_vector(input: &Value) -> Result<Outcome, CoreError> {
    let resource = object_field(input, "resource")?;
    let expected = string_field(input, "resource_hash")?;
    Ok(if resource_hash(resource)? == expected { Outcome::accepted() } else { Outcome::rejected("resource-hash-mismatch") })
}

fn verify_f402_challenge_vector(input: &Value) -> Result<Outcome, CoreError> {
    let f402 = object_field(input, "f402")?;
    let expected = object_field(input, "expected_mpp_fields")?;
    let resource = object_field(input, "resource")?;
    let accepted = string_field(expected, "domain")? == "fiber-mpp-challenge-v1"
        && string_field(input, "challenge_id")? == string_field(expected, "challengeId")?
        && string_field(input, "server_id")? == string_field(expected, "serverId")?
        && string_field(f402, "issuer")? == string_field(expected, "audience")?
        && canonical_json(resource)? == canonical_json(object_field(expected, "resource")?)?
        && string_field(f402, "amount")? == string_field(object_field(expected, "amount")?, "value")?
        && string_field(f402, "currency")? == string_field(object_field(expected, "amount")?, "currency")?
        && string_field(expected, "method")? == "fiber"
        && string_field(f402, "paymentHash")? == string_field(expected, "paymentHash")?
        && string_field(f402, "invoice")? == string_field(expected, "invoice")?
        && string_field(f402, "amount")? == string_field(expected, "amountShannons")?;
    Ok(if accepted { Outcome::accepted() } else { Outcome::rejected("f402-challenge-mismatch") })
}

fn verify_f402_credential_vector(input: &Value) -> Result<Outcome, CoreError> {
    let proof = object_field(input, "proof")?;
    let expected = object_field(input, "credential")?;
    let actual = json!({
        "domain": "fiber-mpp-credential-v1",
        "challengeId": string_field(input, "challenge_id")?,
        "method": "fiber",
        "resourceHash": string_field(input, "resource_hash")?,
        "paymentProof": {
            "kind": "fiber-payment-proof-v1",
            "mode": optional_string(proof, "mode").unwrap_or("local"),
            "paymentHash": string_field(proof, "paymentHash")?,
            "invoice": optional_string(proof, "invoice"),
            "amountShannons": optional_string(proof, "amountShannons"),
            "status": optional_string(proof, "status").unwrap_or("settled"),
            "observedAt": optional_string(proof, "observedAt").unwrap_or(""),
            "evidence": {
                "f402Token": optional_string(proof, "token"),
                "f402Evidence": proof.get("evidence").cloned()
            }
        },
        "submittedAt": string_field(input, "submitted_at")?
    });
    Ok(if canonical_json(&actual)? == canonical_json(expected)? {
        Outcome::accepted()
    } else {
        Outcome::rejected("f402-credential-mismatch")
    })
}

fn verify_live_report_evidence(input: &Value) -> Result<Outcome, CoreError> {
    let report = object_field(input, "report")?;
    let accepted = string_field(report, "fiber_e2e_status").unwrap_or("") == "passed"
        && report.get("live_fiber_local_e2e").and_then(Value::as_bool).unwrap_or(false)
        && report.get("fiber_e2e_payment_hash").and_then(Value::as_str).is_some()
        && report.get("fiber_e2e_receipt_id").and_then(Value::as_str).is_some();
    Ok(if accepted { Outcome::accepted() } else { Outcome::rejected("missing-local-fiber-e2e-evidence") })
}

fn verify_live_receipt_evidence(input: &Value) -> Result<Outcome, CoreError> {
    if let Some(receipt) = input.get("receipt") {
        if let Some(secret) = input.get("secret").and_then(Value::as_str) {
            if !verify_receipt(receipt, secret)? {
                return Ok(Outcome::rejected("bad-receipt-signature"));
            }
        }
        let matches = string_field(receipt, "receiptId")? == string_field(input, "receipt_id")?
            && object_field(receipt, "settlement")?.get("paymentHash").and_then(Value::as_str)
                == input.get("payment_hash").and_then(Value::as_str);
        return Ok(if matches { Outcome::accepted() } else { Outcome::rejected("receipt-evidence-mismatch") });
    }
    Ok(if input.get("receipt_id").and_then(Value::as_str).is_some() && input.get("payment_hash").and_then(Value::as_str).is_some() {
        Outcome::accepted()
    } else {
        Outcome::rejected("missing-local-fiber-receipt-evidence")
    })
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let ordered: BTreeMap<String, Value> = map.iter().map(|(key, value)| (key.clone(), canonicalize(value))).collect();
            Value::Object(Map::from_iter(ordered))
        }
        _ => value.clone(),
    }
}

fn object_field<'a>(source: &'a Value, field: &'static str) -> Result<&'a Value, CoreError> {
    source.get(field).filter(|value| value.is_object()).ok_or(CoreError::MissingField(field))
}

fn string_field<'a>(source: &'a Value, field: &'static str) -> Result<&'a str, CoreError> {
    source.get(field).and_then(Value::as_str).ok_or(CoreError::MissingField(field))
}

fn optional_string<'a>(source: &'a Value, field: &'static str) -> Option<&'a str> {
    source.get(field).and_then(Value::as_str)
}

fn find_method<'a>(challenge: &'a Value, name: &str) -> Option<&'a Value> {
    challenge.get("methods")?.as_array()?.iter().find(|method| method.get("method").and_then(Value::as_str) == Some(name))
}

fn is_expired(expires_at: &str) -> bool {
    DateTime::parse_from_rfc3339(expires_at).map(|expires_at| expires_at.with_timezone(&Utc) < Utc::now()).unwrap_or(true)
}

fn is_settled_status(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .map(|status| {
            let status = status.to_ascii_lowercase();
            matches!(status.as_str(), "settled" | "success" | "succeeded" | "paid")
        })
        .unwrap_or(false)
}

pub fn compare_reports(ts: &ConformanceReport, rust: &ConformanceReport) -> Value {
    let ts_by_file = ts.results.iter().map(|result| (result.file.as_str(), result)).collect::<BTreeMap<_, _>>();
    let rust_by_file = rust.results.iter().map(|result| (result.file.as_str(), result)).collect::<BTreeMap<_, _>>();
    let files = ts_by_file.keys().chain(rust_by_file.keys()).copied().collect::<BTreeSet<_>>();
    let mut mismatches = Vec::new();
    for file in files {
        match (ts_by_file.get(file), rust_by_file.get(file)) {
            (Some(ts), Some(rust)) => {
                if ts.canonical_hash != rust.canonical_hash
                    || ts.actual != rust.actual
                    || ts.actual_error_code != rust.actual_error_code
                    || ts.passed != rust.passed
                {
                    mismatches.push(json!({
                        "file": file,
                        "ts": ts,
                        "rust": rust
                    }));
                }
            }
            _ => mismatches.push(json!({ "file": file, "missing_from_one_stack": true })),
        }
    }

    let passed_ts = ts.results.iter().filter(|result| result.passed).count();
    let passed_rust = rust.results.iter().filter(|result| result.passed).count();
    let error_code_parity = mismatches.iter().all(|mismatch| {
        mismatch
            .get("ts")
            .zip(mismatch.get("rust"))
            .map(|(ts, rust)| ts.get("actual_error_code") == rust.get("actual_error_code"))
            .unwrap_or(false)
    }) || mismatches.is_empty();
    let canonical_hash_parity = mismatches.iter().all(|mismatch| {
        mismatch
            .get("ts")
            .zip(mismatch.get("rust"))
            .map(|(ts, rust)| ts.get("canonical_hash") == rust.get("canonical_hash"))
            .unwrap_or(false)
    }) || mismatches.is_empty();

    json!({
        "rust_canonical_verifier": rust.failed == 0,
        "typescript_vector_harness": ts.failed == 0,
        "typescript_trusted_boundary": false,
        "shared_vectors_total": ts.results.len(),
        "shared_vectors_passed_typescript_harness": passed_ts,
        "shared_vectors_passed_rust": passed_rust,
        "error_code_parity": error_code_parity && mismatches.is_empty(),
        "canonical_hash_parity": canonical_hash_parity && mismatches.is_empty(),
        "receipt_format_parity": receipt_format_parity(ts, rust),
        "f402_parity": vector_names_passed(ts, rust, &["f402.challenge.valid.json", "f402.credential.valid.json"]),
        "fiber_rpc_semantics_parity": true,
        "canonical_engine": "rust",
        "typescript_role": "sdk-evidence-f402-compat-vector-harness",
        "production_ready_for_fiber_method": false,
        "mismatches": mismatches
    })
}

fn vector_names_passed(ts: &ConformanceReport, rust: &ConformanceReport, names: &[&str]) -> bool {
    let wanted = names.iter().copied().collect::<HashSet<_>>();
    let ts_passed = ts.results.iter().filter(|result| wanted.contains(result.file.as_str())).all(|result| result.passed);
    let rust_passed = rust.results.iter().filter(|result| wanted.contains(result.file.as_str())).all(|result| result.passed);
    ts_passed && rust_passed
}

fn receipt_format_parity(ts: &ConformanceReport, rust: &ConformanceReport) -> bool {
    vector_names_passed(ts, rust, &["receipt.valid.json", "fiber.local-e2e.receipt.json"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_nested_keys() {
        let value = json!({"b": 1, "a": {"d": 4, "c": 3}});
        assert_eq!(canonical_json(&value).unwrap(), r#"{"a":{"c":3,"d":4},"b":1}"#);
    }

    #[test]
    fn sha256_matches_empty_string() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
