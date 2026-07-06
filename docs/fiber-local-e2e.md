# Live Fiber E2E

`pnpm test:fiber` always loads the Fiber E2E preflight test. When `RUN_FIBER_E2E=1` and the required Fiber RPC variables are present, it also loads the live evidence path for Fiber Paid HTTP. The live path requires a payer Fiber node with a funded route to a payee Fiber node.

Use [fiber-local-network.md](fiber-local-network.md) for the current reproducible local network setup. The short form is:

```bash
cd "$(git rev-parse --show-toplevel)"
scripts/fiber_local_network.sh up
```

## What The Test Does

The preflight test in `tests/integration/fiber-preflight.test.ts` reports skipped blockers when live Fiber E2E is not configured. The live test in `tests/integration/fiber-live.e2e.test.ts`:

1. creates a paid HTTP resource in-process,
2. receives a `402` MPP challenge,
3. creates a real Fiber invoice through the payee RPC,
4. observes that invoice by `get_invoice`,
5. pays the invoice through the payer RPC by `send_payment`,
6. waits for payer `get_payment` status `Success`,
7. waits for payee `get_invoice` status `Paid`,
8. retries with `Authorization: Payment`,
9. receives `Payment-Receipt`,
10. retries the same credential and expects replay rejection.

## RPC Methods Confirmed From Current Fiber

From `${FIBER_REPO:-../fiber}/crates/fiber-lib/src/rpc/README.md` and Bruno e2e tests:

- `new_invoice`: payee creates invoice. Numeric fields such as `amount` and `expiry` are sent as hex JSON quantities, for example `0x64`.
- `get_invoice`: payee inspects invoice by `payment_hash`; settled invoice status is `Paid`.
- `send_payment`: payer pays by `invoice`.
- `get_payment`: payer inspects payment by `payment_hash`; settled payment status is `Success`.
- `node_info`, `list_channels`, `connect_peer`, and `open_channel` are setup/diagnostic helpers.

## Environment Variables

Required:

```bash
export RUN_FIBER_E2E=1
export FIBER_MODE=local              # or testnet
export FIBER_RPC_URL=http://127.0.0.1:21716
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
```

Optional:

```bash
export FIBER_CURRENCY=Fibd           # local/devnet; use Fibt for testnet
export FIBER_E2E_AMOUNT_SHANNONS=100
export FIBER_SETTLEMENT_TIMEOUT_MS=60000
export FIBER_SETTLEMENT_POLL_MS=500
export FIBER_E2E_STORAGE_PATH=.tmp/fiber-live-e2e.sqlite
export FIBER_PAYEE_RPC_AUTH='Bearer ...'
export FIBER_PAYER_RPC_AUTH='Bearer ...'
```

`FIBER_RPC_URL` is kept as the compatibility alias for the payee/invoice node. `FIBER_PAYER_RPC_URL` must point at a different node that can pay the invoice.

## Local Devnet Setup Using The Fiber Repo

The preferred setup is `scripts/fiber_local_network.sh up`, documented in [fiber-local-network.md](fiber-local-network.md). The manual commands below use the checked-out Fiber repo at `${FIBER_REPO:-../fiber}` and the same node identities used by Fiber's Bruno `router-pay` e2e collection.

Terminal 1:

```bash
cd "${FIBER_REPO:-../fiber}"
REMOVE_OLD_STATE=y ./tests/nodes/start.sh e2e/router-pay
```

Terminal 2:

```bash
cd "${FIBER_REPO:-../fiber}"
./tests/nodes/wait.sh
```

Open and fund the payer-to-payee route if you have not already run the Bruno setup. The route is:

```text
node1 payer -> node2 router -> node3 payee
```

Connect peers:

```bash
curl -sS http://127.0.0.1:21715 \
  -H 'content-type: application/json' \
  -d '{"id":"1","jsonrpc":"2.0","method":"connect_peer","params":[{"address":"/ip4/127.0.0.1/tcp/8344/p2p/QmbvRjJHAQDmj3cgnUBGQ5zVnGxUKwb2qJygwNs2wk41h8"}]}'

curl -sS http://127.0.0.1:21716 \
  -H 'content-type: application/json' \
  -d '{"id":"2","jsonrpc":"2.0","method":"connect_peer","params":[{"address":"/ip4/127.0.0.1/tcp/8345/p2p/QmSRcPqUn4aQrKHXyCDjGn2qBVf43tWBDS2Wj9QDUZXtZp"}]}'
```

Open channels:

```bash
curl -sS http://127.0.0.1:21714 \
  -H 'content-type: application/json' \
  -d '{"id":"3","jsonrpc":"2.0","method":"open_channel","params":[{"pubkey":"02bcbd0e0d811d13363af1e5998f56e74e6aab8a7aa44005e1ce7d696a4d3f10f6","funding_amount":"0x377aab54d000","tlc_fee_proportional_millionths":"0x4B0"}]}'

curl -sS http://127.0.0.1:8114 \
  -H 'content-type: application/json' \
  -d '{"id":"4","jsonrpc":"2.0","method":"generate_epochs","params":["0x2"]}'

curl -sS http://127.0.0.1:21715 \
  -H 'content-type: application/json' \
  -d '{"id":"5","jsonrpc":"2.0","method":"open_channel","params":[{"pubkey":"03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187","funding_amount":"0x377aab54d000","tlc_fee_proportional_millionths":"0x578"}]}'

curl -sS http://127.0.0.1:8114 \
  -H 'content-type: application/json' \
  -d '{"id":"6","jsonrpc":"2.0","method":"generate_epochs","params":["0x2"]}'
```

Wait several seconds for channel gossip/route discovery. You can inspect channels:

```bash
curl -sS http://127.0.0.1:21714 \
  -H 'content-type: application/json' \
  -d '{"id":"7","jsonrpc":"2.0","method":"list_channels","params":[{}]}'
```

Then run Fiber Paid HTTP:

```bash
cd "$(git rev-parse --show-toplevel)"
export RUN_FIBER_E2E=1
export FIBER_MODE=local
export FIBER_RPC_URL=http://127.0.0.1:21716
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
export FIBER_CURRENCY=Fibd
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
export FIBER_E2E_AMOUNT_SHANNONS=100
pnpm test:fiber
```

## Testnet Setup

The full testnet procedure is in [fiber-testnet-e2e.md](fiber-testnet-e2e.md). In short, start or point at two already funded Fiber nodes with connected peers and at least one `ChannelReady` route from payer to payee. Then set:

```bash
export RUN_FIBER_E2E=1
export FIBER_MODE=testnet
export FIBER_CURRENCY=Fibt
export FIBER_RPC_URL=<payee rpc url>
export FIBER_PAYEE_RPC_URL=<payee rpc url>
export FIBER_PAYER_RPC_URL=<payer rpc url>
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
export FIBER_PAYEE_RPC_AUTH='<payee auth if required>'
export FIBER_PAYER_RPC_AUTH='<payer auth if required>'
pnpm test:fiber
```

If these variables are incomplete, `pnpm test:fiber` runs only the visible preflight test and reports skipped blockers. The production gate records `fiber_e2e_mode`, `fiber_e2e_status`, `fiber_e2e_blockers`, and `fiber_e2e_test_file_loaded`. Local E2E alone never marks production readiness true; the gate requires separate testnet Fiber E2E evidence, production operations evidence, and production bootstrap E2E readiness evidence.
