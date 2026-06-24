# Production Readiness

## Current status

FiberMPP uses Rust as the canonical protocol core and verifier target. TypeScript remains a maintained JS ecosystem integration layer for SDKs, demos, examples, F402/MPP compatibility, and vector tooling. The project has local Fiber E2E evidence, shared conformance vectors, a security matrix, and canonical parity gates.

It is still not production-ready for live Fiber settlement. The Rust `fiber-mpp-server` crate is currently a visible HTTP 402 gateway prototype; challenge issuance, durable storage, method adapter wiring, and production gateway behavior are not feature-complete there.

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
- Replay protection.
- Resource/method/amount binding tests.
- Explicit local/testnet Fiber settlement status.
- F402 compatibility adapter.
- TypeScript CLI and Rust `fiber-mpp-rs` CLI.
- Local Fiber E2E evidence from the 3-node network.
- Rust canonical vector verification with TypeScript harness parity.
- Rust HTTP gateway prototype returns visible `402 Payment Required` responses.

## Blockers before live production

- Add separate testnet Fiber E2E evidence.
- Complete Rust HTTP gateway challenge issuance, storage, method adapter wiring, and receipt issuance before treating Rust server paths as production.
- Complete production alerting/runbooks.
- Complete Fiber node backup/restore procedure and trusted network binding.
- Decide the business compensation policy for paid-but-denied cases after the gateway records failed delivery outcomes.

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
```

All production reports must keep:

```json
"production_ready_for_fiber_method": false
```
