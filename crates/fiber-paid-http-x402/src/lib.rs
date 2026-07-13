use fiber_paid_http_core::{
    bind_challenge_id, canonical_json, decode_fiber_charge_request, encode_fiber_charge_request,
    FiberChargeRequest, PaymentChallenge, PaymentCredential, PaymentReceipt,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use thiserror::Error;

pub const X402_VERSION: u64 = 2;
pub const X402_FIBER_SCHEME: &str = "exact";
pub const X402_FIBER_PROFILE: &str = "fiber-charge-v1";

#[derive(Debug, Error)]
pub enum X402Error {
    #[error("core error: {0}")]
    Core(#[from] fiber_paid_http_core::CoreError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(&'static str),
}

pub fn fiber_charge_to_requirements(
    charge: &FiberChargeRequest,
    max_timeout_seconds: u64,
) -> Result<Value, X402Error> {
    if max_timeout_seconds == 0 || max_timeout_seconds > 86_400 {
        return Err(X402Error::Invalid("x402-fiber-invalid-timeout"));
    }
    let recipient = charge
        .recipient
        .as_deref()
        .ok_or(X402Error::Invalid("x402-fiber-recipient-required"))?;
    let currency = charge.currency.to_ascii_lowercase();
    let mut fiber = json!({
        "profile": X402_FIBER_PROFILE,
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
        "scheme": X402_FIBER_SCHEME,
        "network": format!("fiber:{}", charge.method_details.network),
        "amount": charge.amount,
        "asset": format!("fiber:{currency}"),
        "payTo": recipient,
        "maxTimeoutSeconds": max_timeout_seconds,
        "extra": { "fiber": fiber }
    }))
}

pub fn requirements_to_fiber_charge(requirement: &Value) -> Result<FiberChargeRequest, X402Error> {
    require_exact_keys(
        requirement,
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
    if string(requirement, "scheme")? != X402_FIBER_SCHEME {
        return Err(X402Error::Invalid("x402-fiber-wrong-scheme"));
    }
    let network = string(requirement, "network")?
        .strip_prefix("fiber:")
        .ok_or(X402Error::Invalid("x402-fiber-wrong-network"))?;
    if !matches!(network, "mainnet" | "testnet" | "dev") {
        return Err(X402Error::Invalid("x402-fiber-wrong-network"));
    }
    let timeout = requirement
        .get("maxTimeoutSeconds")
        .and_then(Value::as_u64)
        .ok_or(X402Error::Invalid("x402-fiber-invalid-timeout"))?;
    if timeout == 0 || timeout > 86_400 {
        return Err(X402Error::Invalid("x402-fiber-invalid-timeout"));
    }
    let extra = object(requirement, "extra")?;
    require_exact_keys(extra, &["fiber"])?;
    let fiber = object(extra, "fiber")?;
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
    if string(fiber, "profile")? != X402_FIBER_PROFILE {
        return Err(X402Error::Invalid("x402-fiber-wrong-profile"));
    }
    let currency = string(fiber, "currency")?;
    if string(requirement, "asset")? != format!("fiber:{}", currency.to_ascii_lowercase()) {
        return Err(X402Error::Invalid("x402-fiber-asset-mismatch"));
    }
    let amount = string(requirement, "amount")?;
    if !positive_decimal(amount) {
        return Err(X402Error::Invalid("x402-fiber-invalid-amount"));
    }
    let payment_hash = string(fiber, "paymentHash")?;
    validate_hash(payment_hash)?;
    let hash_algorithm = string(fiber, "hashAlgorithm")?;
    if !matches!(hash_algorithm, "ckb_hash" | "sha256") {
        return Err(X402Error::Invalid("x402-fiber-wrong-hash-algorithm"));
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
        recipient: Some(string(requirement, "payTo")?.to_string()),
        description: fiber
            .get("description")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        external_id: fiber
            .get("externalId")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        method_details: fiber_paid_http_core::FiberChargeMethodDetails {
            invoice: string(fiber, "invoice")?.to_string(),
            payment_hash: payment_hash.to_string(),
            network: network.to_string(),
            hash_algorithm: hash_algorithm.to_string(),
            udt_type_script,
            extensions: method_extensions,
        },
        extensions: BTreeMap::new(),
    })
}

pub fn payment_required_to_mpp(
    required: &Value,
    accepted_index: usize,
    resource: &Value,
    realm: &str,
    secret: &str,
    expires_at: &str,
) -> Result<PaymentChallenge, X402Error> {
    require_version_two(required)?;
    if string(object(required, "resource")?, "url")? != string(resource, "url")? {
        return Err(X402Error::Invalid("x402-fiber-resource-mismatch"));
    }
    let accepted = required
        .get("accepts")
        .and_then(Value::as_array)
        .and_then(|values| values.get(accepted_index))
        .ok_or(X402Error::Invalid("x402-fiber-requirement-missing"))?;
    let charge = requirements_to_fiber_charge(accepted)?;
    let description = object(required, "resource")?
        .get("description")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let pending = PaymentChallenge {
        id: "pending".to_string(),
        realm: realm.to_string(),
        method: "fiber".to_string(),
        intent: "charge".to_string(),
        request: encode_fiber_charge_request(&charge)?,
        expires: Some(expires_at.to_string()),
        digest: resource
            .get("digest")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        description,
        opaque: None,
        extensions: BTreeMap::new(),
    };
    Ok(PaymentChallenge {
        id: bind_challenge_id(&pending, secret)?,
        ..pending
    })
}

pub fn payment_payload_to_credential(
    payload: &Value,
    challenge: &PaymentChallenge,
    expected_resource_url: Option<&str>,
) -> Result<PaymentCredential, X402Error> {
    require_version_two(payload)?;
    if let Some(expected) = expected_resource_url {
        if payload
            .get("resource")
            .and_then(|value| value.get("url"))
            .and_then(Value::as_str)
            != Some(expected)
        {
            return Err(X402Error::Invalid("x402-fiber-resource-mismatch"));
        }
    }
    let accepted = payload
        .get("accepted")
        .ok_or(X402Error::Invalid("x402-fiber-requirement-missing"))?;
    let timeout = accepted
        .get("maxTimeoutSeconds")
        .and_then(Value::as_u64)
        .ok_or(X402Error::Invalid("x402-fiber-invalid-timeout"))?;
    let expected =
        fiber_charge_to_requirements(&decode_fiber_charge_request(&challenge.request)?, timeout)?;
    if canonical_json(&expected)? != canonical_json(accepted)? {
        return Err(X402Error::Invalid("x402-fiber-requirement-mismatch"));
    }
    let payment = object(payload, "payload")?;
    require_exact_keys(payment, &["paymentHash"])?;
    let payment_hash = string(payment, "paymentHash")?;
    if payment_hash != string(object(object(accepted, "extra")?, "fiber")?, "paymentHash")? {
        return Err(X402Error::Invalid("wrong-payment-hash"));
    }
    Ok(PaymentCredential {
        challenge: challenge.clone(),
        source: Some("x402".to_string()),
        payload: fiber_paid_http_core::FiberCredentialPayload {
            payment_hash: payment_hash.to_string(),
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    })
}

pub fn receipt_to_settle_response(
    receipt: &PaymentReceipt,
    network: &str,
    amount: &str,
) -> Result<Value, X402Error> {
    if receipt.status != "success" || receipt.method != "fiber" {
        return Err(X402Error::Invalid("x402-fiber-invalid-receipt"));
    }
    if !matches!(network, "fiber:mainnet" | "fiber:testnet" | "fiber:dev") {
        return Err(X402Error::Invalid("x402-fiber-wrong-network"));
    }
    if !positive_decimal(amount) {
        return Err(X402Error::Invalid("x402-fiber-invalid-amount"));
    }
    Ok(json!({
        "success": true,
        "transaction": receipt.reference,
        "network": network,
        "amount": amount,
        "extensions": {
            "fiber": {
                "profile": X402_FIBER_PROFILE,
                "challengeId": receipt.challenge_id,
                "receiptTimestamp": receipt.timestamp
            }
        }
    }))
}

fn require_version_two(value: &Value) -> Result<(), X402Error> {
    if value.get("x402Version").and_then(Value::as_u64) == Some(X402_VERSION) {
        Ok(())
    } else {
        Err(X402Error::Invalid("x402-v2-required"))
    }
}

fn object<'a>(value: &'a Value, field: &'static str) -> Result<&'a Value, X402Error> {
    value
        .get(field)
        .filter(|item| item.is_object())
        .ok_or(X402Error::Invalid(field))
}

fn string<'a>(value: &'a Value, field: &'static str) -> Result<&'a str, X402Error> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .ok_or(X402Error::Invalid(field))
}

fn require_exact_keys(value: &Value, keys: &[&str]) -> Result<(), X402Error> {
    require_allowed_keys(value, keys, keys)
}

fn require_allowed_keys(
    value: &Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<(), X402Error> {
    let object = value
        .as_object()
        .ok_or(X402Error::Invalid("x402-object-required"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(X402Error::Invalid("x402-unexpected-fields"));
    }
    Ok(())
}

fn positive_decimal(value: &str) -> bool {
    !value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn validate_hash(value: &str) -> Result<(), X402Error> {
    let raw = value
        .strip_prefix("0x")
        .ok_or(X402Error::Invalid("paymentHash"))?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(X402Error::Invalid("paymentHash"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fiber_paid_http_core::FiberChargeMethodDetails;

    const SECRET: &str = "x402-conformance-secret-at-least-32";
    const HASH: &str = "0xabababababababababababababababababababababababababababababababab";

    #[test]
    fn converts_x402_v2_without_changing_payment_lifecycle() {
        let challenge = challenge();
        let charge = decode_fiber_charge_request(&challenge.request).unwrap();
        let requirement = fiber_charge_to_requirements(&charge, 120).unwrap();
        let payload = json!({
            "x402Version": 2,
            "resource": { "url": "https://x402.example.test/paid/weather" },
            "accepted": requirement,
            "payload": { "paymentHash": HASH }
        });
        let credential = payment_payload_to_credential(
            &payload,
            &challenge,
            Some("https://x402.example.test/paid/weather"),
        )
        .unwrap();
        assert_eq!(credential.source.as_deref(), Some("x402"));
        assert_eq!(credential.payload.payment_hash, HASH);

        let receipt = PaymentReceipt {
            status: "success".to_string(),
            method: "fiber".to_string(),
            timestamp: "2026-07-13T00:00:02.000Z".to_string(),
            reference: HASH.to_string(),
            challenge_id: challenge.id,
            extensions: BTreeMap::new(),
        };
        let response = receipt_to_settle_response(&receipt, "fiber:testnet", "1000").unwrap();
        assert_eq!(response["transaction"], HASH);
        assert_eq!(response["success"], true);
    }

    #[test]
    fn rejects_tampered_requirement() {
        let challenge = challenge();
        let charge = decode_fiber_charge_request(&challenge.request).unwrap();
        let mut requirement = fiber_charge_to_requirements(&charge, 120).unwrap();
        requirement["amount"] = Value::String("1001".to_string());
        let payload = json!({
            "x402Version": 2,
            "accepted": requirement,
            "payload": { "paymentHash": HASH }
        });
        let error = payment_payload_to_credential(&payload, &challenge, None).unwrap_err();
        assert!(error.to_string().contains("requirement-mismatch"));
    }

    fn challenge() -> PaymentChallenge {
        let charge = FiberChargeRequest {
            amount: "1000".to_string(),
            currency: "ckb".to_string(),
            recipient: Some("03fiberpayee".to_string()),
            description: None,
            external_id: None,
            method_details: FiberChargeMethodDetails {
                invoice: "fibt1qx402conformance0001".to_string(),
                payment_hash: HASH.to_string(),
                network: "testnet".to_string(),
                hash_algorithm: "ckb_hash".to_string(),
                udt_type_script: None,
                extensions: BTreeMap::new(),
            },
            extensions: BTreeMap::new(),
        };
        let pending = PaymentChallenge {
            id: "pending".to_string(),
            realm: "x402.example.test".to_string(),
            method: "fiber".to_string(),
            intent: "charge".to_string(),
            request: encode_fiber_charge_request(&charge).unwrap(),
            expires: Some("2030-01-01T00:00:00.000Z".to_string()),
            digest: None,
            description: Some("Weather".to_string()),
            opaque: None,
            extensions: BTreeMap::new(),
        };
        PaymentChallenge {
            id: bind_challenge_id(&pending, SECRET).unwrap(),
            ..pending
        }
    }
}
