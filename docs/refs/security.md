# Security Reference Notes

The x402 attack literature highlights five families of practical failures:

- weak authorization checks,
- missing resource or amount binding,
- replayable credentials,
- web-layer handling mistakes,
- paid-but-denied or unpaid-service outcomes.

Fiber Paid HTTP implemented mitigations:

- Challenge HMAC over canonical JSON.
- Credential resource hash check against the original challenge and current request.
- Method binding by matching credential method to the selected challenge method.
- Fiber payment hash and amount binding in the Fiber adapter.
- Expiry checks with configurable clock skew.
- Single-use challenge and credential storage.
- `Cache-Control: no-store` on 402 and error responses.
- Receipts signed separately from challenges.

Known limit:

- A simple pay-then-serve HTTP flow cannot fully eliminate paid-but-denied if the protected handler crashes after payment redemption. The current middleware marks credentials used before serving to prevent unpaid-service replay and records failed delivery outcomes for operator reconciliation. Stronger atomic delivery/payment coupling and business compensation policy are future work.
