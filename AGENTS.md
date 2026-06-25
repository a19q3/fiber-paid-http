# AGENTS.md — FiberMPP

FiberMPP is a **dual-stack** Fiber payment method for the Machine Payments Protocol (MPP) with F402 compatibility. It is a TypeScript pnpm workspace (`packages/*`, `apps/*`) **plus** a Rust Cargo workspace (`crates/*`). Rust is the production canonical engine; TypeScript is SDK/demo/F402-compat/vector tooling.

## Quick start

```bash
pnpm install
pnpm build
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-mpp init --role gateway --out fiber-mpp.gateway.json
pnpm exec fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json
pnpm --filter @fiber-mpp/demo-api start        # evidence API on :8787
# in another shell:
pnpm --filter @fiber-mpp/demo-web start        # static evidence console on :8788
```

Fiber payment execution requires `FIBER_MODE=local` or `FIBER_MODE=testnet` plus real payer/payee Fiber RPC endpoints. Without those variables, `pnpm test:fiber` runs the visible preflight and reports skipped blockers.

## Workspace layout

| Path | Role |
| --- | --- |
| `packages/core` | Canonical JSON, HMAC-SHA256 signing, base64url, zod protocol types, HTTP header helpers (`PAYMENT_AUTH_SCHEME`, `PAYMENT_RECEIPT_HEADER`). Single source of truth for the data model. |
| `packages/storage` | `FiberMppStore` interface + `InMemoryStore`, `SqliteStore` (uses Node 24 `node:sqlite`). |
| `packages/fiber-method` | `FiberRpcClient` (JSON-RPC over fetch) and `FiberMethodAdapter` (local / testnet). Includes `createChallenge`, `payChallenge`, `waitForFiberInvoicePaid`. |
| `packages/server-middleware` | `createFiberMppMiddleware`, `createReverseProxyHandler`, `PaidRouteConfig`. Throws if `secret.length < 16`. |
| `packages/f402-compat` | `f402ChallengeToMpp`, `f402ProofToCredential`. |
| `packages/client` | `paidFetch`, `inspectChallenge`. |
| `packages/cli` | The `fiber-mpp` command (commander). Vectors live in `packages/cli/src/vectors.ts`. |
| `apps/demo-api` | Hono app exposing `/paid/*` plus evidence console JSON APIs. |
| `apps/demo-web` | Static HTML served by `server.mjs`. |
| `examples/{paid-api,paid-mcp-tool}` | README-only (no source yet). |
| `crates/fiber-mpp-core` | Rust canonical engine: `canonical_json`, `verify_vectors_dir`, `verify_receipt`, `decode_receipt_token`, all vector case verifiers. |
| `crates/fiber-mpp-storage` | Rust `MemoryStore` + `SqliteStore` (rusqlite). |
| `crates/fiber-mpp-fiber` | Fiber RPC param builders + `live_proven_semantics()` (new_invoice, send_payment, get_payment, get_invoice). |
| `crates/fiber-mpp-f402` | F402 proof → credential conversion, `canonical_equal`. |
| `crates/fiber-mpp-server` | axum-based gateway with 402 + `Cache-Control: no-store`. |
| `crates/fiber-mpp-cli` | `fiber-mpp-rs` binary: `vectors verify`, `receipt verify`, `challenge inspect`, `doctor`, `server --config`. |
| `test-vectors/` | Shared protocol truth — 14 vectors (challenge, credential, receipt, f402, resource hash, attack vectors, fiber local-e2e evidence). Both engines must agree byte-for-byte on canonical hash + result + error code. |

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
pnpm gate                          # bash scripts/fiber_mpp_gate.sh (writes reports/fiber-mpp-gate.json)
pnpm demo:api                      # @fiber-mpp/demo-api start
pnpm demo:web                      # @fiber-mpp/demo-web start
pnpm exec fiber-mpp vectors verify # TS vector harness (writes reports/ts-conformance.json)
pnpm exec fiber-mpp vectors generate
```

### Rust (root)
```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p fiber-mpp-cli -- vectors verify      # writes reports/rust-conformance.json
cargo run -p fiber-mpp-cli -- receipt verify <file> --secret <secret>
cargo run -p fiber-mpp-cli -- challenge inspect <file>
cargo run -p fiber-mpp-cli -- doctor
bash scripts/fiber_mpp_rust_gate.sh              # writes reports/fiber-mpp-rust-gate.json
bash scripts/fiber_mpp_canonical_gate.sh         # writes reports/canonical-core-parity.json
                                   # asserts TS↔Rust parity on 14 vectors + receipt/f402 + RPC semantics
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
The gate (`scripts/fiber_mpp_gate.sh`) runs all of the above and additionally **regression-guards** that `pnpm test:fiber` actually loads `fiber-preflight.test.ts` (failure → `fiber_e2e_status="failed"`). Reports land in `reports/`.

## Architecture and control flow

```
client  ─HTTP─▶  middleware.protect(route)  ─▶  fiber.createChallenge  ─▶  402 + WWW-Authenticate: Payment
                                                    ▲
                                                    │ FiberMethodAdapter
                                                    │ (local | testnet)
client  ─replay─▶ middleware.verifyCredential ─▶  store.hasCredentialUse ─▶  200 + Payment-Receipt
                         │             │
                         │             └─ checks: signature, expiresAt, resourceHash,
                         │                method binding, paymentHash, amountShannons,
                         │                proof.kind=fiber-payment-proof-v1, status=settled,
                         │                replay (single-use)
                         └─ asserts fiberRpcSemantics parity on (new_invoice, send_payment,
                            get_payment, get_invoice) with hex JSON quantities,
                            payment status "Success", invoice status "Paid"
```

Both Rust (`crates/fiber-mpp-core`) and TypeScript (`packages/core`) implement the same canonicalization (recursive key sort, `undefined` stripped). Every test vector records the expected canonical SHA-256, expected accept/reject, and expected error code — both engines must match all three.

## Protocol invariants

- **Canonical JSON**: keys sorted recursively, `undefined` stripped, no trailing whitespace, no `BigInt`.
- **Signing**: HMAC-SHA256 over canonical JSON, hex-encoded, compared with `timingSafeEqual`. Rust uses the `hmac` crate, TS uses `node:crypto`.
- **Resource hash**: `sha256(canonicalJson({method, url, bodyHash?, contentType?}))`. `bodyHash` required for non-GET/HEAD.
- **Replay**: challenge `maxUses=1`, credential-hash single-use in store. Replay → 402.
- **Receipt token format**: Rust uses prefix `fiber-mpp-receipt-v1.` + URL-safe base64; TS uses raw base64url-encoded JSON. Both decode to the same schema (`PaymentReceiptSchema`).
- **Fiber RPC encoding**: integers sent as `"0x..."` hex strings (not decimal). Settlement poll status strings: payment `Success`, invoice `Paid`.
- **No offline payment execution mode**: `FiberMethodAdapter.fromEnv` only accepts `FIBER_MODE=local` or `FIBER_MODE=testnet` and requires real Fiber RPC endpoints.

## Naming and style

- TypeScript: `strict`, `noUncheckedIndexedAccess`, ES2022 + `NodeNext`, `*.js` import suffixes required. Public APIs use `public`/`public readonly` explicit modifiers. `FiberMppError` carries `code` + `status`. Schemas from `zod` are the canonical types — use `z.infer<...>` aliases.
- Rust: `edition 2021`, `thiserror` for errors, `serde_json::Value` for dynamic vector inputs, `BTreeMap` for deterministic ordering. `Outcome { result, error_code }` is the verifier return type.
- Tests: vitest. `describe("core protocol primitives", ...)` style. Live Fiber test is gated on `RUN_FIBER_E2E=1` + `FIBER_MODE ∈ {local, testnet}` + both payee/payer RPC URLs (see `tests/integration/fiber-e2e-env.ts`).

## Gotchas and non-obvious rules

1. **TypeScript CLI refuses non-TS engine**: `fiber-mpp --engine <anything else>` throws — the only way to run the Rust CLI from Node is to call `fiber-mpp-rs` directly. Don't add fallback that silently downgrades.
2. **vitest aliases are hardcoded absolute paths** in `vitest.unit.config.ts` — they pin to `/home/arthur/a19q3/fiber-mpp/...`. If the repo moves, edit those aliases. `tsconfig.base.json` `paths` must mirror them.
3. **`pnpm test:integration` excludes the preflight + live E2E tests.** Those run only via `pnpm test:fiber`. The integration config excludes `FIBER_PREFLIGHT_TEST_FILE` and `FIBER_LIVE_TEST_FILE` explicitly; `pnpm test` and `pnpm test:integration` will never touch live RPC.
4. **`vitest.fiber.config.ts` reads env at config load time.** Set `RUN_FIBER_E2E=1` + Fiber env vars before invoking vitest, or preflight-only runs.
5. **`scripts/bin/cargo` and `scripts/bin/nc` are toolchain shims** auto-prepended to `PATH` inside `scripts/fiber_local_network.sh`. They are NOT used elsewhere. The cargo shim only mutates args when running inside the external Fiber repo (`FIBER_REPO`); the nc shim only supports `nc -z HOST PORT` (matches what Fiber's `tests/nodes/wait.sh` calls).
6. **`reports/fiber-e2e-result.json` is the live E2E status file** (see `tests/integration/fiber-e2e-env.ts`). The gate reads this directly, but also has log-grep guards: if `pnpm test:fiber` output contains "No test files found" OR lacks `fiber-preflight.test.ts`, the gate marks Fiber E2E as **failed** regardless of exit code.
7. **Gate reports mutate each other across runs.** `scripts/fiber_mpp_gate.sh` reads `reports/fiber-mpp-gate.json` from previous runs to preserve `live_fiber_local_e2e` evidence. Deleting `reports/` entirely loses the production-blocker downgrade history.
8. **In-memory store is refused in production.** `createFiberMppMiddleware({production: true})` calls `assertProductionStore` and throws unless `allowInMemoryStore: true` OR `ALLOW_IN_MEMORY_STORE=1` OR a non-`memory://` storage URI is supplied. `fiber-mpp serve` defaults to `memory://` storage; pass `--storage sqlite://./fiber-mpp.sqlite` for anything real.
9. **Secret length floor.** Middleware requires `secret.length >= 16`; default demo secrets all match this (`"fiber-mpp-demo-secret-at-least-16"`, `"fiber-mpp-conformance-secret"`, `"fiber-mpp-live-e2e-secret-at-least-16"`).
10. **`apps/demo-api/src/index.ts` reads reports from `reports/`** (canonical-core-parity, fiber-local-e2e-evidence, gate.*). The evidence console only shows real status when these exist; otherwise it renders `static-evidence` mode and `node*.status: "unconfigured"`.
11. **`production_ready_for_fiber_method` is hard-coded `false`** in every gate report. The remaining production blocker is separate testnet Fiber E2E evidence. Production operations evidence is gate-checked by `scripts/fiber_mpp_ops_gate.sh` and reported in `reports/production-operations-matrix.json`; don't set readiness to `true` without testnet evidence.
12. **TypeScript is NOT a trusted verifier.** `typescript_trusted_boundary: false` is asserted in the canonical parity gate. Any new verifier MUST be in Rust.
13. **Vector parity is exact**: `canonical_hash`, `actual` (Accepted/Rejected), `actual_error_code`, and `passed` must all match across both engines per `crates/fiber-mpp-core/src/lib.rs:compare_reports`. Adding a new vector requires updating both `packages/cli/src/vectors.ts` (`verifyVectorInput` case) and `crates/fiber-mpp-core/src/lib.rs` (`verify_vector_input` case).
14. **`apps/demo-web` is a static `index.html`** with stub scripts — no React/Vite build. `pnpm --filter @fiber-mpp/demo-web build/lint/typecheck` are no-op `console.log` stubs.
15. **`node_modules/` is committed-adjacent only via lockfile**; `.gitignore` excludes `node_modules/`, `dist/`, `target/`, `.tmp/`, `*.db`, `*.sqlite`, `reports/fiber-local-network/*.pid`, `reports/fiber-local-network/*.log`. Reports themselves are committed.
16. **CI gate (`scripts/fiber_mpp_gate.sh`) fails on Fiber E2E "failed" status** via the final `node -e '... process.exit(...)'` check. Even if everything else passes, a `fiber_e2e_status === "failed"` exits non-zero.

## Reference docs

`docs/architecture.md`, `docs/canonical-core.md`, `docs/conformance-vectors.md`, `docs/f402-compatibility.md`, `docs/fiber-rpc.md`, `docs/fiber-local-e2e.md`, `docs/fiber-local-network.md`, `docs/hackathon-submission.md`, `docs/positioning.md`, `docs/production-readiness.md`, `docs/protocol.md`, `docs/rust-architecture.md`, `docs/rust-conformance.md`, `docs/rust-fiber-rpc.md`, `docs/rust-migration-plan.md`, `docs/security-matrix.md`, `docs/security.md`, and `docs/refs/{fiber,infern,l402,mpp,security}.md` (the latter generated by `fiber-mpp refs init`).

## Memory hints

If you discover new commands (build/test/lint/deploy), style preferences, or gotchas, append them here. Current gates assume `pnpm@10.12.1`, Node 24 (`@types/node ^24`), TypeScript ^5.8, vitest ^3.2, Rust toolchain at `/home/arthur/.cargo/bin/cargo`, and an external Fiber repo at `/home/arthur/a19q3/fiber` (override with `FIBER_REPO`).
