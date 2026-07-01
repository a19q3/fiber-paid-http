# Fiber Paid HTTP Evidence Console — Theatre / Placeholder / Stub Audit

**Scope**: `apps/demo-api/`, `apps/demo-web/`, plus the gate reports they read.
**Method**: read every source file end-to-end, diff each visible claim against the actual code path, cross-check report JSON files on disk.
**Date**: 2026-06-25 (against commit `4bcb129`).
**Verdict (TL;DR)**: The console is **largely honest**. Mock-vs-live labeling is correct, no fake status dots, no fake payment hashes, no fabricated receipts. But there are **3 real theatre defects**, **6 production-readiness gaps**, and **3 documentation/UX gaps**. Details below, all line-cited.

---

## 1. Theatre / honest-mislabeling defects

### T1. Demo `/api/demo/pay` log emits "node1/node2/node3" actor strings that imply live nodes when in mock mode — *the only mode the console's default-flow actually exercises*

**Location**: `apps/demo-api/src/index.ts:272-285`

```ts
appendEvent(flow, "INFO", "node1 (payer)", "send_payment", `payment_hash=${flow.fiberChallenge!.paymentHash}`);
const proof = await payerFiber.payChallenge(flow.fiberChallenge!);
...
appendEvent(flow, "INFO", "node2 (router)", "forward payment", "route=node1->node2->node3");
appendEvent(flow, "INFO", "node3 (payee)", "payment settled", `status=${...}`);
```

The first log is fine — `payerFiber` is the actual adapter that just ran `payChallenge`. The next two (`node2 (router): forward payment`, `node3 (payee): payment settled`) are **synthesized** purely for visual narrative. There is no router call and no second hop. The proof returned by `payChallenge` already encodes the result; appending two "node" events makes the timeline look like a 3-node payment even when the whole chain was a local mock.

**Severity**: medium. The demo-api `/api/status` (`apps/demo-api/src/index.ts:181-183`) does correctly downgrade `networkStatus` to `"unconfigured"` when mock mode is active, so the network widget shows the right state. But the timeline (`apps/demo-web/index.html:1514-1537`) renders `node2/node3` events literally, and the integration test (`tests/integration/full-flow.test.ts:32, 37`) only checks the absence of strings `"robot"` and `"online"`, not `"node2 (router)"`. So the synthesized events are technically theatre.

**Fix**: only emit `node2/node3` events when `mode !== "mock"`. In mock mode the payer event alone is honest.

### T2. Demo `/api/status` `localFiberNetwork.channelCount: 2` and `route: ["node1","node2","node3"]` are hardcoded literals, not live RPC counts

**Location**: `apps/demo-api/src/index.ts:204-206`

```ts
route: ["node1", "node2", "node3"],
channelCount: 2,
routeStatus: mode.liveReady ? "live connected" : localEvidence ? "evidence recorded" : "not configured"
```

The route list and channel count never change. They only reflect the saved `fiber-local-e2e-success.json` evidence *that a previous run opened those channels* — there is no in-process Fiber RPC call to `list_channels` to confirm they're currently open. The widget will show `routeStatus: "evidence recorded"` forever after the first successful `fiber-live.e2e.test.ts` run, even if the local network is currently torn down.

**Severity**: low. The text accurately says "evidence recorded", not "live now". But the channel count of 2 is a magic number from `scripts/fiber_local_network.sh:107,115` (`open_channel` is called twice), not a runtime introspection.

**Fix (optional)**: if `mode.liveReady`, call `payeeRpc.listChannels(node3pubkey)` and surface real counts. Currently the `FiberRpcClient` exposes `listChannels` (`packages/fiber-method/src/index.ts:93`) but the demo never wires it up.

### T3. "Fiber Network" widget uses `status: "connected"` only when `RUN_FIBER_E2E=1` is set, but the demo's own `pay` button stays enabled in mock mode and just uses the local FiberMethodAdapter mock

**Location**: `apps/demo-api/src/index.ts:183`, `apps/demo-api/src/index.ts:378-392`

The `networkStatus` string is derived from `mode.liveReady`, which only becomes true when `RUN_FIBER_E2E=1` AND `FIBER_MODE∈{local,testnet}` AND both RPC URLs are set. So the widget says "unconfigured" while the underlying middleware happily creates Fiber challenges, accepts mock payments, and issues real HMAC-signed receipts. That is *correct* per the design — Fiber Paid HTTP mock is a deliberate development mode — but a user staring at the console might think "unconfigured" means broken. The badge says `Live Fiber E2E: N` and the status text says "unconfigured", but the receipt they just received is real (signed, hash-verified) — just not against a live network.

**Severity**: low / by-design. Worth a doc string. The `static-events` fallback in `apps/demo-web/index.html:1608-1615` already explains this implicitly (`"rust canonical engine: vectors verified"`, `"typescript compatibility tooling: not production boundary"`, `"replay protection: credential single-use"`).

---

## 2. Real placeholders / stubs (not theatre, but un-implemented)

### P1. `examples/paid-api/` and `examples/paid-mcp-tool/` are README-only directories

**Location**: `examples/paid-api/README.md`, `examples/paid-mcp-tool/README.md`

```
examples/paid-api/README.md
examples/paid-mcp-tool/README.md
```

No `package.json`, no source. Despite `apps/demo-api` exposing `/paid/mpp-tool` with `tool: "fiber_paid_http.echo"`, the example claimed in the README does not exist in the repo. The MCP integration is **not implemented**.

### P2. `packages/stripe-method` and `packages/tempo-method` are mocks only

**Location**: `packages/stripe-method/src/index.ts`, `packages/tempo-method/src/index.ts`

Both classes hard-code `mode = "mock"` and only verify proofs that already declare `status: "settled"`. There is no real Stripe API call, no real Tempo RPC client. The `PaymentMethodChallengeSchema` (`packages/core/src/types.ts:28-53`) accepts `tempo` and `stripe` but the `fiber-paid-http pay` CLI only handles `--method fiber` (`packages/cli/src/index.ts:115-118`: `if (opts.method !== "fiber") throw`). Multi-rail is **advertised but not implemented**.

### P3. `apps/demo-web` static console has no actual build step

**Location**: `apps/demo-web/package.json:6-10`

```json
"build": "node -e \"console.log('evidence console static build ok')\"",
"lint": "node -e \"console.log('evidence console static lint ok')\"",
"typecheck": "node -e \"console.log('evidence console static typecheck ok')\""
```

`pnpm build`, `pnpm lint`, `pnpm typecheck` for `demo-web` are no-op `console.log` stubs. The "static build" claim in `pnpm build` is literally a one-liner. There is no HTML linter, no link checker, no a11y check on the 1655-line `index.html`. (The HTML does use `aria-hidden` on the decorative marks at lines 1036, 1127 — at least that part is real.)

### P4. Reverse-proxy `serve` CLI has no real upstream integration test

**Location**: `packages/cli/src/index.ts:43-71`, `tests/integration/full-flow.test.ts:69-95`

The integration test mocks the upstream with an inline `fetchImpl` that returns `Response.json({upstream, authForwarded})`. There's no test that runs `fiber-paid-http serve --upstream http://localhost:8080` against a real HTTP upstream. The `serve` command has `cors expose headers` for `payment-receipt, www-authenticate` (Hono middleware `apps/demo-api/src/index.ts:147`); the CLI `serve` is plain `node:http` and doesn't set CORS headers at all.

### P5. `fiber-paid-http f402 convert` writes to stdout only; there is no batch F402 issuer, no F402-from-server middleware

**Location**: `packages/cli/src/index.ts:133-164`

The CLI converts an F402 JSON file into a MPP challenge+credential pair and prints JSON. There is no `fiber-paid-http f402 serve` command. The README (`README.md:92`) advertises `fiber-paid-http f402 convert f402-challenge.json` but the only thing that runs is JSON-to-JSON conversion with no payment, no receipt. That's fine for tooling but it's not "F402 server compatibility".

### P6. `fiber-paid-http refs init` writes sample reference notes, but the real ones in `docs/refs/` are pre-existing

**Location**: `packages/cli/src/index.ts:73-83`

`refs init` writes `docs/refs/*.md` only if they don't already exist. They do. So the command is effectively dead unless someone deletes the docs. Not a stub per se, but the function is unreachable in the normal workflow.

---

## 3. Production-readiness gaps (what's actually missing for production)

These are the items the gate reports themselves list as `production_blockers`, plus what they don't list. All are honest gaps — the gate does not paper over them.

### G1. Testnet Fiber E2E evidence still pending

**Evidence in reports**: `reports/fiber-paid-http-gate.local.json` shows `fiber_e2e_mode: "local"`, `fiber_e2e_status: "passed"`, `live_fiber_local_e2e: true`, payment_hash `0xec3a08f9b298db82f2dc27861aed5a3110b5d36a56bd43d13b60c5a4bcf69222`, receipt_id `rcpt_ca010a79973755656bdff4b1684570da`.

**Gap**: this is the local e2e network (`scripts/fiber_local_network.sh` spins up `e2e/router-pay` against `tests/nodes/start.sh`). The corresponding **testnet** run has never been executed and recorded. `tests/integration/fiber-live.e2e.test.ts:95` defaults to `currency: env.FIBER_CURRENCY ?? (preflight.mode === "testnet" ? "Fibt" : "Fibd")` — the testnet currency `Fibt` is defined but never proven. There is no testnet fixture channel. To close this: provision real testnet Fiber node, run `RUN_FIBER_E2E=1 FIBER_MODE=testnet FIBER_PAYEE_RPC_URL=... FIBER_PAYER_RPC_URL=... pnpm test:fiber`, capture resulting `reports/fiber-e2e-result.json` into the testnet variant of the gate.

### G2. Operational hardening still pending

**What's missing** (read from `apps/demo-api/src/index.ts` and `packages/server-middleware/src/index.ts`):

1. **No structured logging.** `console.log` everywhere; no log level, no request id, no correlation id. Production needs a JSON logger (pino etc).
2. **No metrics.** No Prometheus `/metrics`, no OpenTelemetry trace, no counters for 402/200/402-replay. The demo-api exposes no health endpoint distinct from `/free`.
3. **No graceful shutdown.** Hono `serve()` does not trap `SIGTERM`. `packages/cli/src/index.ts:67` `.listen()` does not either.
4. **No rate limiting.** Middleware `middleware.protect()` (`packages/server-middleware/src/index.ts:71`) has no per-IP / per-token throttle. Replay protection is per-credential, not per-source.
5. **No CORS hardening.** `apps/demo-api/src/index.ts:144-148` returns `Access-Control-Allow-Origin: *`. Production should restrict origins.
6. **No TLS termination documentation.** `crates/fiber-paid-http-server/src/lib.rs:42-66` is axum with no TLS config; production needs termination guidance.
7. **Secret rotation.** Middleware takes one `secret`. No rotation window. `signChallenge`/`signReceipt` (`packages/core/src/crypto.ts:39-77`) use a single HMAC secret.
8. **Clock skew handling.** `clockSkewSeconds: 2` (default) is hard-coded. Production deployments across regions need config.
9. **`InMemoryStore` is the demo default.** Production mode *refuses* in-memory unless `ALLOW_IN_MEMORY_STORE=1` (`packages/server-middleware/src/index.ts:75-78`), but `fiber-paid-http serve` defaults to `memory://`. The CLI default is the wrong default for any "serve" command.
10. **No store migration / schema versioning.** `SqliteStore` (`packages/storage/src/index.ts:101-200`) creates tables with `CREATE TABLE IF NOT EXISTS`, no version column, no upgrade path.
11. **No multi-process safety test.** `SqliteStore.saveCredentialUse` relies on `INSERT` primary-key conflict. No WAL mode, no busy_timeout.
12. **No PII handling.** `evidence: { smoke: true }` from demo-api lands in credential payload. In production the `evidence` field could leak upstream RPC responses.

### G3. Long-running deployment hardening still pending

1. **Memory boundedness.** `DemoFlowState` (`apps/demo-api/src/index.ts:48-63`) holds events in a single shared object; in production the same shape leaks. No event caps.
2. **No background reconciliation.** If Fiber RPC disconnects mid-session, no retry queue. `packages/fiber-method/src/index.ts:410-468` waits with timeout but doesn't persist a "pending" state for later retry.
3. **No receipt revocation.** Once issued, a receipt is forever. No revocation list, no TTL on `getReceipt`.
4. **Idempotency.** `markChallengeUsed` is single-use, but `paidFetch` (`packages/client/src/index.ts:29-72`) re-issues a challenge on every retry — production idempotency keys would help.
5. **No migration path for `serverId`.** `apps/demo-api/src/index.ts:127` defaults to `"fiber-paid-http-demo-api"`. Receipts bind to `serverId` (`packages/core/src/types.ts:106`); changing it invalidates old receipts.
6. **No backup/restore story for `SqliteStore`.** The DB at `.tmp/fiber-live-e2e.sqlite` (or wherever configured) is the single point of failure for credential replay protection.
7. **Rust server (`crates/fiber-paid-http-server`) is just a 402 placeholder.** It has no challenge issuance, no FiberMethodAdapter, no storage. `gateway_router` returns a hardcoded 402 with a `Cache-Control: no-store` header. The Rust server is **not feature-complete**; the trusted Rust verifier is the CLI (`crates/fiber-paid-http-cli`), not a server. This is a major missing surface for "Rust = canonical engine". README/docs imply parity; the code shows partial parity.

### G4. Console-side missing features (not gaps, but listed for completeness)

1. **No WebSocket / SSE push.** Console polls (`refreshStatus`, `loadReports` run once on init only; `runAction` re-fetches after each action). Real-time status requires manual refresh.
2. **No auth on `/api/*`.** Console can call `paidFetch` (via demo flow), but there's no separation between operator/admin endpoints and consumer endpoints. Anyone with network access to `:8787` can mint challenges and read every report.
3. **No "real testnet" tab.** Console renders `Local Fiber Evidence` but never testnet; the data structure supports it (`reports.fiber.data.fiber_commit` is shown), but the testnet fiber-evidence file doesn't exist.
4. **No screenshots on commit.** `reports/evidence-console-desktop.png` and `evidence-console-mobile.png` exist (per `ls reports/`) but no CI step regenerates them; they're stale evidence of a past run.
5. **The `Ctrl+U/P/R/Y` keyboard shortcuts are documented but invisible** until you press them (`apps/demo-web/index.html:1207-1213`). They work, but no in-app hint.

---

## 4. Honest vs dishonest surfaces (cross-check matrix)

| Surface | Claim | Reality | Honest? |
| --- | --- | --- | --- |
| `badges.productionReady` | `false` | Hard-coded false in every gate | ✅ Yes |
| `badges.localFiberE2e` | From `fiber-paid-http-gate.local.json` | `live_fiber_local_e2e: true` after one local run | ✅ Yes |
| `badges.rustCanonicalEngine` | From `canonical-core-parity.json` | `rust_canonical_verifier: true` | ✅ Yes |
| `badges.tsVectorHarness` | From `canonical-core-parity.json` | `typescript_vector_harness: true` | ✅ Yes |
| `badges.f402Compatibility` | From `canonical-core-parity.json` | `f402_parity: true` | ✅ Yes |
| `localFiberNetwork.node*.status` | `connected`/`evidence`/`unconfigured` | Three-state mapping correct | ✅ Yes |
| `localFiberNetwork.channelCount` | `2` | Hardcoded literal; only true if local net was opened with the shipped script | ⚠️ Accurate but stale-able |
| Timeline `node2/node3` events | Implies real router/payee nodes | Synthesized strings in mock mode | ❌ Theatre (T1) |
| Timeline `payment_hash` | Real hash | Real, from `flow.fiberChallenge.paymentHash` | ✅ Yes |
| Timeline `receipt_id` | Real receipt id | Real, from decoded `Payment-Receipt` header | ✅ Yes |
| `reports.security-matrix.json` | All attacks `covered` | Generated by `vectors.ts`; checks each vector passes | ✅ Yes |
| `toolchain_shims_used` | Lists `cargo` and `nc` shims | Detected by log grep on `reports/fiber-local-network/*.log` | ✅ Yes |
| `fiber_commit` in tsGate | `3c25bcf1...` | Real `git rev-parse HEAD` of external `/home/arthur/a19q3/fiber` | ✅ Yes |
| `/paid/echo` price | `$0.01` | Hardcoded; uses `options.price ??` fallback (`apps/demo-api/src/index.ts:260`) | ✅ Yes (defined) |
| `/paid/protocol-service` price | `100 Fibd` | Defined in `defaultResources` (`apps/demo-api/src/index.ts:80`) | ✅ Yes |
| Static events fallback | "rust canonical engine: vectors verified" | True: 14/14 pass | ✅ Yes |
| Static events fallback | "typescript: not production boundary" | True: `typescript_trusted_boundary: false` in canonical report | ✅ Yes |
| `staticEvents().log` "credential single-use" | Replay protection | True: `saveCredentialUse` uses INSERT conflict (`packages/storage/src/index.ts:167-180`) | ✅ Yes |

---

## 5. Things the audit confirmed are NOT theatre (so the console's claims stand)

- **Receipts are real HMAC-signed artifacts.** `apps/demo-api/src/index.ts:301-303` decodes `PAYMENT_RECEIPT_HEADER`; `signReceipt` (`packages/core/src/crypto.ts:58-77`) does proper HMAC-SHA256 + canonical-JSON.
- **Replay protection is real.** `tests/integration/full-flow.test.ts:175` proves same credential returns 402 second time.
- **Wrong-resource rejection is real.** `apps/demo-api/src/index.ts:285` calls `protectResource` which passes through the middleware; `tests/integration/full-flow.test.ts:173` asserts `/paid/file` with weather credential returns 402.
- **Expired-challenge rejection is real.** `tests/integration/full-flow.test.ts:177-192` uses `challengeTtlSeconds: -5` and asserts 402.
- **The 14-vector conformance harness is real.** Both Rust (`crates/fiber-paid-http-core/src/lib.rs:159-176`) and TS (`packages/cli/src/vectors.ts`) have explicit `verifyVectorInput` cases for each of: challenge.valid, credential.valid, receipt.valid, attack.* (6), resource.hash.valid, f402.{challenge,credential}.valid, fiber.local-e2e.{receipt,report}. All 14 vectors pass in both engines with identical `canonical_hash`, `actual`, and `actual_error_code` per `reports/rust-conformance.json` and `reports/ts-conformance.json`.
- **The Rust server's 402 endpoint is real.** `crates/fiber-paid-http-server/src/lib.rs:42-87` builds an axum router that returns 402 with `Cache-Control: no-store` and a problem+json body. The integration test in the same file (`crates/fiber-paid-http-server/src/lib.rs:75-86`) verifies it.

---

## 6. Recommended fix priority

1. **(G1)** Run the testnet E2E and capture evidence. ~half-day, requires external testnet access.
2. **(T1)** Drop the synthesized `node2/node3` events from `/api/demo/pay` in mock mode. ~10 lines, no risk.
3. **(G3.7)** Make Rust server actually feature-complete (challenge issuance, storage, method adapter) — the production story rests on Rust = canonical engine. Multiple days.
4. **(P2)** Either implement real Stripe/Tempo adapters, or remove `tempo`/`stripe` from `PaymentMethodChallengeSchema` and the `methods: ["fiber", "tempo", "stripe", "mock"]` CLI option. One full sprint either way.
5. **(G2)** Add TLS/RPC auth deployment docs, log redaction policy for external sinks, production alerting, and runbooks. One week.
6. **(T2)** Replace hardcoded `channelCount: 2` with live `listChannels` call when in live mode. ~30 lines.
7. **(P1)** Either ship `examples/paid-mcp-tool` or remove the route from `defaultResources`. 30 minutes.
8. **(P3)** Replace `console.log` stubs in `demo-web/package.json` with real HTML lint or remove them. 1 hour.

---

## 7. Conclusion

The Fiber Paid HTTP Evidence Console is **mostly honest**. The mock-vs-live labeling is precise, the gate reports reflect real pass/fail, and the receipts/payment-hashes shown in the UI are genuine cryptographic artifacts. There is **no fabricated "online" status**, no fake receipts, no invented Fiber commit hash.

The three real theatre defects (T1, T2, T3) are **timing-label issues**, not security/claim issues. T1 is the only one that materially misleads — the timeline shows two extra "node" log lines that don't correspond to real nodes in the default mock-mode flow. T2 is a magic-number latency in the network widget. T3 is by-design.

The six production gaps (G1–G3) are honestly listed in every gate report's `production_blockers` array. The Rust server missing challenge issuance is the largest silent gap — the README/docs imply Rust is the canonical engine for the full server surface, but the Rust server crate only does 402 stub responses; challenge issuance, storage, and method adapters live only in TypeScript today.
