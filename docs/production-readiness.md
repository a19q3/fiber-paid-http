# Production Readiness

## Current status

FiberMPP uses Rust as the canonical protocol core and verifier target. TypeScript remains a maintained JS ecosystem integration layer for SDKs, demos, examples, F402/MPP compatibility, and vector tooling. The project has local Fiber E2E evidence, separate testnet Fiber E2E evidence, shared conformance vectors, a security matrix, and canonical parity gates.

The Rust HTTP gateway production path implements signed `402 Payment Required` challenge issuance, durable SQLite storage, Fiber method adapter wiring, receipt issuance, and replay rejection. Production readiness is now gated by the recorded testnet Fiber E2E evidence plus production operations evidence.

## Ready

- Typed MPP protocol model.
- Canonical HMAC challenge and receipt signing.
- TypeScript route middleware and reverse proxy mode.
- Gateway bootstrap config template and role-aware doctor checks for Fiber RPC, peers, and `ChannelReady` channels.
- TypeScript gateway requires explicit config; it no longer falls back to the local evidence API.
- TypeScript gateway operator endpoints for `healthz`, `readyz`, and Prometheus-style `metrics`.
- TypeScript gateway CORS allow-list enforcement before challenge issuance, protected-route rate limiting, request body limiting, redacted structured JSON lifecycle/request logs, graceful shutdown, and SQLite WAL/busy-timeout initialization.
- Gateway Fiber RPC auth is supplied through process env or `*_rpc_auth_env` config pointers; literal RPC auth values in gateway config are blocked.
- SQLite storage schema versioning, health checks, backup, and restore commands; backup uses SQLite `VACUUM INTO`, and restore requires explicit `--force`.
- SQLite receipt export and receipt-signature audit commands.
- Paid-but-denied delivery outcome audit records for redeemed credentials whose upstream handler fails or returns a server error.
- Gateway signing secret rotation window: new challenges/receipts are signed with the current `secret_env`, while stored challenges and receipt audits can verify configured `previous_secret_envs`.
- Production operations runbook and alert rules are present and gate-checked:
  - `docs/production-operations.md`
  - `deploy/prometheus/fiber-mpp-alerts.yml`
  - `reports/production-operations-matrix.json`
- Fiber node backup/restore, trusted network binding, and paid-but-denied reconciliation policy are documented in the production operations runbook.
- Client/wallet integration boundaries are documented so direct FNN JSON-RPC remains the production default, `fiber-pay` remains optional payer/ops tooling, and CCC/WalletConnect is limited to external CKB funding/signing.
- Replay protection.
- Resource/method/amount binding tests.
- Explicit local/testnet Fiber settlement status.
- F402 compatibility adapter.
- TypeScript CLI and Rust `fiber-mpp-rs` CLI.
- Local Fiber E2E evidence from the 3-node network.
- Testnet Fiber E2E evidence through funded `v0.9.0-rc4` FNN payer/payee nodes.
- Rust canonical vector verification with TypeScript harness parity.
- Rust HTTP gateway production path issues signed `402 Payment Required` challenges, creates Fiber invoices through FNN JSON-RPC, verifies settlement, records durable challenge/credential/receipt state, emits `Payment-Receipt`, and rejects replay.

## Blockers before live production

- None currently recorded by the gate. Re-run the gates before release or deployment because production readiness is evidence-based and can regress if testnet evidence, operations checks, or canonical parity fail.

## Gate

Run:

```bash
bash scripts/fiber_mpp_gate.sh
bash scripts/fiber_mpp_rust_gate.sh
bash scripts/fiber_mpp_canonical_gate.sh
```

The gates write:

```text
reports/fiber-mpp-ts-gate.json
reports/fiber-mpp-rust-gate.json
reports/canonical-core-parity.json
reports/fiber-mpp-gate.default.json
reports/fiber-mpp-gate.local.json
reports/fiber-local-e2e-evidence.json
reports/production-operations-matrix.json
```

Current production reports may set:

```json
"production_ready_for_fiber_method": true
```

This value is valid only when `testnet_fiber_e2e`, `production_operations`, `rust_gateway_production_path`, conformance vectors, and security matrix checks all pass.
