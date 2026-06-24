use fiber_mpp_core::{canonical_json, CoreError};
use serde_json::{json, Value};

pub fn f402_proof_to_credential(
    proof: &Value,
    challenge_id: &str,
    resource_hash: &str,
    submitted_at: &str,
) -> Result<Value, CoreError> {
    Ok(json!({
        "domain": "fiber-mpp-credential-v1",
        "challengeId": challenge_id,
        "method": "fiber",
        "resourceHash": resource_hash,
        "paymentProof": {
            "kind": "fiber-payment-proof-v1",
            "mode": "mock",
            "paymentHash": proof.get("paymentHash").and_then(Value::as_str).unwrap_or_default(),
            "invoice": proof.get("invoice").and_then(Value::as_str),
            "amountShannons": proof.get("amountShannons").and_then(Value::as_str),
            "status": proof.get("status").and_then(Value::as_str).unwrap_or("settled"),
            "observedAt": proof.get("observedAt").and_then(Value::as_str).unwrap_or_default(),
            "evidence": {
                "f402Token": proof.get("token").and_then(Value::as_str),
                "f402Evidence": proof.get("evidence").cloned()
            }
        },
        "submittedAt": submitted_at
    }))
}

pub fn canonical_equal(left: &Value, right: &Value) -> Result<bool, CoreError> {
    Ok(canonical_json(left)? == canonical_json(right)?)
}
