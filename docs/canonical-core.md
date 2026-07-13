# Canonical core

The Rust core is the authoritative production implementation of the MPP wire model.

## Canonicalization

Both engines use RFC 8785 JCS where this project needs deterministic bytes. Rust uses `serde_jcs`; TypeScript uses `json-canonicalize`. Canonical bytes feed:

- challenge HMAC binding;
- credential hashes;
- resource hashes;
- the challenge `request` and optional `opaque` base64url values;
- conformance fixture hashes.

Undefined TypeScript properties are excluded before validation. BigInt and non-JSON values are rejected.

The MPP credential and receipt envelopes are base64url-encoded JSON, not JCS-only formats. Their decoders accept valid member ordering and whitespace from other SDKs, while this toolkit emits deterministic JCS. Interoperability tests exercise `mppx 0.8.6` and Rust `mpp 0.10.4` in both directions.

## Bindings

- Resource hash: SHA-256 over JCS `{method,url,digest?,contentType?}`.
- Body digest: RFC 9530 `sha-256=:base64:` over raw bytes.
- Challenge ID: base64url HMAC-SHA256 over the ordered challenge binding fields.
- Credential hash: SHA-256 over the complete canonical credential.

MAC verification uses constant-time comparison in both engines.

## Parity

`scripts/fiber_paid_http_canonical_gate.sh` regenerates and verifies all 22 shared fixtures. It compares the TypeScript and Rust report for:

- fixture presence;
- canonical hash;
- accepted or rejected result;
- exact error code;
- overall pass state.

The deterministic set includes exact x402 v2 requirement, payload, settlement-response, and tampered-requirement parity.

The two live-evidence fixtures validate the evidence schema but do not turn TypeScript into a production verifier.
