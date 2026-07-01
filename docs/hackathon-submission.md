# Hackathon Submission

## Project Summary

FiberMPP is Fiber Paid HTTP infrastructure for metered APIs, agents, and service access. It keeps the existing `fiber-mpp` repo and CLI name, but presents the project as a protocol-family gateway: MPP + Fiber as the primary envelope, F402 conversion for Fiber-native 402 applications, and F-L402 `macaroon:preimage` compatibility for L402-style clients.

## Selected Category

Merchant, Liquidity, LSP, and Multi-Asset Infrastructure.

## Infrastructure Gap Addressed

Fiber has strong micropayment primitives, but developers still need reusable service-metering infrastructure for pay-as-you-go products, subscriptions, API access, and micropayments. FiberMPP supplies middleware, a Rust gateway, client helpers, CLI tooling, conformance vectors, replay protection, receipts, and compatibility adapters without becoming a wallet, checkout product, marketplace, or Fiber node dashboard.

## Fully Working

- MPP-style 402 challenge.
- `WWW-Authenticate: Payment`.
- `Authorization: Payment` retry.
- `Payment-Receipt`.
- Optional `WWW-Authenticate: L402` challenge issuance.
- Optional `Authorization: L402 macaroon:preimage` retry in both TS middleware and Rust gateway.
- F402 conversion.
- F-L402 TS and Rust adapters.
- Local Fiber E2E payment flow.
- Route middleware.
- Reverse proxy helper.
- Client helper.
- Fiber preflight and live E2E test lane.
- Role-aware `doctor` checks for Fiber RPC, peers, and `ChannelReady` channels.
- Local evidence API and evidence console.
- Security tests for replay, wrong resource, wrong method, wrong amount, expiry, no-store, signatures, wrong F-L402 preimage, and tampered F-L402 macaroon.
- Shared TypeScript/Rust conformance vectors.

## Real Fiber Status

The adapter supports Fiber JSON-RPC method names from the current Fiber repo. Settlement requires `FIBER_MODE=local` or `testnet`, payer/payee Fiber RPC URLs, and a working Fiber node/channel environment. Offline payment mode has been removed.

## How to Run

```bash
pnpm install
pnpm build
pnpm evidence:api
pnpm evidence:web
```

Enable F-L402 challenge issuance by setting a root key and passing the F-L402 config in middleware or Rust gateway config:

```bash
export FIBER_MPP_FL402_ROOT_KEY="$(openssl rand -hex 32)"
```

## How to Test

```bash
pnpm test
pnpm test:integration
pnpm exec fiber-mpp vectors verify
cargo run -p fiber-mpp-cli -- vectors verify
bash scripts/fiber_mpp_gate.sh
```

## Roadmap

- Redis-compatible production store implementation.
- Stronger paid-but-denied mitigation.
- Native x402 adapter once Fiber node verify/settle support is stable.
- More payer-side integrations through Fiber clients or fiber-pay without moving wallet custody into FiberMPP.

## Submission Readiness

Ready for local and testnet Fiber evidence presentation when the configured payer/payee nodes are funded, connected, and `ChannelReady`. Production readiness remains evidence-gated by the committed gate reports.
