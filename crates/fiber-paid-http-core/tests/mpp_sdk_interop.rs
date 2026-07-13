use fiber_paid_http_core::{
    authorization_header, bind_challenge_id, decode_authorization_header,
    encode_fiber_charge_request, encode_jcs_base64url, www_authenticate_header,
    FiberChargeMethodDetails, FiberChargeRequest, FiberCredentialPayload, PaymentChallenge,
    PaymentCredential, PaymentReceipt,
};
use mpp::{parse_authorization, parse_receipt, parse_www_authenticate};
use std::collections::BTreeMap;

const PAYMENT_HASH: &str = "0x4242424242424242424242424242424242424242424242424242424242424242";

fn challenge() -> PaymentChallenge {
    let request = FiberChargeRequest {
        amount: "100".to_string(),
        currency: "ckb".to_string(),
        recipient: None,
        description: None,
        external_id: None,
        method_details: FiberChargeMethodDetails {
            invoice: "fibt1qinteropfixture".to_string(),
            payment_hash: PAYMENT_HASH.to_string(),
            network: "testnet".to_string(),
            hash_algorithm: "ckb_hash".to_string(),
            udt_type_script: None,
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    };
    let mut challenge = PaymentChallenge {
        id: "pending".to_string(),
        realm: "interop.example.test".to_string(),
        method: "fiber".to_string(),
        intent: "charge".to_string(),
        request: encode_fiber_charge_request(&request).unwrap(),
        expires: Some("2030-01-01T00:00:00.000Z".to_string()),
        digest: None,
        description: None,
        opaque: None,
        extensions: BTreeMap::new(),
    };
    challenge.id = bind_challenge_id(&challenge, "mpp-sdk-interop-secret-at-least-16").unwrap();
    challenge
}

#[test]
fn current_mpp_rust_sdk_reads_gateway_envelopes() {
    let challenge = challenge();
    let parsed = parse_www_authenticate(&www_authenticate_header(&challenge).unwrap()).unwrap();
    assert_eq!(parsed.id, challenge.id);
    assert_eq!(parsed.method.as_str(), "fiber");
    assert_eq!(parsed.request.raw(), challenge.request);

    let credential = PaymentCredential {
        challenge,
        source: None,
        payload: FiberCredentialPayload {
            payment_hash: PAYMENT_HASH.to_string(),
            extensions: BTreeMap::new(),
        },
        extensions: BTreeMap::new(),
    };
    let parsed = parse_authorization(&authorization_header(&credential).unwrap()).unwrap();
    assert_eq!(parsed.payload["paymentHash"], PAYMENT_HASH);

    let receipt = PaymentReceipt {
        status: "success".to_string(),
        method: "fiber".to_string(),
        timestamp: "2026-07-13T00:00:00.000Z".to_string(),
        reference: PAYMENT_HASH.to_string(),
        challenge_id: credential.challenge.id,
        extensions: BTreeMap::new(),
    };
    let parsed = parse_receipt(&encode_jcs_base64url(&receipt).unwrap()).unwrap();
    assert_eq!(parsed.method.as_str(), "fiber");
    assert_eq!(parsed.reference, PAYMENT_HASH);
}

#[test]
fn gateway_accepts_non_jcs_credential_json_from_current_mpp_sdk() {
    let challenge = challenge();
    let official = mpp::PaymentCredential::new(
        mpp::ChallengeEcho {
            id: challenge.id.clone(),
            realm: challenge.realm.clone(),
            method: challenge.method.as_str().into(),
            intent: challenge.intent.as_str().into(),
            request: mpp::protocol::core::Base64UrlJson::from_raw(challenge.request.clone()),
            expires: challenge.expires.clone(),
            digest: challenge.digest.clone(),
            opaque: None,
        },
        serde_json::json!({ "paymentHash": PAYMENT_HASH }),
    );
    let header = mpp::format_authorization(&official).unwrap();
    let parsed = decode_authorization_header(&header).unwrap();
    assert_eq!(parsed.challenge, challenge);
    assert_eq!(parsed.payload.payment_hash, PAYMENT_HASH);
}
