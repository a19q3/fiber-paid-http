# Rust Architecture

The Rust workspace under `crates/` is the canonical production trusted boundary.

```text
crates/fiber-mpp-core     canonical hashes, signatures, vector verification
crates/fiber-mpp-storage  replay storage trait, memory store, SQLite durable store
crates/fiber-mpp-fiber    Fiber JSON-RPC method names, hex quantities, status semantics
crates/fiber-mpp-f402     F402 proof/credential compatibility helpers
crates/fiber-mpp-server   Axum/Tower HTTP 402 gateway boundary
crates/fiber-mpp-cli      fiber-mpp-rs binary
```

## Trusted Boundary

Rust owns the only production verification boundary:

- canonical JSON hashing,
- challenge HMAC verification,
- receipt HMAC verification,
- resource binding,
- amount binding,
- method binding,
- expiry rejection,
- replay store boundary,
- Fiber RPC method-shape parity.
- Axum/Tower gateway behavior that returns visible `402` payment-required responses without marking production readiness.

TypeScript remains a maintained JS integration layer and vector harness. It must continue to pass its own compatibility gate, but it is not a production trusted boundary.
