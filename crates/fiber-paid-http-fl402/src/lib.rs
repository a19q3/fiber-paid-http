use base64::Engine;
use chrono::{DateTime, Utc};
use fiber_paid_http_core::canonical_json;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

pub const FL402_CAPABILITY_PREFIX: &str = "fiber-l402-capability-v1";

#[derive(Debug, Error)]
pub enum Fl402Error {
    #[error("invalid-fl402-capability")]
    InvalidCapability,
    #[error("bad-fl402-capability-signature")]
    BadCapabilitySignature,
    #[error("expired-fl402-capability")]
    ExpiredCapability,
    #[error("fl402-capability-mismatch")]
    CapabilityMismatch,
    #[error("wrong-payment-hash")]
    WrongPaymentHash,
    #[error("wrong-preimage")]
    WrongPreimage,
    #[error("wrong-resource")]
    WrongResource,
    #[error("wrong-challenge")]
    WrongChallenge,
    #[error("wrong-hash-algorithm")]
    WrongHashAlgorithm,
    #[error("wrong-invoice")]
    WrongInvoice,
    #[error("wrong-amount")]
    WrongAmount,
    #[error("wrong-currency")]
    WrongCurrency,
    #[error("wrong-expiry")]
    WrongExpiry,
    #[error("wrong-issuer")]
    WrongIssuer,
    #[error("wrong-recipient")]
    WrongRecipient,
    #[error("wrong-network")]
    WrongNetwork,
    #[error("missing field {0}")]
    MissingField(&'static str),
    #[error("invalid field {0}")]
    InvalidField(&'static str),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("core error: {0}")]
    Core(#[from] fiber_paid_http_core::CoreError),
}

pub fn issue_fl402_capability(payload: &Value, root_key: &str) -> Result<String, Fl402Error> {
    if root_key.len() < 32 {
        return Err(Fl402Error::InvalidField("rootKey"));
    }
    if string_field(payload, "domain")? != FL402_CAPABILITY_PREFIX {
        return Err(Fl402Error::InvalidCapability);
    }
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(canonical_json(payload)?);
    let signature = sign_payload(payload, root_key)?;
    Ok(format!("{FL402_CAPABILITY_PREFIX}.{encoded}.{signature}"))
}

pub fn decode_fl402_capability(capability: &str) -> Result<(Value, String), Fl402Error> {
    let mut parts = capability.split('.');
    let prefix = parts.next().ok_or(Fl402Error::InvalidCapability)?;
    let encoded = parts.next().ok_or(Fl402Error::InvalidCapability)?;
    let signature = parts.next().ok_or(Fl402Error::InvalidCapability)?;
    if prefix != FL402_CAPABILITY_PREFIX || parts.next().is_some() {
        return Err(Fl402Error::InvalidCapability);
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| Fl402Error::InvalidCapability)?;
    let payload: Value = serde_json::from_slice(&bytes)?;
    if canonical_json(&payload)?.as_bytes() != bytes {
        return Err(Fl402Error::InvalidCapability);
    }
    if string_field(&payload, "domain")? != FL402_CAPABILITY_PREFIX {
        return Err(Fl402Error::InvalidCapability);
    }
    Ok((payload, signature.to_string()))
}

pub fn verify_fl402_capability(
    capability: &str,
    root_key: &str,
    now: Option<&str>,
) -> Result<Value, Fl402Error> {
    if root_key.len() < 32 {
        return Err(Fl402Error::InvalidField("rootKey"));
    }
    let (payload, signature) = decode_fl402_capability(capability)?;
    let signature = hex::decode(signature).map_err(|_| Fl402Error::BadCapabilitySignature)?;
    let mut mac = HmacSha256::new_from_slice(root_key.as_bytes())
        .map_err(|_| Fl402Error::InvalidField("rootKey"))?;
    mac.update(canonical_json(&payload)?.as_bytes());
    if mac.verify_slice(&signature).is_err() {
        return Err(Fl402Error::BadCapabilitySignature);
    }
    let caveats = object_field(&payload, "caveats")?;
    let expires_at = DateTime::parse_from_rfc3339(string_field(caveats, "expiresAt")?)
        .map_err(|_| Fl402Error::InvalidField("expiresAt"))?
        .with_timezone(&Utc);
    let issued_at = DateTime::parse_from_rfc3339(string_field(&payload, "issuedAt")?)
        .map_err(|_| Fl402Error::InvalidField("issuedAt"))?
        .with_timezone(&Utc);
    let now = match now {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .map_err(|_| Fl402Error::InvalidField("now"))?
            .with_timezone(&Utc),
        None => Utc::now(),
    };
    if issued_at > now || now > expires_at {
        return Err(Fl402Error::ExpiredCapability);
    }
    Ok(payload)
}

pub fn verify_fl402_proof(
    challenge: &Value,
    proof: &Value,
    root_key: &str,
    now: Option<&str>,
) -> Result<Value, Fl402Error> {
    if string_field(challenge, "capability")? != string_field(proof, "capability")? {
        return Err(Fl402Error::CapabilityMismatch);
    }
    let payload = verify_fl402_capability(string_field(proof, "capability")?, root_key, now)?;
    let caveats = object_field(&payload, "caveats")?;
    let algorithm = optional_string(proof, "hashAlgorithm").unwrap_or("ckb_hash");
    let proof_hash = hash_payment_preimage(string_field(proof, "preimage")?, algorithm)?;
    let expected_hash = normalize_hex(string_field(caveats, "paymentHash")?)?;
    if normalize_hex(string_field(challenge, "paymentHash")?)? != expected_hash
        || normalize_hex(string_field(proof, "paymentHash")?)? != expected_hash
    {
        return Err(Fl402Error::WrongPaymentHash);
    }
    if normalize_hex(&proof_hash)? != expected_hash {
        return Err(Fl402Error::WrongPreimage);
    }
    if string_field(challenge, "resourceHash")? != string_field(caveats, "resourceHash")? {
        return Err(Fl402Error::WrongResource);
    }
    if string_field(challenge, "resource")? != string_field(caveats, "url")? {
        return Err(Fl402Error::WrongResource);
    }
    if string_field(challenge, "challengeId")? != string_field(caveats, "challengeId")? {
        return Err(Fl402Error::WrongChallenge);
    }
    if string_field(challenge, "invoice")? != string_field(caveats, "invoice")? {
        return Err(Fl402Error::WrongInvoice);
    }
    if string_field(challenge, "amount")? != string_field(caveats, "amount")? {
        return Err(Fl402Error::WrongAmount);
    }
    if string_field(challenge, "currency")? != string_field(caveats, "currency")? {
        return Err(Fl402Error::WrongCurrency);
    }
    if string_field(challenge, "expiresAt")? != string_field(caveats, "expiresAt")? {
        return Err(Fl402Error::WrongExpiry);
    }
    if optional_string(challenge, "issuer") != optional_string(caveats, "issuer") {
        return Err(Fl402Error::WrongIssuer);
    }
    if optional_string(challenge, "fiberNodeId") != optional_string(caveats, "fiberNodeId") {
        return Err(Fl402Error::WrongRecipient);
    }
    if string_field(challenge, "network")? != string_field(caveats, "network")? {
        return Err(Fl402Error::WrongNetwork);
    }
    if optional_string(challenge, "hashAlgorithm").unwrap_or("ckb_hash") != algorithm
        || string_field(caveats, "hashAlgorithm")? != algorithm
    {
        return Err(Fl402Error::WrongHashAlgorithm);
    }
    Ok(payload)
}

pub fn fl402_proof_to_credential(proof: &Value, challenge: &Value) -> Result<Value, Fl402Error> {
    Ok(json!({
        "challenge": challenge,
        "payload": {
            "paymentHash": string_field(proof, "paymentHash")?
        }
    }))
}

pub fn hash_payment_preimage(preimage: &str, algorithm: &str) -> Result<String, Fl402Error> {
    let normalized = normalize_hex(preimage)?;
    let bytes = hex::decode(normalized.trim_start_matches("0x"))
        .map_err(|_| Fl402Error::InvalidField("preimage"))?;
    let digest = match algorithm {
        "sha256" => Sha256::digest(&bytes).to_vec(),
        "ckb_hash" => blake2b_simd::Params::new()
            .hash_length(32)
            .personal(b"ckb-default-hash")
            .hash(&bytes)
            .as_bytes()
            .to_vec(),
        _ => return Err(Fl402Error::InvalidField("hashAlgorithm")),
    };
    Ok(format!("0x{}", hex::encode(digest)))
}

fn sign_payload(payload: &Value, root_key: &str) -> Result<String, Fl402Error> {
    let mut mac = HmacSha256::new_from_slice(root_key.as_bytes())
        .map_err(|_| Fl402Error::InvalidField("rootKey"))?;
    mac.update(canonical_json(payload)?.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn object_field<'a>(source: &'a Value, field: &'static str) -> Result<&'a Value, Fl402Error> {
    source
        .get(field)
        .filter(|value| value.is_object())
        .ok_or(Fl402Error::MissingField(field))
}

fn string_field<'a>(source: &'a Value, field: &'static str) -> Result<&'a str, Fl402Error> {
    source
        .get(field)
        .and_then(Value::as_str)
        .ok_or(Fl402Error::MissingField(field))
}

fn optional_string<'a>(source: &'a Value, field: &'static str) -> Option<&'a str> {
    source.get(field).and_then(Value::as_str)
}

fn normalize_hex(value: &str) -> Result<String, Fl402Error> {
    let raw = value.trim_start_matches("0x").to_ascii_lowercase();
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Fl402Error::InvalidField("hex32"));
    }
    Ok(format!("0x{raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_sha256_preimage() {
        let preimage = format!("0x{}", "11".repeat(32));
        let payment_hash = hash_payment_preimage(&preimage, "sha256").unwrap();
        let payload = json!({
            "domain": FL402_CAPABILITY_PREFIX,
            "caveats": {
                "challengeId": "challenge",
                "resourceHash": "resource",
                "method": "GET",
                "url": "https://example.com/paid",
                "paymentHash": payment_hash,
                "invoice": "fibt1fixture",
                "amount": "1000",
                "currency": "ckb",
                "expiresAt": "2030-01-01T00:00:00Z",
                "issuer": "example.com",
                "network": "testnet",
                "hashAlgorithm": "sha256"
            },
            "nonce": "00112233445566778899aabbccddeeff",
            "issuedAt": "2026-01-01T00:00:00Z"
        });
        let root_key = "fl402-rust-unit-root-key-at-least-32-characters";
        let capability = issue_fl402_capability(&payload, root_key).unwrap();
        let challenge = json!({
            "challengeId": "challenge",
            "capability": capability,
            "paymentHash": payment_hash,
            "resourceHash": "resource",
            "resource": "https://example.com/paid",
            "method": "GET",
            "invoice": "fibt1fixture",
            "amount": "1000",
            "currency": "ckb",
            "expiresAt": "2030-01-01T00:00:00Z",
            "issuer": "example.com",
            "network": "testnet",
            "hashAlgorithm": "sha256"
        });
        let proof = json!({
            "capability": challenge["capability"],
            "preimage": preimage,
            "paymentHash": payment_hash,
            "hashAlgorithm": "sha256"
        });
        verify_fl402_proof(&challenge, &proof, root_key, Some("2026-01-01T00:00:00Z")).unwrap();
    }
}
