# Hackathon Submission

## Project summary

FiberMPP makes Fiber usable as a payment method inside Machine Payments Protocol. It also includes F402 compatibility for Fiber-native HTTP 402 applications.

## Selected category

Fiber infrastructure.

## Infrastructure gap addressed

Fiber has strong micropayment primitives, but MPP-style paid HTTP services need reusable middleware, client helpers, CLI tooling, and compatibility layers. FiberMPP supplies those pieces without becoming an AI marketplace or checkout product.

## Fully working

- MPP-style 402 challenge.
- `WWW-Authenticate: Payment`.
- `Authorization: Payment` retry.
- `Payment-Receipt`.
- Fiber mock payment flow.
- Route middleware.
- Reverse proxy helper.
- Client helper.
- CLI smoke test.
- Demo API and demo web UI.
- Security tests for replay, wrong resource, wrong method, wrong amount, expiry, no-store, and signatures.
- F402 conversion.

## Mocked or simulated

- Default Fiber mode is mock and receipts say `simulated`.
- Stripe and Tempo are mock/sandbox placeholders.

## Real Fiber status

The adapter supports Fiber JSON-RPC method names from the current Fiber repo. Real settlement requires `FIBER_MODE=local` or `testnet`, `FIBER_RPC_URL`, and a working Fiber node/channel environment.

## How to run

```bash
pnpm install
pnpm build
pnpm --filter @fiber-mpp/demo-api start
pnpm --filter @fiber-mpp/demo-web start
```

## How to test

```bash
pnpm test
pnpm test:integration
bash scripts/fiber_mpp_gate.sh
```

## Roadmap

- Real Fiber E2E harness.
- Redis-compatible production store implementation.
- Stronger paid-but-denied mitigation.
- More complete `doctor` diagnostics.
- Optional Stripe/Tempo sandbox integration with credentials.

## Submission readiness

Ready for a hackathon demo with honest mock/live labeling. Not ready to claim live Fiber production settlement until real Fiber E2E tests pass.
