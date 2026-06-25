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
- Local Fiber E2E payment flow.
- Route middleware.
- Reverse proxy helper.
- Client helper.
- Fiber preflight and live E2E test lane.
- Role-aware `doctor` checks for Fiber RPC, peers, and `ChannelReady` channels.
- Local evidence API and evidence console.
- Security tests for replay, wrong resource, wrong method, wrong amount, expiry, no-store, and signatures.
- F402 conversion.

## Real Fiber status

The adapter supports Fiber JSON-RPC method names from the current Fiber repo. Settlement requires `FIBER_MODE=local` or `testnet`, payer/payee Fiber RPC URLs, and a working Fiber node/channel environment. Offline payment mode has been removed.

## How to run

```bash
pnpm install
pnpm build
pnpm evidence:api
pnpm evidence:web
```

## How to test

```bash
pnpm test
pnpm test:integration
bash scripts/fiber_mpp_gate.sh
```

## Roadmap

- Redis-compatible production store implementation.
- Stronger paid-but-denied mitigation.
- Separate testnet Fiber E2E evidence.

## Submission readiness

Ready for local Fiber evidence collection when the local 3-node network is running. Not ready to claim production readiness until testnet Fiber E2E evidence and the Rust HTTP gateway production implementation are complete.
