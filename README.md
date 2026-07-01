# Fiber Paid HTTP

Fiber Paid HTTP is a Rust-first gateway and TypeScript SDK/tooling stack for charging HTTP APIs with Fiber. The core contract is HTTP 402 challenge issuance, Fiber settlement proof, replay protection, and signed receipts.

MPP, F402, and F-L402 are compatibility envelopes over that same paid HTTP core. MPP-style `WWW-Authenticate: Payment` remains the stable gateway envelope, while F402 and F-L402 let Fiber-native applications expose familiar challenge/proof flows without changing the verifier boundary.

## Adapter surface

| Surface | Status | HTTP/auth shape | Role |
| --- | --- | --- | --- |
| MPP + Fiber | Primary | `WWW-Authenticate: Payment`, `Authorization: Payment`, `Payment-Receipt` | Stable gateway envelope and receipt model. |
| F402 | Compatible | Fiber invoice/payment-hash JSON challenge and proof conversion | Bridge for Infern-style Fiber 402 applications. |
| F-L402 | First-class adapter | `WWW-Authenticate: L402`, `Authorization: L402 macaroon:preimage` | Application-level macaroon/preimage compatibility backed by the same Fiber invoice and receipt verifier. |
| x402 | Future boundary | Native x402 headers / verify / settle | Not implemented until Fiber node x402 support is available as a stable integration target. |

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
pnpm exec fiber-paid-http init --role gateway --out fiber-paid-http.gateway.json
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-paid-http doctor --role gateway --config fiber-paid-http.gateway.json
pnpm exec fiber-paid-http serve --config fiber-paid-http.gateway.json
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
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
pnpm test:fiber
```

For testnet evidence, start or point at two funded Fiber testnet nodes, connect peers, wait for `ChannelReady` channels, and then run the same live Fiber lane with:

```bash
export RUN_FIBER_E2E=1
export FIBER_MODE=testnet
export FIBER_CURRENCY=Fibt
export FIBER_PAYEE_RPC_URL=<payee rpc url>
export FIBER_PAYER_RPC_URL=<payer rpc url>
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-paid-http doctor --role payer
pnpm exec fiber-paid-http doctor --role payee
pnpm test:fiber
```

Once the payer/payee testnet nodes are funded, connected, and `ChannelReady`, the same evidence path can be run through:

```bash
scripts/fiber_testnet_e2e.sh
```

See [docs/bootstrap.md](docs/bootstrap.md), [docs/production-operations.md](docs/production-operations.md), [docs/fiber-client-wallet-integration-plan.md](docs/fiber-client-wallet-integration-plan.md), [docs/fiber-local-e2e.md](docs/fiber-local-e2e.md), and [docs/fiber-testnet-e2e.md](docs/fiber-testnet-e2e.md) for gateway, payer, payee, operations, wallet/client boundaries, local evidence, and testnet evidence steps.

## Security model

Challenges and receipts are HMAC-signed canonical JSON. Credentials bind to a resource hash and are single-use. The middleware verifies challenge signature, expiry, method, resource, Fiber payment hash, Fiber amount, and replay state before serving protected resources.

## Fiber RPC configuration

Fiber Paid HTTP requires real local or testnet Fiber RPC endpoints. Local/testnet attempts require separate payer and payee nodes:

```bash
FIBER_MODE=local
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
FIBER_PAID_HTTP_SECRET=<32+ character random signing secret>
FIBER_RPC_AUTH=<optional shared Authorization header value>
FIBER_PAYEE_NODE_ID=<optional payee node id/pubkey>
FIBER_PAYER_NODE_ID=<optional payer node id/pubkey>
FIBER_PAID_HTTP_FL402_ROOT_KEY=<optional F-L402 root key, 16+ characters>
```

Use `FIBER_MODE=testnet` for testnet. Receipts are marked `settled` only after Fiber RPC reports a settled invoice/payment status.

## How it differs from Infern

Infern is an AI model compute marketplace using F402 over Fiber. Fiber Paid HTTP is reusable MPP/Fiber infrastructure that Infern-like projects can use.

## How it differs from L402

Lightning L402 is Lightning-specific. Fiber Paid HTTP implements an application-level F-L402 adapter for Fiber invoices: it issues `fl402-macaroon-v1` HMAC caveat tokens, verifies `macaroon:preimage` proofs, and then converts the proof into the same internal Fiber credential path used by MPP. It does not claim byte-level compatibility with Lightning Labs macaroons.

## How it relates to x402

x402 is a likely long-term paid HTTP shape for many ecosystems. Fiber Paid HTTP keeps x402 as a future adapter boundary rather than making x402 the trusted verifier before Fiber node verify/settle support is stable. When that support is available, x402 should plug into the same challenge, replay, settlement, and receipt model.

## How it relates to MPP

Fiber Paid HTTP follows the MPP HTTP flow:

```text
unpaid request -> 402 + WWW-Authenticate: Payment
payment -> Authorization: Payment retry
verified resource -> Payment-Receipt
```

## Main commands

```bash
fiber-paid-http refs init
fiber-paid-http challenge inspect http://localhost:8787/paid/weather
fiber-paid-http pay http://localhost:8787/paid/weather --method fiber
fiber-paid-http init --role gateway --out fiber-paid-http.gateway.json
fiber-paid-http doctor --role gateway --config fiber-paid-http.gateway.json
fiber-paid-http serve --config fiber-paid-http.gateway.json
fiber-paid-http storage backup --config fiber-paid-http.gateway.json --out backups/fiber-paid-http.sqlite
fiber-paid-http storage restore --config fiber-paid-http.gateway.json --from backups/fiber-paid-http.sqlite --force
fiber-paid-http storage export-receipts --config fiber-paid-http.gateway.json --out exports/receipts.jsonl
fiber-paid-http storage audit-receipts --config fiber-paid-http.gateway.json
fiber-paid-http f402 convert f402-challenge.json
fiber-paid-http fl402 issue fl402-input.json --root-key "$FIBER_PAID_HTTP_FL402_ROOT_KEY"
fiber-paid-http fl402 verify fl402-proof.json --root-key "$FIBER_PAID_HTTP_FL402_ROOT_KEY"
fiber-paid-http fl402 convert fl402-proof.json --server-id fiber-paid-http-cli
fiber-paid-http receipt verify receipt.json --secret <secret>
fiber-paid-http doctor --role payer
fiber-paid-http evidence start --port 8787 --web-port 8788
fiber-paid-http evidence start --port 8787 --api-only
```

The Evidence API exposes operator probes at `GET /healthz` and `GET /readyz`.
`/healthz` proves the API process is alive. `/readyz` proves the active env-backed or UI-runtime-backed payer/payee Fiber path is executable; it returns `503` with `livePaymentEnabled: false`, role statuses, `mode`, and exact Fiber blockers when the local/testnet payment path or ChannelReady probes are not ready.
By default `fiber-paid-http evidence start` starts both the local Evidence API and the Evidence Console web server. The web server injects the selected API port into the static console HTML, so custom `--port` values do not leave the browser pointed at stale `localhost:8787`.
The Evidence API accepts served loopback console origins by default. `file://` pages (`Origin: null`) are rejected unless `FIBER_PAID_HTTP_ALLOW_FILE_ORIGIN=1` is set for local-only debugging.

## Production gate

```bash
bash scripts/fiber_paid_http_gate.sh
```

The gate writes `reports/fiber-paid-http-gate.json` and stays honest about skipped, local, and testnet modes. `production_ready_for_fiber_method` is true only when real testnet Fiber E2E evidence, production operations evidence, and production bootstrap E2E readiness evidence are all present.
