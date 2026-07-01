# Security Matrix

This matrix is generated as JSON by `pnpm exec fiber-mpp vectors generate` at `reports/security-matrix.json`. The Markdown copy is the human review surface for the TypeScript conformance oracle.

| attack | expected rejection | implemented test | vector file | status |
| --- | --- | --- | --- | --- |
| replay | `replay` | `tests/integration/full-flow.test.ts` and vector verification | `test-vectors/attack.replay.json` | covered |
| wrong resource | `wrong-resource` | `tests/integration/full-flow.test.ts` and vector verification | `test-vectors/attack.wrong-resource.json` | covered |
| wrong amount | `wrong-amount` | `tests/unit/middleware.test.ts` and vector verification | `test-vectors/attack.wrong-amount.json` | covered |
| wrong method | `wrong-method` | `tests/unit/middleware.test.ts` and vector verification | `test-vectors/attack.wrong-method.json` | covered |
| expired challenge | `expired-challenge` | `tests/integration/full-flow.test.ts`, `tests/unit/middleware.test.ts`, and vector verification | `test-vectors/attack.expired-challenge.json` | covered |
| tampered receipt | `bad-receipt-signature` | vector verification | `test-vectors/attack.tampered-receipt.json` | covered |
| F-L402 wrong preimage | `wrong-preimage` | `tests/unit/fl402.test.ts` and vector verification | `test-vectors/attack.fl402-wrong-preimage.json` | covered |
| F-L402 tampered macaroon | `bad-fl402-macaroon-signature` | `tests/unit/fl402.test.ts` and vector verification | `test-vectors/attack.fl402-tampered-macaroon.json` | covered |

Production readiness remains blocked after local-only Fiber evidence. The gate can set `production_ready_for_fiber_method: true` only while separate testnet Fiber E2E evidence, production operations gates, and production bootstrap E2E readiness evidence are all present.
