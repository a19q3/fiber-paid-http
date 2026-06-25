# Production Operations

This runbook covers the production operations pieces that are outside the protocol verifier: alerting, Fiber node backup/restore, trusted RPC/network binding, and paid-but-denied reconciliation.

Production readiness requires both this operations evidence and separate testnet Fiber E2E evidence. Local E2E plus this runbook is not enough to set `production_ready_for_fiber_method` to `true`; the current gate may set it to `true` only when the recorded testnet evidence is still present and all operations checks pass.

## Operating Model

Use the native Fiber Network Node (FNN) as the production payment executor:

```text
FiberMPP gateway -> payee FNN JSON-RPC
payer client     -> payer FNN JSON-RPC or a user-owned Fiber WASM node
```

The default production payer/payee path is direct FNN JSON-RPC with the FNN built-in wallet. `fiber-pay`, browser WASM, CCC, and WalletConnect are client/ops integration layers, not FiberMPP trusted verifier dependencies.

## Alerting

FiberMPP exposes Prometheus text metrics at the configured metrics path, usually `/metrics`:

```bash
curl http://127.0.0.1:8790/healthz
curl http://127.0.0.1:8790/readyz
curl http://127.0.0.1:8790/metrics
```

Load the alert rules from:

```text
deploy/prometheus/fiber-mpp-alerts.yml
```

Required alerts:

| Alert | Source metric | Action |
| --- | --- | --- |
| `FiberMppGatewayReadinessFailing` | `fiber_mpp_gateway_readiness_failures_total` | Run gateway doctor, inspect Fiber RPC auth, peers, and `ChannelReady` channels. |
| `FiberMppGatewayHigh5xxRate` | `fiber_mpp_gateway_responses_total{status=~"5.."}` | Treat as possible paid-but-denied; inspect delivery outcomes. |
| `FiberMppGatewayRateLimited` | `fiber_mpp_gateway_rate_limit_rejections_total` | Check abuse signals, caller identity, and configured rate limit. |
| `FiberMppGatewayNoTraffic` | `fiber_mpp_gateway_requests_total` | Check scrape config, process health, and network binding. |

## Fiber Node Readiness

Run these before serving or after an alert:

```bash
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
pnpm exec fiber-mpp doctor --role payee
pnpm exec fiber-mpp doctor --role payer
```

Expected readiness:

```text
rpc_peer_count >= 1
rpc_channel_count >= 1
rpc_ready_channel_count >= 1
rpc_channel_states contains ChannelReady
```

If readiness fails:

1. Verify the FNN process is running.
2. Verify `FIBER_SECRET_KEY_PASSWORD` was provided at FNN startup.
3. Verify `ckb/key` exists in the FNN data directory.
4. Verify peer connectivity with Fiber RPC `list_peers`.
5. Verify channel state with Fiber RPC `list_channels`.
6. Do not route production traffic until `/readyz` is healthy again.

## Trusted Network Binding

Do not expose FNN JSON-RPC to browsers or public networks.

Required binding policy:

- FNN `rpc.listening_addr` must bind to `127.0.0.1` or a private sidecar/VPC address.
- Public ingress terminates at the application gateway or reverse proxy, not at FNN RPC.
- Browser clients never receive privileged FNN RPC auth.
- Gateway config must use `fiber.payee_rpc_auth_env`, `fiber.payer_rpc_auth_env`, or process env variables; literal RPC auth in config is rejected.
- Restrict `/healthz`, `/readyz`, and `/metrics` to operators or private monitoring networks when deployed behind a public reverse proxy.
- Use firewall/security-group rules to reject inbound traffic to FNN RPC from untrusted networks.

Quick checks:

```bash
ss -ltnp | grep -E ':(8227|21714|21716)\b'
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
```

The listener should show loopback or a private interface. A public `0.0.0.0` binding is only acceptable behind a private firewall/security group and must not be reachable from the public internet.

## FNN Built-In Wallet Backup

FNN stores its built-in wallet key under the node data directory, normally:

```text
<fnn-data-dir>/ckb/key
```

FNN channel state is stored under the Fiber data directory, normally:

```text
<fnn-data-dir>/fiber/store
```

Backup requirements:

- Back up the entire FNN data directory, including `ckb/key`, Fiber store, config, and logs needed for incident reconstruction.
- Store `FIBER_SECRET_KEY_PASSWORD` in an external secret manager, not in the backup archive.
- Stop the FNN process before taking a filesystem backup unless the deployment has a storage-level crash-consistent snapshot.
- Never restore an old channel-state backup while the old node instance may still be running.
- Before upgrades, prefer cooperative channel close when practical. Fiber upstream warns that storage format changes can require channel closure or migration.

Example backup:

```bash
sudo systemctl stop fnn-payee
tar --numeric-owner -czf backups/fnn-payee-$(date +%Y%m%d-%H%M%S).tar.gz /var/lib/fnn-payee
sudo systemctl start fnn-payee
pnpm exec fiber-mpp doctor --role payee
```

Example restore drill:

```bash
sudo systemctl stop fnn-payee
mv /var/lib/fnn-payee /var/lib/fnn-payee.broken.$(date +%s)
mkdir -p /var/lib/fnn-payee
tar -xzf backups/fnn-payee-20260101-120000.tar.gz -C /
export FIBER_SECRET_KEY_PASSWORD='<from secret manager>'
sudo systemctl start fnn-payee
pnpm exec fiber-mpp doctor --role payee
```

If the Fiber release requires a store migration, run the upstream `fnn-migrate` tool against the Fiber data directory before starting the upgraded node.

## FiberMPP Store Backup

Back up the gateway SQLite store separately from FNN:

```bash
pnpm exec fiber-mpp storage backup \
  --config fiber-mpp.gateway.json \
  --out backups/fiber-mpp-$(date +%Y%m%d-%H%M%S).sqlite

pnpm exec fiber-mpp storage check --config fiber-mpp.gateway.json
pnpm exec fiber-mpp storage audit-receipts --config fiber-mpp.gateway.json
```

Restore requires `--force` and the gateway should be stopped first:

```bash
pnpm exec fiber-mpp storage restore \
  --config fiber-mpp.gateway.json \
  --from backups/fiber-mpp-20260101-120000.sqlite \
  --force
```

## Paid-But-Denied Reconciliation

Paid-but-denied means the credential was redeemed and payment verified, but the upstream protected service failed after redemption.

FiberMPP records this as a delivery outcome instead of accepting replay or reissuing a second receipt:

```bash
pnpm exec fiber-mpp storage list-deliveries --config fiber-mpp.gateway.json
```

Policy:

1. `delivered` with `responseStatus < 500`: no action.
2. `failed` with `responseStatus >= 500` or a handler exception: open an incident ticket.
3. Do not mark the credential reusable.
4. Do not reissue a receipt for the same credential.
5. Reconcile commercially by one of:
   - refund/credit outside FiberMPP,
   - manual service fulfillment,
   - operator-issued one-time replacement challenge after confirming the original credential hash cannot replay.
6. Attach the `receiptId`, `challengeId`, `credentialHash`, `responseStatus`, and `failureCode` from the delivery outcome to the incident.

This policy preserves replay safety and makes the commercial compensation path explicit.

## Client And Wallet Boundary

Use [fiber-client-wallet-integration-plan.md](fiber-client-wallet-integration-plan.md) as the integration boundary:

- Direct FNN JSON-RPC is the production default.
- `fiber-pay` is an optional payer/ops companion.
- Browser WASM plus passkey/password is the long-term self-custody payer path.
- CCC/WalletConnect is only for CKB transaction signing such as external channel funding.
- WalletConnect is not a first-class Fiber payment provider because it does not own Fiber channel state or execute `send_payment`.
