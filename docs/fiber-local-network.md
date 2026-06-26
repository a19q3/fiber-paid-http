# Local Fiber Network

This is the reproducible local Fiber network used by FiberMPP live E2E. It wraps the current supported Fiber development flow from `/home/arthur/a19q3/fiber` without modifying Fiber internals.

## Source Of Truth

The supported local multi-node path in the Fiber repo is:

- `/home/arthur/a19q3/fiber/docs/dev/README.md`: starts local development nodes with `./tests/nodes/start.sh`.
- `/home/arthur/a19q3/fiber/tests/nodes/start.sh`: initializes the dev CKB chain, builds `fnn`, starts CKB, and starts FNN nodes.
- `/home/arthur/a19q3/fiber/tests/nodes/wait.sh`: waits for generated local RPC/P2P ports.
- `/home/arthur/a19q3/fiber/tests/bruno/e2e/router-pay`: opens `node1 -> node2 -> node3` CKB channels and proves routed payments.
- `/home/arthur/a19q3/fiber/tests/bruno/environments/test.bru`: defines local ports and node ids.

Fiber's Docker docs describe running a single packaged node. The multi-node local E2E environment is the repo dev/test script path above, not Docker Compose.

## Ports And Roles

The default local router-pay ports are:

```text
CKB dev RPC:      http://127.0.0.1:8114
node1 payer RPC: http://127.0.0.1:21714
node2 router RPC:http://127.0.0.1:21715
node3 payee RPC: http://127.0.0.1:21716
```

FiberMPP uses node1 as payer and node3 as payee:

```bash
export FIBER_MODE=local
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
export FIBER_CURRENCY=Fibd
export FIBER_E2E_AMOUNT_SHANNONS=100
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
```

## Automated Setup

From FiberMPP:

```bash
cd /home/arthur/a19q3/fiber-mpp
scripts/fiber_local_network.sh up
```

The wrapper uses `ckb` and `ckb-cli`. If they are not already on `PATH`, it auto-detects the portable binaries at `/home/arthur/a19q3/ckb-bin/ckb_v0.207.0_x86_64-unknown-linux-gnu-portable`.

The wrapper also uses Fiber's supported `sqlite` cargo feature for the local FNN binary build. This avoids the default RocksDB C++ build in constrained local environments while still running the current Fiber node implementation.

## Toolchain Shims

`scripts/fiber_local_network.sh` prepends only its own `scripts/bin` directory to `PATH` for the lifetime of that script. This does not modify shell profiles and does not affect normal developer terminals.

The two local shims are:

- `scripts/bin/cargo`: delegates to the real Cargo binary and prints the delegated command. When Fiber's repo root runs `cargo build`, it adds `--no-default-features --features sqlite` so the local FNN binary uses Fiber's supported SQLite feature instead of requiring a RocksDB C++ build.
- `scripts/bin/nc`: implements the `nc -z HOST PORT` check used by Fiber's wait script through Bash `/dev/tcp`, and prints the delegated check before running it.

The production gate records observed shim use in `toolchain_shims_used` from `reports/fiber-local-network/start.log` and `reports/fiber-local-network/wait.log`.

The script:

1. starts `/home/arthur/a19q3/fiber/tests/nodes/start.sh e2e/router-pay` in the background,
2. waits for CKB and FNN RPC ports,
3. connects node2 to node1 and node3 to node2,
4. opens node1-to-node2 and node2-to-node3 channels,
5. generates local CKB epochs for funding confirmation,
6. waits for node2 `graph_channels` to show both channels.

For xUDT payment routes, set:

```bash
FIBER_LOCAL_ASSET=xudt FIBER_LOCAL_PRIZE_ROUTE=1 scripts/fiber_local_network.sh up
```

This uses Fiber's `e2e/udt-router-pay` local testcase, opens `node1 -> node2 -> node3` xUDT channels for paid entry, and opens `node3 -> node2 -> node1` xUDT channels for reverse prize payout. The local Fiber dev xUDT script is:

```json
{
  "code_hash": "0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95",
  "hash_type": "data2",
  "args": "0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947"
}
```

Use the same script in FiberMPP runtime env as `FIBER_XUDT_TYPE_SCRIPT` when testing xUDT entry or tournament prize payouts.

Logs are written under:

```text
reports/fiber-local-network/start.log
reports/fiber-local-network/wait.log
reports/fiber-local-network/setup.log
```

To stop the background network:

```bash
scripts/fiber_local_network.sh stop
```

## Manual Setup

Terminal 1:

```bash
cd /home/arthur/a19q3/fiber
REMOVE_OLD_STATE=y ./tests/nodes/start.sh e2e/router-pay
```

Terminal 2:

```bash
cd /home/arthur/a19q3/fiber
./tests/nodes/wait.sh
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

Open and confirm channels:

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

Confirm route gossip:

```bash
curl -sS http://127.0.0.1:21715 \
  -H 'content-type: application/json' \
  -d '{"id":"7","jsonrpc":"2.0","method":"graph_channels","params":[{}]}'
```

The result should include two graph channels before running FiberMPP live E2E.

## Run FiberMPP Live E2E

```bash
cd /home/arthur/a19q3/fiber-mpp
RUN_FIBER_E2E=1 \
FIBER_MODE=local \
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 \
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 \
FIBER_CURRENCY=Fibd \
FIBER_E2E_AMOUNT_SHANNONS=100 \
FIBER_MPP_SECRET="$(openssl rand -hex 32)" \
pnpm test:fiber
```
