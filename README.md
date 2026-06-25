# FiberMPP

FiberMPP is a production-targeted Fiber payment method for Machine Payments Protocol, with F402 compatibility for Fiber-native HTTP 402 applications. It is not production-ready yet: local Fiber E2E evidence and production operations runbooks exist, while separate testnet evidence and the Rust HTTP gateway production implementation remain pending.

FiberMPP lets services accept Fiber through one HTTP 402 challenge, credential, and receipt flow.

## What it is not

- Not an AI inference marketplace.
- Not a full checkout product.
- Not a wallet.
- Not a multi-rail stablecoin bridge into Fiber.
- Not a replacement for Infern.

## Quick start

```bash
pnpm install
pnpm build
pnpm exec fiber-mpp init --role gateway --out fiber-mpp.gateway.json
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
pnpm exec fiber-mpp serve --config fiber-mpp.gateway.json
```

The doctor command prints exact blockers until `FIBER_MODE`, payee Fiber RPC, storage, upstream, signing secret, Fiber peers, and `ChannelReady` channels are configured.

The configured gateway exposes `GET /healthz`, `GET /readyz`, and `GET /metrics`, rejects disallowed browser origins before challenge issuance, enforces protected-route rate limits and a request body limit, writes structured JSON request logs, and shuts down gracefully on `SIGINT`/`SIGTERM`.

## Evidence paths

For the reproducible local Fiber network used by the evidence suite:

```bash
scripts/fiber_local_network.sh up
```

After the local network is running, set the local env and run the live Fiber lane:

```bash
export RUN_FIBER_E2E=1
export FIBER_MODE=local
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
export FIBER_CURRENCY=Fibd
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
pnpm test:fiber
```

For testnet evidence, start or point at two funded Fiber testnet nodes, connect peers, wait for `ChannelReady` channels, and then run the same live Fiber lane with:

```bash
export RUN_FIBER_E2E=1
export FIBER_MODE=testnet
export FIBER_CURRENCY=Fibt
export FIBER_PAYEE_RPC_URL=<payee rpc url>
export FIBER_PAYER_RPC_URL=<payer rpc url>
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-mpp doctor --role payer
pnpm exec fiber-mpp doctor --role payee
pnpm test:fiber
```

See [docs/bootstrap.md](docs/bootstrap.md), [docs/production-operations.md](docs/production-operations.md), [docs/fiber-client-wallet-integration-plan.md](docs/fiber-client-wallet-integration-plan.md), [docs/fiber-local-e2e.md](docs/fiber-local-e2e.md), and [docs/fiber-testnet-e2e.md](docs/fiber-testnet-e2e.md) for gateway, payer, payee, operations, wallet/client boundaries, local evidence, and testnet evidence steps.

## Security model

Challenges and receipts are HMAC-signed canonical JSON. Credentials bind to a resource hash and are single-use. The middleware verifies challenge signature, expiry, method, resource, Fiber payment hash, Fiber amount, and replay state before serving protected resources.

## Fiber RPC configuration

FiberMPP requires real local or testnet Fiber RPC endpoints. Local/testnet attempts require separate payer and payee nodes:

```bash
FIBER_MODE=local
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
FIBER_MPP_SECRET=<32+ character random signing secret>
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
fiber-mpp init --role gateway --out fiber-mpp.gateway.json
fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
fiber-mpp serve --config fiber-mpp.gateway.json
fiber-mpp storage backup --config fiber-mpp.gateway.json --out backups/fiber-mpp.sqlite
fiber-mpp storage restore --config fiber-mpp.gateway.json --from backups/fiber-mpp.sqlite --force
fiber-mpp storage export-receipts --config fiber-mpp.gateway.json --out exports/receipts.jsonl
fiber-mpp storage audit-receipts --config fiber-mpp.gateway.json
fiber-mpp f402 convert f402-challenge.json
fiber-mpp receipt verify receipt.json --secret <secret>
fiber-mpp doctor --role payer
fiber-mpp evidence start --port 8787
```

## Production gate

```bash
bash scripts/fiber_mpp_gate.sh
```

The gate writes `reports/fiber-mpp-gate.json` and stays honest about skipped, local, and testnet modes. Production readiness must remain false until a real testnet Fiber E2E pass and the Rust HTTP gateway production path are recorded.
