use fiber_paid_http_core::{
    canonical_json, decode_fiber_charge_request, CoreError, PaymentChallenge,
};
use serde_json::{json, Value};

pub fn f402_proof_to_credential(proof: &Value, challenge: &Value) -> Result<Value, CoreError> {
    let payment_hash = proof
        .get("paymentHash")
        .and_then(Value::as_str)
        .ok_or(CoreError::MissingField("paymentHash"))?;
    let challenge: PaymentChallenge = serde_json::from_value(challenge.clone())?;
    let charge = decode_fiber_charge_request(&challenge.request)?;
    if normalize_hash(payment_hash)? != normalize_hash(&charge.method_details.payment_hash)? {
        return Err(CoreError::InvalidField("paymentHash"));
    }
    Ok(json!({
        "challenge": challenge,
        "payload": {
            "paymentHash": payment_hash
        }
    }))
}

pub fn canonical_equal(left: &Value, right: &Value) -> Result<bool, CoreError> {
    Ok(canonical_json(left)? == canonical_json(right)?)
}

fn normalize_hash(value: &str) -> Result<String, CoreError> {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CoreError::InvalidField("paymentHash"));
    }
    Ok(format!("0x{}", raw.to_ascii_lowercase()))
}
