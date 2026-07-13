# Rust conformance

Run:

```bash
cargo run -p fiber-paid-http-cli -- vectors verify
```

The verifier loads every JSON file in `test-vectors/`, computes its JCS SHA-256, executes the Rust case verifier, and writes `reports/rust-conformance.json`.

The canonical gate compares that report with `reports/ts-conformance.json`. A fixture passes parity only when both engines agree on:

- file presence;
- canonical hash;
- accepted or rejected result;
- exact error code;
- fixture pass state.

The Rust HTTP tests additionally cover real gateway control flow: standard challenge issuance, settled credential acceptance, concurrent/replayed redemption rejection, upstream failure without receipt, and HTTPS configuration validation.
