# Hackathon submission

## One sentence

Fiber Paid HTTP turns Fiber settlement into replay-safe HTTP delivery through a Rust production gateway, a proposed Fiber charge-method profile for the current MPP draft, atomic replay protection, and delivery-aware receipts.

## Submission links

- **Repository:** https://github.com/a19q3/fiber-paid-http
- **Hosted demo:** http://fiber.avato.online
- **Video:** https://github.com/a19q3/fiber-paid-http/releases/download/v0.1.0-hackathon/fiber-paid-http-demo.mp4
- **Runnable demo instructions:** this document and the repository `README.md`
- **Screenshots:** https://github.com/a19q3/fiber-paid-http/tree/main/docs/screenshots

## Category and users

- **Category:** Category 3 — Merchant, Liquidity, LSP, and Multi-Asset Infrastructure.
- **Infrastructure slice:** service metering and paid HTTP delivery.
- **Team:** Arthur Zhang (`a19q3`).
- **Primary users:** API developers and service operators.
- **Evidence users:** judges and security auditors.
- **Reference applications:** paid APIs, agent tools, and a Battlecode xUDT paid-entry flow.

## Problem

Fiber can settle fast channel payments, but an API still needs a precise HTTP contract: how to quote an invoice, bind it to a request, verify settlement, reject replay, forward the protected request once, and prove successful delivery.

## Solution

The gateway implements the current MPP-draft `Payment` challenge, credential, and receipt shapes. A Fiber invoice lives inside the `charge` request. The client pays through Fiber and echoes the exact challenge in its credential. The Rust gateway verifies the binding and Fiber settlement, consumes the challenge atomically in SQLite, calls the protected upstream, and emits a receipt only for `2xx` delivery.

F402 and x402 v2 are optional explicit entrances. F-L402 is experimental and disabled by default. They map into the same credential verifier and cannot create alternate settlement, replay, delivery, or receipt rules. The project is not a facilitator and does not claim that MPP and x402 are the same protocol.

## Demo

1. Open the hosted Gateway Lab and select a protected resource.
2. Choose **Request paid resource** and inspect the `402` plus `WWW-Authenticate: Payment` challenge.
3. Choose **Pay with Fiber**. The client pays once and the SDK automatically continues delivery with `Authorization: Payment`.
4. Inspect the ordered timeline: settlement verification, atomic redemption, protected service execution, then response plus `Payment-Receipt`.
5. Run the optional replay security check and observe a fresh `402`, no second service execution, and no reissued receipt.
6. Open Evidence to inspect the 22 shared Rust/TypeScript fixtures and the preserved testnet and production-bootstrap reports.
7. Open Battlecode to run the paid-entry reference integration and distinguish Fiber entry settlement from the local prize ledger.

### Demo availability

The public evaluator console is available at **http://fiber.avato.online**. It runs real FNN processes on an isolated local Fiber xUDT network and uses a funded demo payer so judges can complete the flow without importing a wallet secret. It is intentionally described as a hosted evaluator environment, not as the preserved public-testnet run and not as TLS deployment evidence.

The live gateway lane fails closed unless real local or testnet Fiber RPC configuration is present. Preserved testnet Fiber evidence is committed in `reports/fiber-testnet-e2e-evidence.json`; production-like Rust gateway bootstrap evidence is committed in `reports/production-bootstrap-e2e.json`. The deterministic browser report is labeled `STATIC DEMO`, never `LIVE`.

Local Gateway Lab:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm evidence:api
# second shell
pnpm evidence:web
```

Live Fiber operator lane:

```bash
RUN_FIBER_E2E=1 \
FIBER_MODE=local \
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 \
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 \
FIBER_CURRENCY=Fibd \
FIBER_E2E_AMOUNT_SHANNONS=100 \
FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)" \
bash scripts/evidence_live_demo.sh all
```

## Engineering evidence

- Rust canonical production boundary.
- JCS-identical Rust and TypeScript challenge request, binding, resource-hash, and vector bytes.
- Bidirectional envelope parsing against `mppx 0.8.6` and Rust `mpp 0.10.4`.
- Constant-time HMAC validation.
- Fiber invoice and payment polling with terminal-state and timeout handling.
- Atomic SQLite redemption under concurrent retries.
- Resource, method, body digest, amount, expiry, and payment-hash attack fixtures.
- Receipt-on-success enforcement for both TypeScript middleware and Rust gateway.
- HTTPS public URL binding and fail-closed production config.
- Credential, capability, preimage, invoice, secret, and RPC-auth redaction.

## Working boundaries

### Fully working

- Rust canonical gateway verification, Fiber settlement polling, SQLite redemption, protected upstream delivery, and receipt issuance.
- Local and testnet Fiber RPC modes with no offline payment execution path.
- Guided client flow, manual protocol inspection, recovery without a second payment, and replay rejection.
- Shared Rust/TypeScript conformance across 22 fixtures, with TypeScript explicitly outside the trusted verifier boundary.
- F402, x402 v2, and experimental opt-in F-L402 entrances terminating at the same canonical verifier.

### Local-only or reference integration

- The hosted evaluator console uses an isolated local Fiber xUDT network and a deployment-managed demo payer.
- Battlecode paid entry exercises Fiber settlement; tournament prize distribution remains a clearly labeled local ledger reference path.
- The evidence console visualizes and exports evidence, but machines integrate through HTTP, the SDK, or the Rust gateway CLI.

### Production follow-up

- Operate the Rust gateway behind a public TLS endpoint with externally managed payer wallets and authenticated FNN RPC access.
- Add deployment-specific monitoring, backup, reconciliation, and incident procedures around the existing fail-closed controls.
- Complete ecosystem review of the proposed `fiber` method profile; the project does not claim a registered MPP method.

## Roadmap

1. Publish an interoperability test kit for third-party wallets, agents, and merchant gateways.
2. Add external-wallet authorization examples and stable-value or multi-asset invoice profiles without changing the verifier boundary.
3. Expand operator diagnostics for route failures, paid-but-undelivered reconciliation, metrics, and alerting.
4. Work with Fiber and MPP implementers on method-profile review, receipt interoperability, and upstream adoption.
5. Graduate the Battlecode reference flow into a reusable paid-job and paid-tournament integration example.

## AI tooling allowance

No AI tooling allowance is claimed. AI-assisted development was used under direct human design, review, testing, deployment, and protocol-verification control.

## Run

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:integration
cargo test --workspace
bash scripts/fiber_paid_http_canonical_gate.sh
```

For live Fiber evidence:

```bash
RUN_FIBER_E2E=1 \
FIBER_MODE=testnet \
FIBER_PAYEE_RPC_URL=http://127.0.0.1:8227 \
FIBER_PAYER_RPC_URL=http://127.0.0.1:8228 \
FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)" \
pnpm test:fiber
```

## Scope

This project is payment infrastructure. FNN owns invoices, channels, routing, and settlement. Wallet and payer tooling owns payment authorization. Applications own product policy. Fiber Paid HTTP owns exact request binding, Fiber settlement verification, atomic redemption, protected delivery, and receipts. It is not a wallet, marketplace, checkout UI, custody service, Fiber node dashboard, x402 facilitator, or Battlecode participant platform.
