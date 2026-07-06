# Security

Fiber Paid HTTP is built around explicit challenge, credential, payment, and receipt binding.

Implemented checks:

- resource binding,
- method binding,
- amount binding for Fiber shannons,
- expiry,
- nonce,
- challenge HMAC,
- single-use challenge redemption,
- single-use credential hash,
- replay rejection,
- wrong resource rejection,
- wrong method rejection,
- wrong payment hash rejection,
- wrong amount rejection,
- `Cache-Control: no-store` on 402 responses,
- signed receipts,
- durable storage requirement for replay and receipt state.

Partial mitigations:

- Paid-but-denied: the middleware redeems before serving to prevent unpaid-service replay. This does not make handler execution atomic with payment settlement.
- Unpaid-service: protected handlers run only after credential and payment proof verification.
- Clock skew: configurable skew is available; demos use low skew.
- PII minimization: challenges carry only route/resource/payment metadata by default.

Tests cover the required security cases in `tests/unit` and `tests/integration`.

For the attack-by-attack evidence map, see [security-matrix.md](security-matrix.md) and `reports/security-matrix.json`. The matrix links each covered attack to the expected rejection code, implemented test, and vector file.
