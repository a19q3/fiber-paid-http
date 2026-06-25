# FiberMPP Bootstrap Audit And Fix

Date: 2026-06-25

Scope: user, merchant/admin, Fiber node operator, and maintainer bootstrap paths after removal of non-live payment paths.

## Executive Summary

Initial finding: the bootstrap gap was large.

Before this fix pass, FiberMPP had a credible local evidence bootstrap for maintainers, but it did not have a usable production-oriented bootstrap for users, merchants, or administrators. The only real HTTP gateway path was the TypeScript reverse proxy command, and that path required live Fiber RPC environment variables without guidance, readiness validation, config generation, strict secret handling, route/channel checks, or admin lifecycle operations.

The Rust side is now the canonical gateway path: `fiber-mpp-rs server --config` starts the Rust HTTP gateway, issues signed 402 challenges, creates Fiber invoices, verifies settlement, records durable SQLite state, emits `Payment-Receipt`, and rejects replay.

## Fix Status

This pass closes the most dangerous bootstrap gaps without adding product features:

- Added `fiber-mpp init --role gateway --out fiber-mpp.gateway.json`.
- Added role-aware `fiber-mpp doctor --role payer|payee|gateway`.
- Made gateway startup require `FIBER_MPP_SECRET` with at least 32 characters.
- Made `fiber-mpp serve --config ...` apply gateway config.
- Made `fiber-mpp server --config ...` apply gateway config instead of silently starting the demo API.
- Added Fiber RPC `node_info` probing before gateway startup and in doctor reports.
- Removed default live-capable signing secrets from TypeScript gateway/demo runtime and Rust receipt verification.
- Added gateway CORS allow-list enforcement, request body limiting, protected-route rate limiting, health/readiness/metrics endpoints, structured JSON request logs, and graceful shutdown.
- Added SQLite WAL/busy-timeout initialization plus `fiber-mpp storage backup`, `fiber-mpp storage restore`, `fiber-mpp storage export-receipts`, and `fiber-mpp storage audit-receipts`.
- Added production operations evidence: Prometheus alert rules, operator runbook, Fiber node backup/restore guidance, trusted network binding policy, paid-but-denied reconciliation policy, and a gate-checked operations matrix.
- Added the Rust HTTP gateway production path and wired `fiber-mpp-rs server --config` to run it.
- Added [docs/bootstrap.md](../docs/bootstrap.md).

The remaining production blocker is separate testnet Fiber E2E evidence. Route/balance diagnostics beyond peer/channel readiness remain useful follow-up hardening, but they are no longer listed as production readiness blockers in the gate.

## Role Matrix

| Role | Expected bootstrap | Current state | Status |
| --- | --- | --- | --- |
| End user / payer | Install client, configure payer Fiber node, pay a 402 URL, diagnose missing route/funds | `fiber-mpp doctor --role payer` now reports env/RPC blockers before `fiber-mpp pay` | Partial |
| Merchant / resource owner | Initialize app config, set price/resource/upstream, bind payee node, start gateway, rotate secret | `fiber-mpp init --role gateway`, `doctor --role gateway`, `serve --config`, and `previous_secret_envs` rotation windows now exist | Partial |
| Admin / operator | Provision storage, secret, Fiber RPC auth, CORS, logs, backups, metrics, health checks | Secret/storage/RPC bootstrap, env-based RPC auth, redacted logs, metrics, health checks, rate limiting, SQLite schema checks, backup/restore, receipt export/audit, delivery outcome audit, alert rules, runbook, and operations matrix now exist | Mostly usable |
| Fiber node operator | Start/fund/connect local/testnet payer/payee nodes and prove channels | Local maintainer script exists; testnet bootstrap is manual and underspecified | Partial |
| Maintainer | Reproduce local E2E, vectors, reports, gates | Good local path and gates exist | Mostly usable |

## Initial Findings Preserved For Traceability

The findings below describe the pre-fix state that triggered this pass. The `Fix Status` and `Role Matrix` sections above are the current status after the remediation.

### B1. Quick start is not runnable after production-only cleanup

Severity: P1

`README.md` starts the demo API and then tells the user to run `fiber-mpp pay`, but the demo API starts unconfigured and the payer command requires Fiber env vars first.

Evidence:

- `README.md:17-27` starts `@fiber-mpp/demo-api` and then immediately runs `fiber-mpp pay`.
- `README.md:41-54` lists Fiber env vars only after quick start, so the first-run path is inverted.
- Runtime check: `env -u FIBER_MODE -u FIBER_PAYER_RPC_URL -u FIBER_RPC_URL pnpm exec fiber-mpp pay http://localhost:8787/paid/weather --method fiber` exits with `FIBER_MODE must be set to local or testnet`.

Expected:

- Quick start should either be a maintainer local-E2E quick start with `scripts/fiber_local_network.sh up`, or a non-payment console/readiness quick start that does not claim `pay` works.

### B2. `fiber-mpp serve` has no admin bootstrap contract

Severity: P0

The reverse proxy is the closest thing to a real merchant gateway, but it is not bootstrappable by an admin.

Evidence:

- `packages/cli/src/index.ts:33-72` exposes only `--upstream`, `--price-usd`, `--methods`, `--storage`, and `--port`.
- It silently defaults `FIBER_MPP_SECRET` to `fiber-mpp-proxy-secret-at-least-16` at `packages/cli/src/index.ts:46-50`.
- It hardcodes `serverId` as `fiber-mpp-proxy` at `packages/cli/src/index.ts:47-48`.
- It calls `FiberMethodAdapter.fromEnv()` without a preflight report at `packages/cli/src/index.ts:50`.
- Runtime check: `env -u FIBER_MODE -u FIBER_PAYEE_RPC_URL -u FIBER_PAYER_RPC_URL -u FIBER_RPC_URL pnpm exec fiber-mpp serve --upstream http://localhost:8080 --port 9999` exits with only `FIBER_MODE must be set to local or testnet`.

Missing admin bootstrap:

- `fiber-mpp init` or config generator.
- Required secret generation and persistence.
- Payee RPC auth validation.
- Storage path migration/backup guidance.
- Route readiness checks before listening.
- Admin-visible health/doctor endpoint.
- Price/resource registry beyond one global proxy price.

### B3. `fiber-mpp server --config` reads config but ignores it

Severity: P1

The command shape implies a configurable server, but the TypeScript command only parses JSON and then starts the demo API.

Evidence:

- `packages/cli/src/index.ts:97-107` reads `opts.config` and discards it.
- Runtime check with a config containing `listen`, `storage`, `upstream`, and `server_id` still prints only `FiberMPP evidence API listening on http://localhost:9998`.

Impact:

- Admins cannot use config files to bootstrap a real server.
- Config review/audit gives false confidence because the file is syntactically accepted but semantically unused.

### B4. Rust `server --config` was config inspection only

Severity: P1

At the time of the original audit, Rust was the canonical verifier direction but was not a production bootstrap path yet.

Evidence:

- `crates/fiber-mpp-cli/src/main.rs:53-67` maps `server --config` to `fiber_mpp_server::inspect_config`.
- `crates/fiber-mpp-server/src/lib.rs:29-39` returns `status: config-ok`.
- `crates/fiber-mpp-server/src/lib.rs:42-63` only builds a fallback 402 placeholder router.
- Runtime check: `cargo run -q -p fiber-mpp-cli -- server --config <file>` returns JSON `config-ok`; it does not bind `listen` or serve `upstream`.

Impact:

- There is no Rust admin bootstrap despite Rust being the intended trusted boundary.

Current fix:

- `fiber-mpp-rs server --config` now calls `fiber_mpp_server::serve_config`.
- `crates/fiber-mpp-server` now builds a production gateway router with signed challenges, Fiber invoice creation, payment verification, durable SQLite storage, receipt issuance, and replay rejection.

### B5. Demo bootstrap requires `RUN_FIBER_E2E=1`

Severity: P2

The evidence console uses `RUN_FIBER_E2E=1` as a runtime readiness gate. That name is test-oriented, not an admin/product runtime flag.

Evidence:

- `apps/demo-api/src/index.ts:411-430` requires `RUN_FIBER_E2E=1`, `FIBER_MODE`, payee RPC, and payer RPC before enabling live payment.
- `apps/demo-api/src/index.ts:390-408` creates runtime only when that readiness passes.

Impact:

- Admins are forced to use a test variable name to run a live console flow.
- There is no distinction between live demo mode, local evidence mode, and production gateway mode.

### B6. Default secrets remain in live-capable paths

Severity: P1

Default HMAC secrets exist in live-capable TypeScript and Rust-adjacent tooling.

Evidence:

- Reverse proxy default secret: `packages/cli/src/index.ts:46-50`.
- Demo API default secret: `apps/demo-api/src/index.ts:399-406`.
- Rust receipt verify default secret: `crates/fiber-mpp-cli/src/main.rs:116-119`.

Impact:

- A misconfigured deployment can issue or verify receipts under a known secret.
- This blocks any credible admin bootstrap.

Expected:

- Production commands should require `FIBER_MPP_SECRET` or a generated secret stored in a config file with explicit file permissions.
- Test/evidence defaults should be isolated behind test-only commands.

### B7. No payer onboarding beyond raw env vars

Severity: P1

The payer path exists as `paidFetch` and `fiber-mpp pay`, but there is no guided setup for a user/agent.

Evidence:

- `packages/client/src/index.ts:23-59` pays a 402 challenge by constructing a payer adapter from env.
- `packages/cli/src/index.ts:122-142` wraps the same path.
- Missing env produces a low-context adapter error rather than a role-specific checklist.

Missing user bootstrap:

- `fiber-mpp payer init`.
- `fiber-mpp payer doctor` checking RPC reachability, node identity, channel route, balance/funds, and settlement timeout.
- Safe handling of payer RPC auth.
- A documented browser/agent SDK bootstrap.

### B8. No merchant/resource ownership model

Severity: P0

The middleware can protect a route programmatically, but the project has no persisted merchant/admin model.

Evidence:

- `PaidRouteConfig` is an in-process object in `packages/server-middleware/src/index.ts:35-42`.
- `fiber-mpp serve` supports one upstream and one price only at `packages/cli/src/index.ts:33-55`.
- There is no config schema for multiple resources, owners, API keys, admin auth, or per-route policy.

Impact:

- A real administrator cannot add, remove, inspect, or rotate paid resources.
- The system cannot answer who owns a resource, who can change price, or where receipts belong.

### B9. Storage bootstrap is schema-only

Severity: P1

SQLite tables are created automatically, but there is no admin lifecycle around storage.

Evidence:

- `packages/storage/src/index.ts:43-66` creates tables in the constructor.
- No migration version table, backup command, vacuum/check command, retention policy, or receipt export command was found.

Impact:

- Durable replay works locally, but operations cannot safely upgrade, back up, inspect, or restore state.

### B10. Local Fiber network bootstrap is maintainer-specific

Severity: P2

The local network automation is useful evidence tooling, but not user/admin bootstrap.

Evidence:

- `scripts/fiber_local_network.sh` defaults `FIBER_REPO` to `/home/arthur/a19q3/fiber`.
- It depends on local CKB binaries and Fiber test scripts.
- Docs correctly describe it as a local E2E path, not production.

Impact:

- Good for reproducibility, but not suitable for onboarding external admins unless parameterized and documented as dev-only.

## Confirmed Commands

```bash
pnpm exec fiber-mpp --help
pnpm exec fiber-mpp serve --help
env -u FIBER_MODE -u FIBER_PAYEE_RPC_URL -u FIBER_PAYER_RPC_URL -u FIBER_RPC_URL pnpm exec fiber-mpp serve --upstream http://localhost:8080 --port 9999
env -u FIBER_MODE -u FIBER_PAYER_RPC_URL -u FIBER_RPC_URL pnpm exec fiber-mpp pay http://localhost:8787/paid/weather --method fiber
pnpm exec fiber-mpp server --config <temp-config> --port 9998
cargo run -q -p fiber-mpp-cli -- server --config <temp-config>
pnpm exec fiber-mpp refs init
```

Observed:

- `serve` without env exits with `FIBER_MODE must be set to local or testnet`.
- `pay` without env exits with `FIBER_MODE must be set to local or testnet`.
- TypeScript `server --config` starts the demo API and ignores config fields.
- Rust `server --config` now starts the gateway; pre-fix it returned `status: config-ok` only.
- `refs init` only skips existing reference files in this repo.

## Recommended Fix Order

1. Add `fiber-mpp bootstrap doctor` or `fiber-mpp doctor --role payer|payee|gateway` that reports exact blockers before payment or serving.
2. Make `fiber-mpp serve` require `FIBER_MPP_SECRET`; remove default secret from live-capable paths.
3. Add `fiber-mpp init --role gateway` that writes a config template containing storage, server id, upstream, resource routes, Fiber RPC URLs, auth, and secret file reference.
4. Fixed: make `fiber-mpp server --config` apply the config instead of silently ignoring it; make `fiber-mpp-rs server --config` start the Rust gateway.
5. Add explicit payer bootstrap docs and commands: RPC reachability, node info, channel route, balance/funds, invoice-payment dry run if Fiber supports it.
6. Add remaining merchant/admin docs: Fiber node backup/restore, alerting, trusted network binding, and paid-but-denied compensation policy. Fixed by [docs/production-operations.md](../docs/production-operations.md) and `reports/production-operations-matrix.json`.
7. Keep local network scripts under maintainer/dev evidence docs only; do not present them as user/admin onboarding.

## Bottom Line

FiberMPP has a real protocol/evidence core, but bootstrap is currently maintainer-centric. For production-facing credibility, the next work should not be new payment features; it should be a boring but strict bootstrap layer: config generation, role-specific preflight, secret management, gateway config application, and operational docs.
