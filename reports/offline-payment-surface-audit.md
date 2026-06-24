# Offline Payment Surface Audit

Date: 2026-06-25

Scope:

- product docs: `README.md`, `docs/`, `examples/`, `AGENTS.md`
- runtime source: `apps/`, `packages/`, `crates/`, `scripts/`
- tests that guard product behavior
- ignored generated package remnants under `packages/`

## Result

The product/source surface no longer contains the legacy offline payment adapter keyword (`m-o-c-k`) or examples that imply a no-RPC Fiber payment path.

Remaining matches outside the scanned surface are not runtime implementations:

- `pnpm-lock.yaml`: Vitest dependency package name.
- `reports/console-theatre-audit.md`: historical audit report preserved as source evidence.
- `reports/fiber-local-network/start.log`: external Fiber/CKB build log dependency name.

## Fixes

- Removed ignored generated remnants under `packages/stripe-method/` and `packages/tempo-method/`.
- Rewrote `examples/paid-api/README.md` to use `FiberMethodAdapter.fromEnv(process.env, "payee")`, SQLite storage, and CKB pricing.
- Rewrote `examples/paid-mcp-tool/README.md` to use CKB pricing.
- Updated `AGENTS.md` to describe only local/testnet Fiber RPC execution.
- Added `tests/unit/no-offline-payment-surface.test.ts` so product/source surfaces fail unit tests if the legacy keyword returns.

## Guardrail

Run:

```bash
pnpm test
```

The unit suite now scans the product/source surface and blocks reintroduction of offline payment adapter language. It intentionally excludes reports, lockfiles, dependencies, build outputs, and external Fiber local-network logs.
