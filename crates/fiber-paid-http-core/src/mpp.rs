use crate::{canonical_json, sha256_hex, CoreError};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type HmacSha256 = Hmac<Sha256>;
const MAX_MPP_TOKEN_LEN: usize = 16 * 1024;
const MAX_MPP_REQUEST_PARAMETER_LEN: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FiberUdtTypeScript {
    pub code_hash: String,
    pub hash_type: String,
    pub args: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FiberChargeMethodDetails {
    pub invoice: String,
    pub payment_hash: String,
    pub network: String,
    pub hash_algorithm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udt_type_script: Option<FiberUdtTypeScript>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FiberChargeRequest {
    pub amount: String,
    pub currency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    pub method_details: FiberChargeMethodDetails,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaymentChallenge {
    pub id: String,
    pub realm: String,
    pub method: String,
    pub intent: String,
    pub request: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opaque: Option<String>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FiberCredentialPayload {
    pub payment_hash: String,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaymentCredential {
    pub challenge: PaymentChallenge,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub payload: FiberCredentialPayload,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaymentReceipt {
    pub status: String,
    pub method: String,
    pub timestamp: String,
    pub reference: String,
    pub challenge_id: String,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

pub fn encode_jcs_base64url<T: Serialize>(value: &T) -> Result<String, CoreError> {
    let encoded = serde_jcs::to_vec(value).map_err(CoreError::Json)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(encoded))
}

pub fn decode_base64url_json<T: DeserializeOwned>(input: &str) -> Result<T, CoreError> {
    if input.len() > MAX_MPP_TOKEN_LEN {
        return Err(CoreError::InvalidField("MPP token length"));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| CoreError::InvalidField("base64url"))?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err(CoreError::InvalidField("base64url"));
    }
    serde_json::from_slice(&bytes).map_err(CoreError::Json)
}

pub fn decode_jcs_base64url<T: DeserializeOwned>(input: &str) -> Result<T, CoreError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| CoreError::InvalidField("base64url"))?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err(CoreError::InvalidField("base64url"));
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if serde_jcs::to_vec(&value).map_err(CoreError::Json)? != bytes {
        return Err(CoreError::InvalidField("JCS"));
    }
    Ok(serde_json::from_value(value)?)
}

pub fn encode_fiber_charge_request(request: &FiberChargeRequest) -> Result<String, CoreError> {
    validate_fiber_charge_request(request)?;
    encode_jcs_base64url(request)
}

pub fn decode_fiber_charge_request(input: &str) -> Result<FiberChargeRequest, CoreError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|_| CoreError::InvalidField("base64url"))?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != input {
        return Err(CoreError::InvalidField("base64url"));
    }
    let request: FiberChargeRequest = serde_json::from_slice(&bytes)?;
    if serde_jcs::to_vec(&request).map_err(CoreError::Json)? != bytes {
        return Err(CoreError::InvalidField("fiber charge request JCS"));
    }
    validate_fiber_charge_request(&request)?;
    Ok(request)
}

pub fn challenge_binding_input(challenge: &PaymentChallenge) -> String {
    [
        challenge.realm.as_str(),
        challenge.method.as_str(),
        challenge.intent.as_str(),
        challenge.request.as_str(),
        challenge.expires.as_deref().unwrap_or(""),
        challenge.digest.as_deref().unwrap_or(""),
        challenge.opaque.as_deref().unwrap_or(""),
    ]
    .join("|")
}

pub fn bind_challenge_id(challenge: &PaymentChallenge, secret: &str) -> Result<String, CoreError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| CoreError::InvalidField("secret"))?;
    mac.update(challenge_binding_input(challenge).as_bytes());
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub fn verify_challenge_id(challenge: &PaymentChallenge, secrets: &[String]) -> bool {
    let Ok(actual) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&challenge.id) else {
        return false;
    };
    secrets.iter().any(|secret| {
        let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
            return false;
        };
        mac.update(challenge_binding_input(challenge).as_bytes());
        mac.verify_slice(&actual).is_ok()
    })
}

pub fn credential_hash(credential: &PaymentCredential) -> Result<String, CoreError> {
    let value = serde_json::to_value(credential)?;
    Ok(sha256_hex(canonical_json(&value)?.as_bytes()))
}

pub fn body_digest(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    format!(
        "sha-256=:{}:",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

pub fn www_authenticate_header(challenge: &PaymentChallenge) -> Result<String, CoreError> {
    validate_challenge(challenge)?;
    let mut fields = vec![
        ("id", Some(challenge.id.as_str())),
        ("realm", Some(challenge.realm.as_str())),
        ("method", Some(challenge.method.as_str())),
        ("intent", Some(challenge.intent.as_str())),
        ("request", Some(challenge.request.as_str())),
        ("expires", challenge.expires.as_deref()),
        ("digest", challenge.digest.as_deref()),
        ("description", challenge.description.as_deref()),
        ("opaque", challenge.opaque.as_deref()),
    ];
    for (key, value) in &challenge.extensions {
        fields.push((key.as_str(), Some(value.as_str())));
    }
    Ok(format!(
        "Payment {}",
        fields
            .into_iter()
            .filter_map(
                |(key, value)| value.map(|value| format!(r#"{key}="{}""#, escape_quoted(value)))
            )
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub fn parse_www_authenticate_header(header: &str) -> Result<PaymentChallenge, CoreError> {
    let trimmed = header.trim();
    let (scheme, params) = trimmed
        .split_once(char::is_whitespace)
        .ok_or(CoreError::InvalidField("payment challenge scheme"))?;
    if !scheme.eq_ignore_ascii_case("Payment") {
        return Err(CoreError::InvalidField("payment challenge scheme"));
    }
    let parsed = parse_auth_params(params)?;
    let required = |name: &'static str| {
        parsed
            .get(name)
            .cloned()
            .ok_or(CoreError::MissingField(name))
    };
    let known = [
        "id",
        "realm",
        "method",
        "intent",
        "request",
        "expires",
        "digest",
        "description",
        "opaque",
    ];
    let challenge = PaymentChallenge {
        id: required("id")?,
        realm: required("realm")?,
        method: required("method")?,
        intent: required("intent")?,
        request: required("request")?,
        expires: parsed.get("expires").cloned(),
        digest: parsed.get("digest").cloned(),
        description: parsed.get("description").cloned(),
        opaque: parsed.get("opaque").cloned(),
        extensions: parsed
            .into_iter()
            .filter(|(key, _)| !known.contains(&key.as_str()))
            .collect(),
    };
    validate_challenge(&challenge)?;
    Ok(challenge)
}

pub fn authorization_header(credential: &PaymentCredential) -> Result<String, CoreError> {
    Ok(format!("Payment {}", encode_jcs_base64url(credential)?))
}

pub fn decode_authorization_header(header: &str) -> Result<PaymentCredential, CoreError> {
    let mut parts = header.trim().splitn(2, char::is_whitespace);
    if !parts
        .next()
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("Payment"))
    {
        return Err(CoreError::InvalidField("authorization scheme"));
    }
    let token = parts
        .next()
        .map(str::trim_start)
        .filter(|token| !token.is_empty())
        .ok_or(CoreError::MissingField("credential"))?;
    decode_base64url_json(token)
}

pub fn validate_challenge(challenge: &PaymentChallenge) -> Result<(), CoreError> {
    if challenge.id.is_empty()
        || challenge.realm.is_empty()
        || challenge.method != "fiber"
        || challenge.intent != "charge"
        || challenge.request.is_empty()
        || challenge.request.len() > MAX_MPP_REQUEST_PARAMETER_LEN
    {
        return Err(CoreError::InvalidField("challenge"));
    }
    if challenge
        .expires
        .as_ref()
        .is_some_and(|expires| chrono::DateTime::parse_from_rfc3339(expires).is_err())
    {
        return Err(CoreError::InvalidField("expires"));
    }
    if challenge
        .digest
        .as_ref()
        .is_some_and(|digest| !valid_sha256_digest(digest))
    {
        return Err(CoreError::InvalidField("digest"));
    }
    if challenge.description.as_ref().is_some_and(String::is_empty) {
        return Err(CoreError::InvalidField("description"));
    }
    if let Some(opaque) = &challenge.opaque {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(opaque)
            .map_err(|_| CoreError::InvalidField("opaque"))?;
        let value: Value = serde_json::from_slice(&bytes)?;
        if serde_jcs::to_vec(&value).map_err(CoreError::Json)? != bytes {
            return Err(CoreError::InvalidField("opaque"));
        }
        let Some(fields) = value.as_object() else {
            return Err(CoreError::InvalidField("opaque"));
        };
        if fields.values().any(|value| !value.is_string()) {
            return Err(CoreError::InvalidField("opaque"));
        }
    }
    if challenge.extensions.keys().any(|key| {
        let mut bytes = key.bytes();
        !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
            || !bytes.all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            })
    }) {
        return Err(CoreError::InvalidField("challenge extension"));
    }
    Ok(())
}

pub fn validate_fiber_charge_request(request: &FiberChargeRequest) -> Result<(), CoreError> {
    if request.amount.is_empty()
        || request.amount.starts_with('0')
        || !request.amount.bytes().all(|byte| byte.is_ascii_digit())
        || request.currency.is_empty()
        || request.method_details.invoice.is_empty()
        || !is_hash256(&request.method_details.payment_hash)
        || !matches!(
            request.method_details.network.as_str(),
            "mainnet" | "testnet" | "dev"
        )
        || !matches!(
            request.method_details.hash_algorithm.as_str(),
            "ckb_hash" | "sha256"
        )
    {
        return Err(CoreError::InvalidField("fiber charge request"));
    }
    Ok(())
}

pub fn validate_receipt(receipt: &PaymentReceipt) -> Result<(), CoreError> {
    if receipt.status != "success"
        || receipt.method != "fiber"
        || receipt.challenge_id.is_empty()
        || !is_hash256(&receipt.reference)
        || chrono::DateTime::parse_from_rfc3339(&receipt.timestamp).is_err()
    {
        return Err(CoreError::InvalidField("receipt"));
    }
    Ok(())
}

fn valid_sha256_digest(value: &str) -> bool {
    let Some(encoded) = value
        .strip_prefix("sha-256=:")
        .and_then(|value| value.strip_suffix(':'))
    else {
        return false;
    };
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .is_ok_and(|digest| {
            digest.len() == 32
                && base64::engine::general_purpose::STANDARD.encode(digest) == encoded
        })
}

fn is_hash256(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn escape_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn parse_auth_params(input: &str) -> Result<BTreeMap<String, String>, CoreError> {
    let bytes = input.as_bytes();
    let mut result = BTreeMap::new();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b',') {
            index += 1;
        }
        let key_start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'-'))
        {
            index += 1;
        }
        if key_start == index {
            break;
        }
        let key_end = index;
        let key = std::str::from_utf8(&bytes[key_start..index])
            .map_err(|_| CoreError::InvalidField("auth-param"))?
            .to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            if index > key_end && looks_like_auth_param(&bytes[index..]) {
                break;
            }
            return Err(CoreError::InvalidField("auth-param"));
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let mut value = Vec::new();
        if bytes.get(index) == Some(&b'"') {
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                match bytes[index] {
                    b'"' => {
                        index += 1;
                        closed = true;
                        break;
                    }
                    b'\\' if index + 1 < bytes.len() => {
                        index += 1;
                        value.push(bytes[index]);
                        index += 1;
                    }
                    byte => {
                        value.push(byte);
                        index += 1;
                    }
                }
            }
            if !closed {
                return Err(CoreError::InvalidField("auth-param"));
            }
        } else {
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b','
            {
                value.push(bytes[index]);
                index += 1;
            }
        }
        let value = String::from_utf8(value).map_err(|_| CoreError::InvalidField("auth-param"))?;
        if result.insert(key, value).is_some() {
            return Err(CoreError::InvalidField("duplicate auth-param"));
        }
    }
    Ok(result)
}

fn looks_like_auth_param(input: &[u8]) -> bool {
    let mut index = 0;
    while index < input.len() && input[index].is_ascii_whitespace() {
        index += 1;
    }
    let start = index;
    while index < input.len()
        && (input[index].is_ascii_alphanumeric() || matches!(input[index], b'_' | b'-'))
    {
        index += 1;
    }
    if start == index {
        return false;
    }
    while index < input.len() && input[index].is_ascii_whitespace() {
        index += 1;
    }
    input.get(index) == Some(&b'=')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn challenge() -> PaymentChallenge {
        PaymentChallenge {
            id: String::new(),
            realm: "api.example.com".to_string(),
            method: "fiber".to_string(),
            intent: "charge".to_string(),
            request: "eyJhbW91bnQiOiIxMDAwIn0".to_string(),
            expires: Some("2030-01-01T00:00:00Z".to_string()),
            digest: None,
            description: None,
            opaque: None,
            extensions: BTreeMap::new(),
        }
    }

    #[test]
    fn binds_challenge_id_with_base64url_hmac() {
        let mut challenge = challenge();
        challenge
            .extensions
            .insert("vendor-param".to_string(), "round-trip".to_string());
        challenge.id = bind_challenge_id(&challenge, "secret").unwrap();
        assert!(verify_challenge_id(&challenge, &["secret".to_string()]));
        let header = www_authenticate_header(&challenge).unwrap();
        assert!(header.contains("realm=\"api.example.com\""));
        assert_eq!(parse_www_authenticate_header(&header).unwrap(), challenge);
        assert_eq!(
            parse_www_authenticate_header(&header.replace("realm=", "Realm=")).unwrap(),
            challenge
        );
        assert!(parse_www_authenticate_header(&format!("{header}, ID=\"duplicate\"")).is_err());
    }

    #[test]
    fn formats_rfc9530_sha256_digest() {
        assert_eq!(
            body_digest(b"abc"),
            "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:"
        );
    }

    #[test]
    fn rejects_invalid_standard_metadata() {
        let mut challenge = challenge();
        challenge.expires = Some("not-a-time".to_string());
        assert!(validate_challenge(&challenge).is_err());

        let receipt = PaymentReceipt {
            status: "success".to_string(),
            method: "fiber".to_string(),
            timestamp: "not-a-time".to_string(),
            reference: format!("0x{}", "ab".repeat(32)),
            challenge_id: "challenge".to_string(),
            extensions: BTreeMap::new(),
        };
        assert!(validate_receipt(&receipt).is_err());
    }

    #[test]
    fn accepts_standard_non_jcs_authorization_credentials() {
        let mut challenge = challenge();
        challenge.id = bind_challenge_id(&challenge, "secret").unwrap();
        let credential = PaymentCredential {
            challenge,
            source: None,
            payload: FiberCredentialPayload {
                payment_hash: format!("0x{}", "ab".repeat(32)),
                extensions: BTreeMap::new(),
            },
            extensions: BTreeMap::new(),
        };
        let pretty = serde_json::to_string_pretty(&credential).unwrap();
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(pretty);
        assert_eq!(
            decode_authorization_header(&format!("Payment {token}")).unwrap(),
            credential
        );
    }
}
