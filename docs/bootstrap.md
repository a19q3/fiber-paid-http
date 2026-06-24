# Bootstrap

FiberMPP has three operational roles:

- `gateway`: protects an upstream HTTP service and issues FiberMPP 402 challenges.
- `payee`: owns the invoice Fiber node used by the gateway.
- `payer`: pays a FiberMPP 402 challenge through a funded Fiber node.

No production-capable command writes a signing secret into config. Export a secret before running the gateway:

```bash
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
```

## Gateway Admin

Create a gateway template:

```bash
pnpm exec fiber-mpp init --role gateway --out fiber-mpp.gateway.json
```

Edit the template:

```json
{
  "role": "gateway",
  "listen": "127.0.0.1:8790",
  "server_id": "fiber-mpp-gateway",
  "upstream": "http://localhost:8080",
  "storage": "sqlite://./fiber-mpp.sqlite",
  "price": {
    "value": "0.01",
    "currency": "USD",
    "display": "$0.01"
  },
  "methods": ["fiber"],
  "secret_env": "FIBER_MPP_SECRET",
  "fiber": {
    "mode": "local",
    "payee_rpc_url": "http://127.0.0.1:21716",
    "payer_rpc_url": "http://127.0.0.1:21714",
    "currency": "Fibd"
  }
}
```

Check readiness before serving traffic:

```bash
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
```

The doctor command checks required fields and probes the configured Fiber RPC with `node_info`.

Start the gateway:

```bash
pnpm exec fiber-mpp serve --config fiber-mpp.gateway.json
```

The gateway requires:

- `FIBER_MPP_SECRET` with at least 32 characters,
- `storage` as `sqlite://path`; CLI `--storage /path/to/file.sqlite` is normalized to `sqlite:///path/to/file.sqlite`,
- `upstream`,
- `FIBER_MODE=local` or `FIBER_MODE=testnet`,
- a payee RPC URL through `fiber.payee_rpc_url`, `FIBER_PAYEE_RPC_URL`, or `FIBER_RPC_URL`.

## Payer

Check payer readiness:

```bash
export FIBER_MODE=local
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
pnpm exec fiber-mpp doctor --role payer
```

The payer doctor probes the payer Fiber RPC with `node_info`.

Pay a protected resource:

```bash
pnpm exec fiber-mpp pay http://localhost:8790/paid/weather --method fiber
```

The payer node must have funds and a route to the payee node.

## Payee

Check payee readiness:

```bash
export FIBER_MODE=local
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
pnpm exec fiber-mpp doctor --role payee
```

The payee doctor probes the invoice/payee Fiber RPC with `node_info`.

The payee node must be reachable by the gateway and able to create invoices.

## Local Evidence Network

For the current local three-node evidence network:

```bash
scripts/fiber_local_network.sh up
```

Then run:

```bash
export RUN_FIBER_E2E=1
export FIBER_MODE=local
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
export FIBER_CURRENCY=Fibd
export FIBER_E2E_AMOUNT_SHANNONS=100
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
pnpm test:fiber
```

The local evidence script is maintainer/dev tooling. It is not a production node bootstrap path.
