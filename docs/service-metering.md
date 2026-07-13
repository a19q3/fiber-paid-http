# Service Metering On Fiber

Fiber Paid HTTP targets the service-metering slice of the Merchant, Liquidity, LSP, and Multi-Asset Infrastructure category.

The infrastructure gap is simple: Fiber can settle fast off-chain payments, but most API and service developers do not want to write their own payment gateway, receipt verifier, replay store, Fiber RPC polling loop, compatibility adapters, and audit evidence pipeline before they can charge for a resource.

Fiber Paid HTTP provides that missing middle layer.

## What Service Metering Needs

A metered service needs more than "return a `402`":

- a precise resource binding so a proof for one URL cannot unlock another;
- method and body binding for non-GET resources;
- amount and payment-hash binding so payment evidence cannot be reused at a different price;
- settlement verification against a real Fiber payer/payee path;
- replay protection so a bearer credential is single-use;
- a receipt that the client and operator can audit later;
- production operations around readiness, metrics, storage, and paid-but-denied reconciliation;
- compatibility paths for nearby paid-HTTP envelopes.

These are infrastructure concerns, not product UX. Wallets, checkouts, marketplaces, agents, and merchants can all sit above this layer.

## Why Fiber Fits

Fiber is well-suited to small, repeated payments because service delivery can happen after fast channel settlement instead of waiting for slow L1 confirmation. That makes it useful for:

- paid API access;
- agent tool calls;
- usage-based SaaS features;
- merchant webhooks and receipts;
- compute or data endpoints;
- tournament entry and prize flows;
- future stablecoin or xUDT-denominated service payments.

Fiber Paid HTTP keeps the payment rail honest by requiring local or testnet Fiber RPC endpoints for live settlement. There is no offline production payment mode.

## Boundary

Fiber Paid HTTP deliberately does not own wallet custody, checkout UX, liquidity discovery, model routing, or marketplace policy. Its job is to make resource-level payment verification reusable:

```text
service request -> Fiber payment challenge -> Fiber settlement -> protected delivery -> receipt -> replay rejection
```

That makes it a horizontal gateway for other Fiber applications rather than a competing vertical product.

## Evidence

The committed reports demonstrate the current boundary:

- `reports/canonical-core-parity.json`: Rust/TypeScript canonical parity across 22 shared vector files.
- `reports/fiber-paid-http-rust-gate.json`: Rust gateway production path, storage, receipt, and replay evidence.
- `reports/fiber-testnet-e2e-evidence.json`: preserved testnet Fiber payment evidence.
- `reports/production-bootstrap-e2e.json`: production-like gateway bootstrap and SQLite integrity evidence.
- `reports/security-matrix.json`: attack-to-check coverage for replay, wrong resource, wrong amount, wrong method, expired challenge, tampered receipt, and F-L402 attacks.
