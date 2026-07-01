use base64::Engine;
use chrono::{DateTime, Utc};
use fiber_paid_http_core::canonical_json;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

pub const FL402_MACAROON_PREFIX: &str = "fl402-macaroon-v1";

#[derive(Debug, Error)]
pub enum Fl402Error {
    #[error("invalid-fl402-macaroon")]
    InvalidMacaroon,
    #[error("bad-fl402-macaroon-signature")]
    BadMacaroonSignature,
    #[error("expired-fl402-macaroon")]
    ExpiredMacaroon,
    #[error("fl402-macaroon-mismatch")]
    MacaroonMismatch,
    #[error("wrong-payment-hash")]
    WrongPaymentHash,
    #[error("wrong-preimage")]
    WrongPreimage,
    #[error("wrong-invoice")]
    WrongInvoice,
    #[error("wrong-amount")]
    WrongAmount,
    #[error("wrong-resource")]
    WrongResource,
    #[error("wrong-challenge")]
    WrongChallenge,
    #[error("wrong-hash-algorithm")]
    WrongHashAlgorithm,
    #[error("fiber-payment-not-settled")]
    PaymentNotSettled,
    #[error("missing field {0}")]
    MissingField(&'static str),
    #[error("invalid field {0}")]
    InvalidField(&'static str),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("core error: {0}")]
    Core(#[from] fiber_paid_http_core::CoreError),
}

pub fn issue_fl402_macaroon(payload: &Value, root_key: &str) -> Result<String, Fl402Error> {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(canonical_json(payload)?);
    let signature = sign_payload(payload, root_key)?;
    Ok(format!("{FL402_MACAROON_PREFIX}.{encoded}.{signature}"))
}

pub fn decode_fl402_macaroon(macaroon: &str) -> Result<(Value, String), Fl402Error> {
    let mut parts = macaroon.split('.');
    let prefix = parts.next().ok_or(Fl402Error::InvalidMacaroon)?;
    let encoded = parts.next().ok_or(Fl402Error::InvalidMacaroon)?;
    let signature = parts.next().ok_or(Fl402Error::InvalidMacaroon)?;
    if prefix != FL402_MACAROON_PREFIX || parts.next().is_some() {
        return Err(Fl402Error::InvalidMacaroon);
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| Fl402Error::InvalidMacaroon)?;
    Ok((serde_json::from_slice(&bytes)?, signature.to_string()))
}

pub fn verify_fl402_macaroon(
    macaroon: &str,
    root_key: &str,
    now: Option<&str>,
) -> Result<Value, Fl402Error> {
    let (payload, signature) = decode_fl402_macaroon(macaroon)?;
    let expected = sign_payload(&payload, root_key)?;
    if signature != expected {
        return Err(Fl402Error::BadMacaroonSignature);
    }
    let caveats = object_field(&payload, "caveats")?;
    let expires_at = DateTime::parse_from_rfc3339(string_field(caveats, "expiresAt")?)
        .map_err(|_| Fl402Error::InvalidField("expiresAt"))?
        .with_timezone(&Utc);
    let now = match now {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .map_err(|_| Fl402Error::InvalidField("now"))?
            .with_timezone(&Utc),
        None => Utc::now(),
    };
    if now > expires_at {
        return Err(Fl402Error::ExpiredMacaroon);
    }
    Ok(payload)
}

pub fn verify_fl402_proof(
    challenge: &Value,
    proof: &Value,
    root_key: &str,
    now: Option<&str>,
) -> Result<Value, Fl402Error> {
    if string_field(challenge, "macaroon")? != string_field(proof, "macaroon")? {
        return Err(Fl402Error::MacaroonMismatch);
    }
    let payload = verify_fl402_macaroon(string_field(proof, "macaroon")?, root_key, now)?;
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
    if string_field(challenge, "invoice")? != string_field(caveats, "invoice")?
        || optional_string(proof, "invoice")
            .is_some_and(|invoice| invoice != string_field(caveats, "invoice").unwrap_or(""))
    {
        return Err(Fl402Error::WrongInvoice);
    }
    if string_field(challenge, "amount")? != string_field(caveats, "amount")?
        || optional_string(proof, "amountShannons")
            .is_some_and(|amount| amount != string_field(caveats, "amount").unwrap_or(""))
    {
        return Err(Fl402Error::WrongAmount);
    }
    if optional_string(challenge, "resourceHash").is_some_and(|resource_hash| {
        resource_hash != string_field(caveats, "resourceHash").unwrap_or("")
    }) {
        return Err(Fl402Error::WrongResource);
    }
    if optional_string(challenge, "challengeId").is_some_and(|challenge_id| {
        challenge_id != string_field(caveats, "challengeId").unwrap_or("")
    }) {
        return Err(Fl402Error::WrongChallenge);
    }
    if optional_string(challenge, "hashAlgorithm").unwrap_or("ckb_hash")
        != string_field(caveats, "hashAlgorithm")?
        || algorithm != string_field(caveats, "hashAlgorithm")?
    {
        return Err(Fl402Error::WrongHashAlgorithm);
    }
    if optional_string(proof, "status").unwrap_or("settled") != "settled" {
        return Err(Fl402Error::PaymentNotSettled);
    }
    Ok(payload)
}

pub fn fl402_proof_to_credential(
    proof: &Value,
    challenge_id: &str,
    resource_hash: &str,
    submitted_at: &str,
) -> Result<Value, Fl402Error> {
    let algorithm = optional_string(proof, "hashAlgorithm").unwrap_or("ckb_hash");
    Ok(json!({
        "domain": "fiber-paid-http-credential-v1",
        "challengeId": challenge_id,
        "method": "fiber",
        "resourceHash": resource_hash,
        "paymentProof": {
            "kind": "fiber-payment-proof-v1",
            "mode": optional_string(proof, "mode").unwrap_or("local"),
            "paymentHash": string_field(proof, "paymentHash")?,
            "invoice": optional_string(proof, "invoice"),
            "amountShannons": optional_string(proof, "amountShannons"),
            "status": optional_string(proof, "status").unwrap_or("settled"),
            "observedAt": optional_string(proof, "observedAt").unwrap_or(""),
            "evidence": {
                "fl402Macaroon": string_field(proof, "macaroon")?,
                "fl402PreimageHash": hash_payment_preimage(string_field(proof, "preimage")?, algorithm)?,
                "fl402HashAlgorithm": algorithm,
                "fl402Evidence": proof.get("evidence").cloned()
            }
        },
        "submittedAt": submitted_at
    }))
}

pub fn hash_payment_preimage(preimage: &str, algorithm: &str) -> Result<String, Fl402Error> {
    let bytes = hex_to_bytes(preimage)?;
    let digest = match algorithm {
        "sha256" => {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            hasher.finalize().to_vec()
        }
        "ckb_hash" => ckb_blake2b_256(&bytes).to_vec(),
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

fn ckb_blake2b_256(bytes: &[u8]) -> [u8; 32] {
    let hash = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"ckb-default-hash")
        .hash(bytes);
    let mut output = [0_u8; 32];
    output.copy_from_slice(hash.as_bytes());
    output
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>, Fl402Error> {
    let normalized = normalize_hex(value)?;
    hex::decode(normalized).map_err(|_| Fl402Error::InvalidField("hex"))
}

fn normalize_hex(value: &str) -> Result<String, Fl402Error> {
    let normalized = value
        .strip_prefix("0x")
        .unwrap_or(value)
        .to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(Fl402Error::InvalidField("hex32"));
    }
    Ok(normalized)
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

#[cfg(test)]
mod tests {
    use super::*;
    use fiber_paid_http_core::sha256_hex;

    #[test]
    fn verifies_sha256_preimage() {
        let preimage = format!("0x{}", "11".repeat(32));
        let payment_hash = hash_payment_preimage(&preimage, "sha256").unwrap();
        let payload = json!({
            "domain": "fl402-macaroon-v1",
            "caveats": {
                "challengeId": "chal_fl402_rust_0001",
                "resourceHash": sha256_hex(b"resource"),
                "method": "GET",
                "url": "http://localhost/paid/weather",
                "amount": "1000",
                "currency": "Fibd",
                "paymentHash": payment_hash,
                "invoice": "fibd1qfixture",
                "expiresAt": "2030-01-01T00:00:00.000Z",
                "hashAlgorithm": "sha256"
            },
            "nonce": "0123456789abcdef0123456789abcdef",
            "issuedAt": "2026-07-01T00:00:00.000Z"
        });
        let macaroon = issue_fl402_macaroon(&payload, "root-key-at-least-16").unwrap();
        let challenge = json!({
            "macaroon": macaroon,
            "challengeId": "chal_fl402_rust_0001",
            "invoice": "fibd1qfixture",
            "paymentHash": payment_hash,
            "amount": "1000",
            "currency": "Fibd",
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "resourceHash": sha256_hex(b"resource"),
            "hashAlgorithm": "sha256"
        });
        let proof = json!({
            "macaroon": challenge["macaroon"],
            "preimage": preimage,
            "invoice": "fibd1qfixture",
            "paymentHash": payment_hash,
            "amountShannons": "1000",
            "status": "settled",
            "hashAlgorithm": "sha256"
        });
        verify_fl402_proof(
            &challenge,
            &proof,
            "root-key-at-least-16",
            Some("2026-07-01T00:00:00.000Z"),
        )
        .unwrap();
    }
}
