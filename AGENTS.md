# AGENTS.md — Fiber Paid HTTP

Fiber Paid HTTP is a **Rust-first MPP-draft gateway and proposed Fiber payment-method toolkit**. The current Payment HTTP Authentication draft is the core wire contract; `fiber` is a project method profile, not a claimed registered method. F402 and F-L402 are explicit ingress adapters into the same Fiber settlement, replay, delivery, and receipt verifier. It is a TypeScript pnpm workspace (`packages/*`, `apps/*`) **plus** a Rust Cargo workspace (`crates/*`). Rust is the production canonical engine; TypeScript is SDK, evidence-console, compatibility adapters, and vector tooling.

## Quick start

```bash
pnpm install
pnpm build
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-paid-http init --role gateway --out fiber-paid-http.gateway.json
pnpm exec fiber-paid-http doctor --role gateway --config fiber-paid-http.gateway.json
pnpm --filter @fiber-paid-http/evidence-api start        # evidence API on :8787
# in another shell:
pnpm --filter @fiber-paid-http/evidence-web start        # evidence console on :8788 (serves dist/)
```

Fiber payment execution requires `FIBER_MODE=local` or `FIBER_MODE=testnet` plus real payer/payee Fiber RPC endpoints. Without those variables, `pnpm test:fiber` runs the visible preflight and reports skipped blockers.

## Workspace layout

| Path | Role |
| --- | --- |
| `packages/core` | JCS, challenge HMAC binding, base64url, MPP-draft zod types, and HTTP header helpers (`PAYMENT_AUTH_SCHEME`, `PAYMENT_RECEIPT_HEADER`). |
| `packages/storage` | `FiberPaidHttpStore` interface + durable `SqliteStore` (uses Node 24 `node:sqlite`) and Redis-compatible interface. |
| `packages/fiber-method` | `FiberRpcClient` and `FiberMethodAdapter` (local / testnet). Includes `createChargeRequest`, `payCharge`, `waitForFiberInvoicePaid`. |
| `packages/server-middleware` | `createFiberPaidHttpMiddleware`, `createReverseProxyHandler`, `PaidRouteConfig`. Requires a secret of at least 32 characters and durable storage. |
| `packages/f402-compat` | `f402ChallengeToMpp`, `f402ProofToCredential`. |
| `packages/x402-compat` | Strict x402 v2 `exact` + `fiber:{network}` converters backed by official `@x402/core`; no facilitator or second settlement path. |
| `packages/client` | `paidFetch`, `inspectChallenge`. |
| `packages/cli` | The `fiber-paid-http` command (commander). Vectors live in `packages/cli/src/vectors.ts`. |
| `apps/evidence-api` | Hono app exposing `/paid/*` plus evidence console JSON APIs. |
| `apps/evidence-web` | React + Vite SPA: three-column shell (Sidebar + Main + Inspector), SettingsDrawer, PreferencesPopover. Built to `dist/`, served by `server.mjs`. Source in `src/{layouts,views,settings,components,state,lib}`. |
| `examples/{paid-api,paid-mcp-tool}` | README-only (no source yet). |
| `crates/fiber-paid-http-core` | Rust canonical engine: MPP-draft models, JCS, headers, challenge binding, receipt validation, and vector verification. |
| `crates/fiber-paid-http-storage` | Rust `SqliteStore` with atomic challenge redemption (rusqlite). |
| `crates/fiber-paid-http-fiber` | Fiber RPC param builders + `live_proven_semantics()` (new_invoice, send_payment, get_payment, get_invoice). |
| `crates/fiber-paid-http-f402` | F402 proof → credential conversion, `canonical_equal`. |
| `crates/fiber-paid-http-x402` | Rust x402 v2 Fiber boundary converter; canonical gateway settlement/replay remains unchanged. |
| `crates/fiber-paid-http-server` | axum production gateway with MPP 402, Fiber readiness, SQLite, rate limits, size/timeout bounds, metrics, and delivery-aware receipts. |
| `crates/fiber-paid-http-cli` | `fiber-paid-http-rs` binary: `vectors verify`, `receipt verify`, `challenge inspect`, `doctor`, `server --config`. |
| `test-vectors/` | Shared protocol truth — 20 deterministic fixtures plus 2 live-Fiber evidence fixtures. Both engines agree byte-for-byte on canonical hash, result, and error code. |

## Commands

### TypeScript (root)
```bash
pnpm install --frozen-lockfile     # gate requires this; never bump lockfile casually
pnpm lint                          # pnpm -r --if-present lint (delegates to each package)
pnpm typecheck                     # tsc -p tsconfig.json --noEmit
pnpm test                          # vitest run --config vitest.unit.config.ts (tests/unit/**)
pnpm test:integration              # vitest run --config vitest.integration.config.ts
                                   # (excludes fiber-preflight.test.ts and fiber-live.e2e.test.ts)
pnpm test:fiber                    # vitest run --config vitest.fiber.config.ts
                                   # preflight always runs; live E2E only when env ready
pnpm build                         # pnpm -r --if-present build
pnpm gate                          # bash scripts/fiber_paid_http_gate.sh (writes reports/fiber-paid-http-gate.json)
pnpm evidence:api                      # @fiber-paid-http/evidence-api start
pnpm evidence:web                      # @fiber-paid-http/evidence-web start
pnpm evidence:production-bootstrap     # real Rust gateway + TLS + testnet Fiber evidence
pnpm exec fiber-paid-http vectors verify # TS vector harness (writes reports/ts-conformance.json)
pnpm exec fiber-paid-http vectors generate
```

### Rust (root)
```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p fiber-paid-http-cli -- vectors verify      # writes reports/rust-conformance.json
cargo run -p fiber-paid-http-cli -- receipt verify <file>
cargo run -p fiber-paid-http-cli -- challenge inspect <file>
cargo run -p fiber-paid-http-cli -- doctor
bash scripts/fiber_paid_http_rust_gate.sh              # writes reports/fiber-paid-http-rust-gate.json
bash scripts/fiber_paid_http_canonical_gate.sh         # writes reports/canonical-core-parity.json
                                   # asserts TS↔Rust parity on 20 deterministic vectors + 2 evidence fixtures
```

### Fiber live E2E (optional)
```bash
bash scripts/fiber_local_network.sh up          # starts Fiber router-pay e2e + opens channels
RUN_FIBER_E2E=1 \
  FIBER_MODE=local \
  FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 \
  FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 \
pnpm test:fiber
```
For production-readiness evidence, use `bash scripts/fiber_testnet_e2e.sh` with testnet payer/payee endpoints, a payee RPC auth value from an authenticated trusted proxy, and the 32+ character challenge secret. It runs the Rust gateway behind ephemeral TLS and generates the bootstrap report before the canonical gate.
The gate (`scripts/fiber_paid_http_gate.sh`) runs all of the above and additionally **regression-guards** that `pnpm test:fiber` actually loads `fiber-preflight.test.ts` (failure → `fiber_e2e_status="failed"`). Reports land in `reports/`.

## Architecture and control flow

```
client  ─HTTP─▶  middleware.protect(route)  ─▶  fiber.createChargeRequest  ─▶  402 + WWW-Authenticate: Payment
                                                    ▲
                                                    │ FiberMethodAdapter
                                                    │ (local | testnet)
client  ─replay─▶ middleware.verifyCredential ─▶  store.consumeRedemption ─▶  upstream 2xx + Payment-Receipt
                         │             │
                         │             └─ checks exact echoed challenge, HMAC id, expiry,
                         │                URL/method/body digest, payment hash, amount,
                         │                Fiber settlement, atomic single use
                         └─ polls get_payment/get_invoice with payment "Success"
                            and invoice "Paid"
```

Both Rust (`crates/fiber-paid-http-core`) and TypeScript (`packages/core`) implement RFC 8785 JCS. Every test vector records the expected canonical SHA-256, expected accept/reject, and expected error code — both engines must match all three.

## Protocol invariants

- **Canonical JSON**: RFC 8785 JCS for challenge `request`/`opaque`, bindings, resource and credential hashes, and vectors; credential/receipt envelopes accept ordinary valid JSON member ordering. No `BigInt` or non-JSON values.
- **Challenge binding**: HMAC-SHA256 challenge ID, compared in constant time.
- **Resource hash**: `sha256(JCS({method, url, digest?, contentType?}))`; an RFC 9530 digest is required for non-GET/HEAD.
- **Replay**: SQLite atomically consumes a challenge and uniquely records challenge, credential hash, and payment hash. Replay → 402.
- **Receipt**: MPP core fields plus the Fiber profile's `challengeId` extension; emitted only after upstream `2xx` delivery.
- **Fiber RPC encoding**: integers sent as `"0x..."` hex strings (not decimal). Settlement poll status strings: payment `Success`, invoice `Paid`.
- **No offline payment execution mode**: `FiberMethodAdapter.fromEnv` only accepts `FIBER_MODE=local` or `FIBER_MODE=testnet` and requires real Fiber RPC endpoints.

## Naming and style

- TypeScript: `strict`, `noUncheckedIndexedAccess`, ES2022 + `NodeNext`, `*.js` import suffixes required. Public APIs use `public`/`public readonly` explicit modifiers. `FiberPaidHttpError` carries `code` + `status`. Schemas from `zod` are the canonical types — use `z.infer<...>` aliases.
- Rust: `edition 2021`, `thiserror` for errors, `serde_json::Value` for dynamic vector inputs, `BTreeMap` for deterministic ordering. `Outcome { result, error_code }` is the verifier return type.
- Tests: vitest. `describe("core protocol primitives", ...)` style. Live Fiber test is gated on `RUN_FIBER_E2E=1` + `FIBER_MODE ∈ {local, testnet}` + both payee/payer RPC URLs (see `tests/integration/fiber-e2e-env.ts`).

## Gotchas and non-obvious rules

1. **The CLIs have explicit roles**: `fiber-paid-http` is TypeScript SDK, evidence, compatibility, storage, and reference tooling. `fiber-paid-http-rs server --config ...` is the production gateway; there is no engine switch or silent fallback.
2. **vitest aliases are repo-root derived** in `vitest.unit.config.ts`. Keep `tsconfig.base.json` `paths` mirrored when adding or renaming packages, because tests and editors rely on the same workspace package map.
3. **`pnpm test:integration` excludes the preflight + live E2E tests.** Those run only via `pnpm test:fiber`. The integration config excludes `FIBER_PREFLIGHT_TEST_FILE` and `FIBER_LIVE_TEST_FILE` explicitly; `pnpm test` and `pnpm test:integration` will never touch live RPC.
4. **`vitest.fiber.config.ts` reads env at config load time.** Set `RUN_FIBER_E2E=1` + Fiber env vars before invoking vitest, or preflight-only runs.
5. **`scripts/bin/cargo` and `scripts/bin/nc` are toolchain shims** auto-prepended to `PATH` inside `scripts/fiber_local_network.sh`. They are NOT used elsewhere. The cargo shim only mutates args when running inside the external Fiber repo (`FIBER_REPO`); the nc shim only supports `nc -z HOST PORT` (matches what Fiber's `tests/nodes/wait.sh` calls).
6. **`reports/fiber-e2e-result.json` is the live E2E status file** (see `tests/integration/fiber-e2e-env.ts`). The gate reads this directly, but also has log-grep guards: if `pnpm test:fiber` output contains "No test files found" OR lacks `fiber-preflight.test.ts`, the gate marks Fiber E2E as **failed** regardless of exit code.
7. **Gate reports are evidence artifacts.** A protocol, receipt-schema, or Fiber-commit change invalidates earlier live evidence; do not copy identifiers into a new report.
8. **Durable storage is mandatory.** Both gateway implementations require SQLite. Only the Rust gateway is the trusted production verifier. The project has one canonical schema v1; unsupported versions or noncanonical table layouts fail closed and require a clean project database.
9. **Secret length floor.** Gateway, rotation, and F-L402 root secrets require at least 32 characters.
10. **`apps/evidence-api/src/index.ts` reads reports from `reports/`** (canonical-core-parity, fiber-local-e2e-evidence, gate.*). The evidence console only shows real status when these exist; otherwise it renders `static-evidence` mode and `node*.status: "unconfigured"`.
11. **`production_ready_for_fiber_method` is evidence-gated.** It can be `true` only while preserved testnet Fiber E2E evidence verifies against the current Fiber commit, production operations checks pass, and production bootstrap E2E evidence is present.
12. **TypeScript is NOT a trusted verifier.** `typescript_trusted_boundary: false` is asserted in the canonical parity gate. Any new verifier MUST be in Rust.
13. **Vector parity is exact**: `canonical_hash`, `actual` (Accepted/Rejected), `actual_error_code`, and `passed` must all match across both engines per `crates/fiber-paid-http-core/src/lib.rs:compare_reports`. Adding a new vector requires updating both `packages/cli/src/vectors.ts` (`verifyVectorInput` case) and `crates/fiber-paid-http-core/src/lib.rs` (`verify_vector_input` case).
14. **`apps/evidence-web` is a React + Vite SPA** built to `dist/` and served by `server.mjs`. `pnpm --filter @fiber-paid-http/evidence-web build` runs Vite; `typecheck`/`lint` run `vite build` + `check-static.mjs` (verifies dist/ contains required API endpoint strings and DOM anchors). Layout, action coverage, and browser smoke checks run through the gate. Check scripts read `dist/` (not source). Icons are imported from `lucide-react` directly (no sprite sync). `@types/react` must be added to devDependencies for `tsc --noEmit` to work — until then, `typecheck` uses the build-based approach.
15. **`node_modules/` is committed-adjacent only via lockfile**; `.gitignore` excludes `node_modules/`, `dist/`, `target/`, `.tmp/`, `*.db`, `*.sqlite`, `reports/fiber-local-network/*.pid`, `reports/fiber-local-network/*.log`. Reports themselves are committed.
16. **CI gate (`scripts/fiber_paid_http_gate.sh`) fails on Fiber E2E "failed" status** via the final `node -e '... process.exit(...)'` check. Even if everything else passes, a `fiber_e2e_status === "failed"` exits non-zero.
17. **The current Fiber E2E workflow pins CKB `0.202.0`.** Keep the adjacent CKB source checkout current, but run Fiber's dev network with an exact `0.202.0` binary via `FIBER_CKB_BIN`; `scripts/fiber_local_network.sh` rejects another version. The wrapper also forces `localhost`, `127.0.0.1`, and `::1` into `NO_PROXY`/`no_proxy`, because Fiber's CKB SDK uses `http://localhost:8114` and otherwise inherits shell proxy settings.

## Reference docs

`docs/architecture.md`, `docs/canonical-core.md`, `docs/conformance-vectors.md`, `docs/f402-compatibility.md`, `docs/x402-compatibility.md`, `docs/fiber-method.md`, `docs/fiber-rpc.md`, `docs/fiber-local-e2e.md`, `docs/fiber-local-network.md`, `docs/hackathon-submission.md`, `docs/positioning.md`, `docs/production-readiness.md`, `docs/protocol.md`, `docs/rust-architecture.md`, `docs/rust-conformance.md`, `docs/rust-fiber-rpc.md`, `docs/security-matrix.md`, `docs/security.md`, and `docs/refs/{fiber,infern,l402,mpp,security}.md`.

## Memory hints

If you discover new commands (build/test/lint/deploy), style preferences, or gotchas, append them here. Current gates assume `pnpm@10.12.1`, Node 24 (`@types/node ^24`), TypeScript ^5.8, vitest ^3.2, Rust toolchain at `$HOME/.cargo/bin/cargo`, and an external Fiber repo at `${FIBER_REPO:-../fiber}`.
