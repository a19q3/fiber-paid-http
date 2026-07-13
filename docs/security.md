# Security

## Enforced invariants

- Standard MPP challenges are server-bound with HMAC-SHA256 and verified in constant time.
- Credentials must exactly echo the stored challenge.
- Resource URL and method are bound; non-GET/HEAD requests also bind an RFC 9530 body digest.
- Challenge expiry is mandatory.
- Fiber payment hash, amount, currency, invoice, network, and settlement status are checked.
- SQLite redemption is atomic; challenge, credential hash, and payment hash cannot be reused.
- Upstream failure never produces a receipt.
- Upstream-supplied `Payment-Receipt` is removed.
- Authentication material and payment secrets are redacted from logs and omitted from storage.
- Internal RPC and upstream errors are not returned to clients.
- Production resource binding uses configured HTTPS `public_base_url`.

## Secret handling

Gateway secrets, previous challenge-binding secrets, F-L402 root keys, and RPC credentials are environment-only and must contain at least 32 characters. Rotate challenge secrets by configuring a new active secret and a short previous-secret window; all newly issued challenges use only the active secret.

Never log or persist authorization credentials, capabilities, preimages, invoices, or RPC authentication.

## Delivery semantics

Payment settlement and service delivery are separate facts. The redemption is consumed before the upstream request to prevent double execution. If delivery fails after payment, the durable delivery outcome is marked failed and operators reconcile by `challengeId` and payment-hash `reference`. A retry cannot silently execute the service again.

## Evidence boundary

Only the Rust gateway is a trusted production verifier. TypeScript tests and vector tooling are parity evidence, not an authorization authority. Production readiness also requires live Fiber evidence for the current Fiber commit and current protocol receipt schema.
