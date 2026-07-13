# Rust architecture

Rust owns the production authorization decision.

```text
fiber-paid-http-core     MPP model, JCS, headers, bindings, vectors
fiber-paid-http-fiber    Fiber JSON-RPC and settlement polling
fiber-paid-http-storage  SQLite state and atomic redemption
fiber-paid-http-f402     F402 mapping
fiber-paid-http-x402     x402 v2 exact/Fiber boundary mapping
fiber-paid-http-fl402    F-L402 capability and preimage verification
fiber-paid-http-server   Axum gateway and upstream delivery
fiber-paid-http-cli      Verification and server commands
```

The server performs async Fiber RPC without holding the SQLite mutex. It reacquires the store only for the atomic redemption and later delivery/receipt writes.

Dynamic protocol extensions use flattened `BTreeMap<String, Value>` fields so serialization order is deterministic. HMACs use the `hmac` crate; JSON canonicalization uses `serde_jcs`; dynamic vector input uses `serde_json::Value`.

The Rust CLI exposes `vectors verify`, `receipt verify`, `challenge inspect`, `doctor`, and `server --config`. There is one binary name: `fiber-paid-http-rs`.
