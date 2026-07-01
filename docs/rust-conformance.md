# Rust Conformance

Rust verifies the same `test-vectors/` suite as TypeScript.

```bash
cargo run -p fiber-mpp-cli -- vectors verify
```

The command writes:

```text
reports/rust-conformance.json
```

The TypeScript verifier writes:

```text
reports/ts-conformance.json
```

The canonical gate compares those reports for:

- vector count,
- per-vector pass/fail result,
- canonical hash,
- rejection error code,
- receipt vector pass status,
- F402 vector pass status,
- F-L402 vector and attack-vector pass status.

Rust is the canonical verifier. The TypeScript report is a compatibility/vector-harness check, not a second production trusted boundary.

The shared protocol truth remains:

```text
test-vectors/
reports/security-matrix.json
docs/conformance-vectors.md
docs/security-matrix.md
```
