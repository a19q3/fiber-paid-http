# Production readiness

Production readiness is fail-closed. Passing unit tests is necessary but does not by itself prove a deployable Fiber payment path.

## Required configuration

- Rust gateway executable and Rust canonical verifier.
- `realm` and an HTTPS `public_base_url`.
- SQLite storage; in-memory storage is not accepted.
- Active secret and any rotation secrets supplied through environment variables, each at least 32 characters.
- `FIBER_MODE=local|testnet` and real payer/payee Fiber RPC connectivity for live evidence.
- RPC authentication from environment variables.
- Explicit positive smallest-unit charge configuration.
- TLS termination, request limits, rate limiting, health checks, metrics, backups, and alerting.

## Runtime gates

The gateway must demonstrate:

1. an unpaid request returns the MPP-draft `402` challenge and `no-store`;
2. a real Fiber payment reaches `Success` / `Paid`;
3. the standard credential produces one upstream `2xx` delivery;
4. the MPP-draft receipt has a payment-hash `reference` and matching `challengeId` extension;
5. replay returns a fresh `402` and does not execute upstream;
6. SQLite uses WAL, foreign keys, and passes integrity checks;
7. the intentional response-limit and timeout probes produce exactly two isolated paid-but-undelivered records, with no unexpected failed delivery;
8. logs contain no authorization, invoice, capability, preimage, secret, or RPC authentication value;
9. the Rust gateway's `/readyz`, `/metrics`, request/response size limits, upstream timeout, rate limiter, header stripping, TLS-terminated public flow, and graceful SIGINT shutdown are exercised.

## Evidence freshness

`production_ready_for_fiber_method` can be true only when:

- preserved testnet evidence verifies against the current Fiber commit;
- the evidence contains the MPP-draft receipt reference and project challenge ID extension;
- production bootstrap evidence passes;
- production operations checks pass;
- the aggregate gate has no blocker.

A protocol or evidence-schema change invalidates earlier evidence. The gate must remain red until a new live run is recorded.

Generate both current testnet and Rust production-bootstrap evidence with:

```bash
FIBER_MODE=testnet \
FIBER_PAYER_RPC_URL=http://127.0.0.1:8227 \
FIBER_PAYEE_RPC_URL=http://127.0.0.1:8237 \
FIBER_PAYER_RPC_AUTH='Bearer <trusted-rpc-proxy-token>' \
FIBER_PAYEE_RPC_AUTH='Bearer <trusted-rpc-proxy-token>' \
FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)" \
bash scripts/fiber_testnet_e2e.sh
```

## Failure semantics

The challenge is consumed before upstream execution. An upstream failure therefore becomes a paid-but-undelivered record, not an automatic second execution. Operators reconcile the payment or deliver the service through an audited manual workflow described in `docs/production-operations.md`.
