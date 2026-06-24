# Fiber Testnet E2E

This page is the FiberMPP testnet evidence path. It follows the Fiber onboarding model:

1. run or point at two Fiber Network Node (`fnn`) instances,
2. fund both CKB testnet accounts,
3. connect peers,
4. open and wait for `ChannelReady` channels,
5. run FiberMPP's live `402 -> Fiber payment -> Payment-Receipt -> replay rejection` test.

Local 3-node evidence is documented in [fiber-local-network.md](fiber-local-network.md). Testnet evidence must be collected separately before `production_ready_for_fiber_method` can become `true`.

## Prerequisites

- Fiber Node (`fnn`) and `fnn-cli` from the current Fiber release.
- `ckb-cli` for key handling.
- Two CKB testnet accounts with faucet funds.
- Two Fiber node RPC endpoints reachable only from trusted machines.
- A payer route to the payee. This can be direct or through public testnet relay nodes.

Fiber RPC must not be exposed to arbitrary browsers or public networks. Keep RPC on loopback, a private network, or behind strict auth.

## Node Layout

Use two separate nodes:

```text
payer node: receives the 402 challenge and calls send_payment
payee node: creates invoices for the protected gateway/resource
```

Suggested local ports for a two-node testnet setup:

```text
payer RPC: http://127.0.0.1:8227
payee RPC: http://127.0.0.1:8237
```

## Start Fiber Nodes

Create separate data directories and configs according to the Fiber quick-start docs. Each node needs its own `ckb/key`, RPC port, P2P port, and `FIBER_SECRET_KEY_PASSWORD`.

Example terminal layout:

```bash
# Terminal 1: payer
cd /path/to/payer-node
FIBER_SECRET_KEY_PASSWORD='<payer-key-password>' RUST_LOG=info ./fnn -c config.yml -d .

# Terminal 2: payee
cd /path/to/payee-node
FIBER_SECRET_KEY_PASSWORD='<payee-key-password>' RUST_LOG=info ./fnn -c config.yml -d .
```

Confirm both RPC endpoints answer:

```bash
curl -sS http://127.0.0.1:8227 \
  -H 'content-type: application/json' \
  -d '{"id":"payer-info","jsonrpc":"2.0","method":"node_info","params":[]}' | jq

curl -sS http://127.0.0.1:8237 \
  -H 'content-type: application/json' \
  -d '{"id":"payee-info","jsonrpc":"2.0","method":"node_info","params":[]}' | jq
```

## Connect Peers And Open Channels

Connect the payer and payee nodes to suitable testnet peers. For public relay paths, use the current public node pubkeys from Fiber Network Resources and `fnn-cli peer connect_peer`.

```bash
./fnn-cli --url http://127.0.0.1:8227 peer list_peers
./fnn-cli --url http://127.0.0.1:8237 peer list_peers
```

Open and fund channels so the payer can route to the payee. Amounts are shannons:

```bash
# 500 CKB = 500 * 100000000 shannons = 0xba43b7400
./fnn-cli --url http://127.0.0.1:8227 channel open_channel \
  --pubkey <peer_pubkey> \
  --funding-amount 50000000000 \
  --public true
```

Wait until each node has at least one ready channel:

```bash
./fnn-cli --url http://127.0.0.1:8227 channel list_channels
./fnn-cli --url http://127.0.0.1:8237 channel list_channels
```

The channel state must include:

```text
state_name: ChannelReady
```

## FiberMPP Doctor

Run FiberMPP role checks before the live test:

```bash
cd /home/arthur/a19q3/fiber-mpp

export FIBER_MODE=testnet
export FIBER_CURRENCY=Fibt
export FIBER_PAYER_RPC_URL=http://127.0.0.1:8227
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:8237
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"

pnpm exec fiber-mpp doctor --role payer
pnpm exec fiber-mpp doctor --role payee
```

The doctor output must show:

```text
rpc_probe: node_info ok
rpc_peer_count: >= 1
rpc_channel_count: >= 1
rpc_ready_channel_count: >= 1
rpc_channel_states: ChannelReady:<count>
```

If it reports no peers or no `ChannelReady` channels, fix Fiber connectivity before running `pnpm test:fiber`.

## Run Live Testnet E2E

```bash
cd /home/arthur/a19q3/fiber-mpp

export RUN_FIBER_E2E=1
export FIBER_MODE=testnet
export FIBER_CURRENCY=Fibt
export FIBER_PAYER_RPC_URL=http://127.0.0.1:8227
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:8237
export FIBER_RPC_URL=http://127.0.0.1:8237
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
export FIBER_E2E_AMOUNT_SHANNONS=100
export FIBER_SETTLEMENT_TIMEOUT_MS=60000
export FIBER_SETTLEMENT_POLL_MS=500

pnpm test:fiber
```

When this passes, preserve the generated report and copy the evidence into the gate reports before changing any production readiness claim. Local E2E alone is not enough.

## Evidence Criteria

The testnet evidence is credible only when all of these are true:

- `fiber_e2e_mode` is `testnet`.
- `fiber_e2e_status` is `passed`.
- `fiber_live_test_loaded` is `true`.
- The output includes a non-empty `fiber_e2e_payment_hash`.
- The output includes a non-empty `fiber_e2e_receipt_id`.
- `production_ready_for_fiber_method` still remains `false` until operational hardening is also complete.

## References

- Fiber onboarding: <https://github.com/RetricSu/fiber-hackathon-docs/blob/master/onboarding.md>
- Fiber resources: <https://github.com/RetricSu/fiber-hackathon-docs/blob/master/resources.md>
- Fiber node quick start: <https://www.fiber.world/docs/quick-start/run-a-node>
- Fiber basic transfer: <https://www.fiber.world/docs/quick-start/basic-transfer>
- Fiber network resources: <https://www.fiber.world/docs/quick-start/network-resources>
