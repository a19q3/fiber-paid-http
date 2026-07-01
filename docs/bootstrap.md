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
    "value": "1",
    "currency": "CKB",
    "display": "1 CKB"
  },
  "methods": ["fiber"],
  "secret_env": "FIBER_MPP_SECRET",
  "previous_secret_envs": [],
  "cors": {
    "allowed_origins": [],
    "allowed_headers": ["authorization", "content-type"],
    "allowed_methods": ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    "expose_headers": ["payment-receipt", "www-authenticate"],
    "allow_credentials": false,
    "max_age_seconds": 600
  },
  "operations": {
    "health_path": "/healthz",
    "readiness_path": "/readyz",
    "metrics_path": "/metrics",
    "request_body_limit_bytes": 1048576,
    "shutdown_grace_ms": 10000,
    "log_redaction": {
      "enabled": true,
      "extra_keys": []
    },
    "rate_limit": {
      "window_ms": 60000,
      "max_requests": 300
    }
  },
  "fiber": {
    "mode": "local",
    "payee_rpc_url": "http://127.0.0.1:21716",
    "payer_rpc_url": "http://127.0.0.1:21714",
    "payee_rpc_auth_env": "FIBER_PAYEE_RPC_AUTH",
    "payer_rpc_auth_env": "FIBER_PAYER_RPC_AUTH",
    "currency": "Fibd"
  }
}
```

To also issue F-L402 challenges from the gateway, add:

```json
{
  "fl402": {
    "root_key_env": "FIBER_MPP_FL402_ROOT_KEY",
    "hash_algorithm": "sha256"
  }
}
```

Check readiness before serving traffic:

```bash
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
```

The doctor command checks required fields and probes the configured Fiber RPC with `node_info`, `list_peers`, and `list_channels`.

Start the gateway:

```bash
pnpm exec fiber-mpp serve --config fiber-mpp.gateway.json
```

The gateway requires:

- `FIBER_MPP_SECRET` with at least 32 characters,
- optional `FIBER_MPP_FL402_ROOT_KEY` with at least 16 characters when `fl402` is configured,
- optional `previous_secret_envs` entries only for active signing-secret rotation windows,
- `storage` as `sqlite://path`; CLI `--storage /path/to/file.sqlite` is normalized to `sqlite:///path/to/file.sqlite`,
- `upstream`,
- `price.currency` set to `CKB`,
- `cors.allowed_origins` as an explicit allow-list when browser callers are expected; wildcard `*` is rejected,
- `operations.log_redaction.enabled` left enabled,
- `FIBER_MODE=local` or `FIBER_MODE=testnet`,
- a payee RPC URL through `fiber.payee_rpc_url`, `FIBER_PAYEE_RPC_URL`, or `FIBER_RPC_URL`,
- Fiber RPC auth through `fiber.*_rpc_auth_env` or process env variables; literal `fiber.rpc_auth`, `fiber.payee_rpc_auth`, and `fiber.payer_rpc_auth` are rejected for production configs.

`price.currency` is the HTTP/MPP user-facing unit and must be `CKB`. `fiber.currency` is the Fiber RPC invoice currency code used by the connected Fiber node, such as `Fibd` for the local dev network or `Fibt` for testnet.

For live payments, the configured payee node must have at least one connected peer and at least one `ChannelReady` channel. The payer node must also pass the same peer/channel readiness checks before a client or agent can pay.

## Gateway Secret Rotation

Keep signing secrets out of config. The config stores environment variable names only:

```json
{
  "secret_env": "FIBER_MPP_SECRET",
  "previous_secret_envs": ["FIBER_MPP_SECRET_2026_06_PREVIOUS"]
}
```

Rotation flow:

```bash
export FIBER_MPP_SECRET_2026_06_PREVIOUS="$FIBER_MPP_SECRET"
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
pnpm exec fiber-mpp serve --config fiber-mpp.gateway.json
```

New challenges and receipts are signed with `secret_env`. Stored challenges issued before rotation and receipt audits can be verified with `previous_secret_envs` during the configured rotation window. After the challenge TTL and receipt audit retention window no longer require the old secret, remove the old env name from `previous_secret_envs` and unset the old environment variable.

Verify a receipt against current plus explicit previous secrets:

```bash
pnpm exec fiber-mpp receipt verify receipt.json \
  --previous-secret "$FIBER_MPP_SECRET_2026_06_PREVIOUS"
```

## Gateway Operations

The configured gateway exposes operator endpoints:

```bash
curl http://127.0.0.1:8790/healthz
curl http://127.0.0.1:8790/readyz
curl http://127.0.0.1:8790/metrics
```

- `healthz` reports process liveness.
- `readyz` re-runs the bootstrap/Fiber RPC readiness checks and returns `503` when blocked.
- `metrics` exposes Prometheus-style request, response, and readiness counters.

The gateway rejects disallowed browser `Origin` values before issuing a challenge, enforces `operations.request_body_limit_bytes`, rate-limits protected/proxied traffic with `operations.rate_limit`, writes redacted structured JSON lifecycle/request logs, and handles `SIGINT`/`SIGTERM` with `operations.shutdown_grace_ms`.

`healthz`, `readyz`, `metrics`, and CORS preflight requests are not rate-limited. Rate-limit rejections return `429` with `retry-after` and are counted in `fiber_mpp_gateway_rate_limit_rejections_total`.

The default log redaction policy masks auth headers, RPC auth, secrets, tokens, passwords, private keys, and auth-like string fragments. Use `operations.log_redaction.extra_keys` for deployment-specific field names that must never leave the host.

## SQLite Storage Operations

Back up the configured SQLite store with a consistent SQLite snapshot:

```bash
pnpm exec fiber-mpp storage backup \
  --config fiber-mpp.gateway.json \
  --out backups/fiber-mpp-$(date +%Y%m%d-%H%M%S).sqlite
```

Restore requires an explicit overwrite flag. Stop the gateway before restoring over an active database:

```bash
pnpm exec fiber-mpp storage restore \
  --config fiber-mpp.gateway.json \
  --from backups/fiber-mpp-20260101-120000.sqlite \
  --force
```

The backup command uses SQLite `VACUUM INTO`, so it captures committed state without copying a partial WAL file.

Check schema version, SQLite integrity, WAL mode, and foreign-key enforcement:

```bash
pnpm exec fiber-mpp storage check \
  --config fiber-mpp.gateway.json
```

Export stored receipts as JSONL for audit or downstream accounting:

```bash
pnpm exec fiber-mpp storage export-receipts \
  --config fiber-mpp.gateway.json \
  --out exports/fiber-mpp-receipts.jsonl
```

If `FIBER_MPP_SECRET` or the configured `secret_env` is present, the export includes `receipt_signature_valid` for each line. A standalone audit fails with a non-zero exit code when any stored receipt signature is invalid:

```bash
pnpm exec fiber-mpp storage audit-receipts \
  --config fiber-mpp.gateway.json
```

When `previous_secret_envs` is set in the gateway config, both receipt export and audit verify signatures against the current secret plus all configured previous secrets. Explicit historical secrets can also be supplied without changing config:

```bash
pnpm exec fiber-mpp storage audit-receipts \
  --config fiber-mpp.gateway.json \
  --previous-secret "$FIBER_MPP_SECRET_2026_06_PREVIOUS"
```

Paid-but-denied evidence is recorded when a credential is redeemed but the protected upstream throws or returns a server error. Operators can inspect delivery outcomes:

```bash
pnpm exec fiber-mpp storage list-deliveries \
  --config fiber-mpp.gateway.json
```

Failed delivery outcomes include the receipt id, challenge id, credential hash, response status, and failure code/message so an operator can reconcile the paid request without reissuing receipts or accepting credential replay.

## Payer

Check payer readiness:

```bash
export FIBER_MODE=local
export FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
pnpm exec fiber-mpp doctor --role payer
```

The payer doctor probes the payer Fiber RPC with `node_info`, `list_peers`, and `list_channels`. A ready payer report includes at least one peer and at least one `ChannelReady` channel.

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

The payee doctor probes the invoice/payee Fiber RPC with `node_info`, `list_peers`, and `list_channels`. A ready payee report includes at least one peer and at least one `ChannelReady` channel.

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

## Testnet Evidence Network

For public testnet evidence, use two funded Fiber testnet nodes:

```bash
export FIBER_MODE=testnet
export FIBER_CURRENCY=Fibt
export FIBER_PAYER_RPC_URL=http://127.0.0.1:8227
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:8237
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"

pnpm exec fiber-mpp doctor --role payer
pnpm exec fiber-mpp doctor --role payee
```

If either doctor report shows zero peers, zero channels, or zero `ChannelReady` channels, connect the node to a local/testnet peer and open/fund channels before running FiberMPP live E2E.

The full testnet procedure is in [fiber-testnet-e2e.md](fiber-testnet-e2e.md).
