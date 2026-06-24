# FiberMPP

FiberMPP is a production-targeted Fiber payment method for Machine Payments Protocol, with F402 compatibility for Fiber-native HTTP 402 applications. It is not production-ready yet: local Fiber E2E evidence exists, while separate testnet evidence, operational hardening, and the Rust HTTP gateway remain pending.

FiberMPP lets services accept Fiber beside MPP rails such as Tempo and Stripe through one HTTP 402 challenge, credential, and receipt flow.

## What it is not

- Not an AI inference marketplace.
- Not a full checkout product.
- Not a wallet.
- Not a Tempo/Stripe stablecoin bridge into Fiber.
- Not a replacement for Infern.

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @fiber-mpp/demo-api start
```

In another shell:

```bash
fiber-mpp pay http://localhost:8787/paid/weather --method fiber
```

Run the browser demo:

```bash
pnpm --filter @fiber-mpp/demo-web start
```

Open `http://localhost:8788`.

## Demo smoke

```bash
fiber-mpp demo smoke
```

This checks unpaid 402, Fiber mock payment, paid retry, receipt, replay rejection, and wrong-resource rejection.

## Security model

Challenges and receipts are HMAC-signed canonical JSON. Credentials bind to a resource hash and are single-use. The middleware verifies challenge signature, expiry, method, resource, Fiber payment hash, Fiber amount, and replay state before serving protected resources.

## Fiber RPC configuration

Mock mode is the default:

```bash
FIBER_MODE=mock
```

Real local/testnet attempts require separate payer and payee Fiber RPC endpoints:

```bash
FIBER_MODE=local
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
FIBER_RPC_AUTH=<optional shared Authorization header value>
FIBER_PAYEE_NODE_ID=<optional payee node id/pubkey>
FIBER_PAYER_NODE_ID=<optional payer node id/pubkey>
```

Use `FIBER_MODE=testnet` for testnet. Receipts are marked `settled` only after Fiber RPC reports a settled invoice/payment status.

## How it differs from Infern

Infern is an AI model compute marketplace using F402 over Fiber. FiberMPP is reusable MPP/Fiber infrastructure that Infern-like projects can use.

## How it differs from L402

L402 is Lightning-specific and uses macaroons/preimage proofs. FiberMPP uses Fiber invoices/payment hashes through JSON-RPC and signs MPP challenge/receipt payloads with canonical HMAC.

## How it relates to MPP

FiberMPP follows the MPP HTTP flow:

```text
unpaid request -> 402 + WWW-Authenticate: Payment
payment -> Authorization: Payment retry
verified resource -> Payment-Receipt
```

## Main commands

```bash
fiber-mpp refs init
fiber-mpp challenge inspect http://localhost:8787/paid/weather
fiber-mpp pay http://localhost:8787/paid/weather --method fiber
fiber-mpp serve --upstream http://localhost:8080 --price-usd 0.01 --methods fiber
fiber-mpp f402 convert f402-challenge.json
fiber-mpp receipt verify receipt.json --secret <secret>
fiber-mpp doctor http://localhost:8787/paid/weather
fiber-mpp demo smoke
```

## Production gate

```bash
bash scripts/fiber_mpp_gate.sh
```

The gate writes `reports/fiber-mpp-gate.json` and stays honest about mock, local, and testnet modes. Production readiness must remain false until a real testnet Fiber E2E pass and operational hardening are recorded.
