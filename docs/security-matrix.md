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

Production readiness remains blocked after local-only Fiber evidence. The gate must keep `production_ready_for_fiber_method: false` until testnet Fiber E2E evidence and operational hardening are present.
