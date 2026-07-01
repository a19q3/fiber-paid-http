# Rust Canonical Core

Fiber Paid HTTP is migrating toward a single production trusted boundary:

```text
Rust = canonical protocol engine and verifier
TypeScript = SDK, middleware, demos, examples, F402/F-L402/MPP JS integration, vector tooling
test-vectors = shared protocol truth
```

TypeScript is not a production verifier. It remains maintained because it is useful for JS ecosystem integration, browser clients, compatibility examples, and historical conformance-vector generation.

## Runtime Policy

Trusted verification flows go through Rust where the Rust surface exists today:

```bash
cargo run -p fiber-paid-http-cli -- vectors verify
cargo run -p fiber-paid-http-cli -- receipt verify <file>
cargo run -p fiber-paid-http-cli -- challenge inspect <file>
```

TypeScript remains explicit:

```bash
pnpm exec fiber-paid-http --engine typescript vectors verify
```

A future Node wrapper should call the Rust engine for trusted verification rather than silently falling back to a TypeScript verifier. If an engine selector is added, it must report `FIBER_PAID_HTTP_ENGINE=rust|typescript` and log any fallback clearly.

The Rust HTTP server crate now covers signed challenge issuance, durable replay storage, Fiber method adapter calls, receipt issuance, and optional F-L402 `Authorization: L402` retries.

## Gates

Rust canonical gate:

```bash
bash scripts/fiber_paid_http_rust_gate.sh
```

TypeScript compatibility/vector harness gate:

```bash
bash scripts/fiber_paid_http_gate.sh
```

Canonical parity gate:

```bash
bash scripts/fiber_paid_http_canonical_gate.sh
```

The canonical gate writes `reports/canonical-core-parity.json` and fails if Rust and the TypeScript vector harness disagree on vector result, canonical hash, receipt shape, F402 compatibility, F-L402 compatibility, Fiber RPC method semantics, or error code.
