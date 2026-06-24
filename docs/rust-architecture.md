# Rust Architecture

The Rust workspace under `crates/` is the canonical protocol core and verifier target. The core, storage traits, Fiber RPC method-shape parity, F402 helpers, and CLI vector/receipt verification are the current trusted Rust surfaces. The Axum server crate is still a gateway prototype and must not be treated as feature-complete production middleware.

```text
crates/fiber-mpp-core     canonical hashes, signatures, vector verification
crates/fiber-mpp-storage  replay storage trait and SQLite durable store
crates/fiber-mpp-fiber    Fiber JSON-RPC method names, hex quantities, status semantics
crates/fiber-mpp-f402     F402 proof/credential compatibility helpers
crates/fiber-mpp-server   Axum/Tower HTTP 402 gateway prototype
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
- Fiber RPC method-shape parity.

Current Rust server status:

- returns visible `402 Payment Required` responses,
- sets `Cache-Control: no-store`,
- does not yet issue signed challenges,
- does not yet persist challenges, receipts, or replay state,
- does not yet call the Fiber RPC adapter,
- must not be represented as production-ready gateway middleware.

TypeScript remains a maintained JS integration layer and vector harness. It must continue to pass its own compatibility gate, but it is not a production trusted boundary.
