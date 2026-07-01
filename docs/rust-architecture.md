# Rust Architecture

The Rust workspace under `crates/` is the canonical protocol core and verifier target. The core, storage traits, Fiber RPC method-shape parity, F402/F-L402 helpers, Axum gateway, and CLI vector/receipt verification are the current trusted Rust surfaces.

```text
crates/fiber-mpp-core     canonical hashes, signatures, vector verification
crates/fiber-mpp-storage  replay storage trait and SQLite durable store
crates/fiber-mpp-fiber    Fiber JSON-RPC method names, hex quantities, status semantics
crates/fiber-mpp-f402     F402 proof/credential compatibility helpers
crates/fiber-mpp-fl402    F-L402 macaroon/preimage verification helpers
crates/fiber-mpp-server   Axum/Tower HTTP 402 gateway with optional L402 authorization
crates/fiber-mpp-cli      fiber-mpp-rs binary
```

## Trusted Boundary

Rust owns the intended production verification boundary:

- canonical JSON hashing,
- challenge HMAC verification,
- receipt HMAC verification,
- resource binding,
- amount binding,
- method binding,
- expiry rejection,
- replay store boundary,
- F-L402 macaroon/preimage verification,
- Fiber RPC method-shape parity.

Current Rust server status:

- returns visible `402 Payment Required` responses,
- sets `Cache-Control: no-store`,
- issues signed MPP challenges,
- optionally issues F-L402 challenge bodies and `WWW-Authenticate: L402`,
- accepts `Authorization: Payment` and optional `Authorization: L402`,
- persists challenges, receipts, and replay state in SQLite,
- calls the Fiber RPC adapter for settlement checks.

TypeScript remains a maintained JS integration layer, middleware package, compatibility adapter layer, evidence console, and vector harness. It must continue to pass its own compatibility gate, but production verification should use Rust.
