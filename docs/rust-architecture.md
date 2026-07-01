# Rust Architecture

The Rust workspace under `crates/` is the canonical protocol core and verifier target. The core, storage traits, Fiber RPC method-shape parity, F402/F-L402 helpers, Axum gateway, and CLI vector/receipt verification are the current trusted Rust surfaces.

```text
crates/fiber-paid-http-core     canonical hashes, signatures, vector verification
crates/fiber-paid-http-storage  replay storage trait and SQLite durable store
crates/fiber-paid-http-fiber    Fiber JSON-RPC method names, hex quantities, status semantics
crates/fiber-paid-http-f402     F402 proof/credential compatibility helpers
crates/fiber-paid-http-fl402    F-L402 macaroon/preimage verification helpers
crates/fiber-paid-http-server   Axum/Tower HTTP 402 gateway with optional L402 authorization
crates/fiber-paid-http-cli      fiber-paid-http-rs binary
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
