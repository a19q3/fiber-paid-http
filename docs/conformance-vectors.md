# Conformance Vectors

The vector suite under `test-vectors/` freezes the canonical JSON inputs, hashes, accepted/rejected outcomes, and rejection codes that Rust and TypeScript must preserve.

## Commands

Regenerate deterministic vectors and refresh local Fiber evidence vectors:

```bash
pnpm exec fiber-mpp vectors generate
```

Verify all vectors against the current TypeScript implementation:

```bash
pnpm exec fiber-mpp vectors verify
```

The CLI binary is built output, so after source edits run `pnpm --filter @fiber-mpp/cli build` before invoking these commands directly.

## Vector Schema

Every vector includes:

```json
{
  "input": {},
  "expected_canonical_hash": "sha256(canonicalJson(input))",
  "expected_verification_result": "accepted",
  "expected_error_code": "only present for rejected vectors",
  "notes": "review context"
}
```

`expected_canonical_hash` is always recomputed from canonical JSON and compared before protocol verification. Rejected vectors must match both `expected_verification_result: "rejected"` and the exact `expected_error_code`.

## Deterministic Fixtures

These files are deterministic and must regenerate byte-for-byte from TypeScript constants unless the oracle intentionally changes:

```text
challenge.valid.json
credential.valid.json
receipt.valid.json
resource.hash.valid.json
f402.challenge.valid.json
f402.credential.valid.json
fl402.challenge.valid.json
fl402.credential.valid.json
attack.replay.json
attack.wrong-resource.json
attack.wrong-amount.json
attack.wrong-method.json
attack.expired-challenge.json
attack.tampered-receipt.json
attack.fl402-wrong-preimage.json
attack.fl402-tampered-macaroon.json
```

The verifier exercises the same TypeScript parsing, signing, resource hashing, middleware verification, F402 conversion, F-L402 preimage/macaroon verification, replay storage, and receipt signature checks that production code uses. The Rust verifier must agree on all 18 shared vectors.

## Live Fiber Evidence

These files are evidence, not deterministic fixtures:

```text
fiber.local-e2e.receipt.json
fiber.local-e2e.report.json
```

`vectors generate` copies the latest successful local Fiber E2E report. It first uses a currently passed `reports/fiber-mpp-gate.json`; otherwise it uses the preserved `reports/fiber-local-e2e-success.json` snapshot. The gate refreshes that snapshot only when the live local Fiber E2E actually passes. When available, vector generation also reads the live receipt from `.tmp/fiber-live-e2e.sqlite`; the fixture omits HMAC signing secrets and treats the live run as the receipt-signature verification boundary. Regenerating after a new live Fiber payment will change these evidence hashes.
