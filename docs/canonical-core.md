# Rust Canonical Core

FiberMPP is migrating toward a single production trusted boundary:

```text
Rust = canonical protocol engine and verifier
TypeScript = SDK, demos, examples, F402/MPP JS integration, vector tooling
test-vectors = shared protocol truth
```

TypeScript is not a production verifier. It remains maintained because it is useful for JS ecosystem integration, browser clients, compatibility examples, and historical conformance-vector generation.

## Runtime Policy

Trusted verification flows go through Rust where the Rust surface exists today:

```bash
cargo run -p fiber-mpp-cli -- vectors verify
cargo run -p fiber-mpp-cli -- receipt verify <file>
cargo run -p fiber-mpp-cli -- challenge inspect <file>
```

TypeScript remains explicit:

```bash
pnpm exec fiber-mpp --engine typescript vectors verify
```

A future Node wrapper should call the Rust engine for trusted verification rather than silently falling back to a TypeScript verifier. If an engine selector is added, it must report `FIBER_MPP_ENGINE=rust|typescript` and log any fallback clearly.

The Rust HTTP server crate is not yet the production gateway. It currently proves the visible `402 Payment Required` boundary only; signed challenge issuance, durable replay storage, Fiber method adapter calls, and receipt issuance still need to be implemented in Rust before server traffic is part of the production trusted path.

## Gates

Rust canonical gate:

```bash
bash scripts/fiber_mpp_rust_gate.sh
```

TypeScript compatibility/vector harness gate:

```bash
bash scripts/fiber_mpp_gate.sh
```

Canonical parity gate:

```bash
bash scripts/fiber_mpp_canonical_gate.sh
```

The canonical gate writes `reports/canonical-core-parity.json` and fails if Rust and the TypeScript vector harness disagree on vector result, canonical hash, receipt shape, F402 compatibility, Fiber RPC method semantics, or error code.
