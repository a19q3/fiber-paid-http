# Fiber RPC

FiberMPP does not link against Fiber internals. It speaks to Fiber Network Node through JSON-RPC.

## Environment

```text
FIBER_MODE=local | testnet
FIBER_RPC_URL=http://127.0.0.1:8227
FIBER_RPC_AUTH=<optional Authorization header value>
FIBER_NODE_ID=<optional node pubkey/id>
FIBER_CURRENCY=Fibd | Fibt | Fibb
```

## Live-Proven RPC Mapping

- `new_invoice`: payee creates Fiber method challenges.
- `send_payment`: payer attempts real Fiber payment when RPC mode is configured.
- `get_payment`: payer polls payment by `payment_hash`; settled payment status is `Success`.
- `get_invoice`: payee verifies invoice status by `payment_hash`; settled invoice status is `Paid`.
- `node_info`: doctor confirms node identity, version, peer count, and channel count.
- `list_peers`: doctor confirms the node is connected to local/testnet peers.
- `list_channels`: doctor confirms the node has at least one `ChannelReady` channel before live payments.

Numeric fields are hex JSON quantities, for example `100` is sent as `0x64`.

## Settlement statuses

- Local/testnet mode: `get_payment` must reach `Success` and `get_invoice` must reach `Paid` before FiberMPP emits a settled receipt.

The Rust parity surface is documented in [rust-fiber-rpc.md](rust-fiber-rpc.md).

## Doctor readiness

`fiber-mpp doctor --role payer|payee|gateway` probes the configured Fiber RPC endpoint with:

```text
node_info
list_peers
list_channels
```

`node_info` failure blocks immediately. `list_peers` and `list_channels` failures also block, because a reachable node without peers or `ChannelReady` channels cannot complete the official Fiber onboarding payment flow.

## Security

Do not expose Fiber RPC to untrusted networks. FiberMPP should run near the Fiber node and hold any RPC auth material server-side only.
