# Hackathon submission

## One sentence

Fiber Paid HTTP proposes and implements a Fiber charge-method profile for the current MPP draft, with a Rust production gateway, atomic replay protection, delivery-aware receipts, and a live evidence console.

## Problem

Fiber can settle fast channel payments, but an API still needs a precise HTTP contract: how to quote an invoice, bind it to a request, verify settlement, reject replay, forward the protected request once, and prove successful delivery.

## Solution

The gateway implements the current MPP-draft `Payment` challenge, credential, and receipt shapes. A Fiber invoice lives inside the `charge` request. The client pays through Fiber and echoes the exact challenge in its credential. The Rust gateway verifies the binding and Fiber settlement, consumes the challenge atomically in SQLite, calls the protected upstream, and emits a receipt only for `2xx` delivery.

F402 and F-L402 are optional explicit entrances. F-L402 is experimental and disabled by default. They map into the same credential verifier and cannot create alternate replay or receipt rules.

## Demo

1. Select a protected resource in the Evidence Console.
2. Send the unpaid request and inspect `WWW-Authenticate: Payment`.
3. Pay the Fiber invoice.
4. Retry with `Authorization: Payment` and observe the MPP-draft receipt.
5. Replay the same credential and observe a fresh `402` with no second service execution.
6. Open the parity view to inspect all 22 shared Rust/TypeScript fixtures.

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

This project is payment infrastructure. It is not a wallet, marketplace, checkout UI, custody service, or Fiber node dashboard. The payer controls payment authorization; the gateway verifies payment and protects HTTP delivery.
