# Conformance vectors

`test-vectors/` is the shared protocol truth for Rust and TypeScript. Each JSON fixture records its input, expected result, optional expected error code, and canonical SHA-256.

## Deterministic fixtures

- `challenge.valid.json`
- `credential.valid.json`
- `receipt.valid.json`
- `resource.hash.valid.json`
- `f402.challenge.valid.json`
- `f402.credential.valid.json`
- `x402.required.valid.json`
- `x402.payload.valid.json`
- `x402.settlement.valid.json`
- `fl402.challenge.valid.json`
- `fl402.credential.valid.json`
- `attack.replay.json`
- `attack.wrong-resource.json`
- `attack.wrong-amount.json`
- `attack.wrong-method.json`
- `attack.expired-challenge.json`
- `attack.receipt-on-error.json`
- `attack.fl402-wrong-preimage.json`
- `attack.fl402-tampered-capability.json`
- `attack.x402-tampered-requirement.json`

## Evidence fixtures

- `fiber.local-e2e.receipt.json`
- `fiber.local-e2e.report.json`

The receipt fixture requires the draft fields `status`, `method`, `timestamp`, and `reference`, plus the project correlation extension `challengeId`. It has no receipt-specific signature field.

## Commands

```bash
pnpm exec fiber-paid-http vectors generate
pnpm exec fiber-paid-http vectors verify
cargo run -p fiber-paid-http-cli -- vectors verify
bash scripts/fiber_paid_http_canonical_gate.sh
```

Adding a fixture requires a verifier case in both `packages/cli/src/vectors.ts` and `crates/fiber-paid-http-core/src/lib.rs`. The canonical gate fails if either stack is missing a fixture or disagrees on bytes, result, or error code.
