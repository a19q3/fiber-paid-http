# Production Readiness

## Current status

FiberMPP uses Rust as the canonical protocol core and verifier target. TypeScript remains a maintained JS ecosystem integration layer for SDKs, demos, examples, F402/MPP compatibility, mock mode, and vector tooling. The project has mock flow, local Fiber E2E evidence, shared conformance vectors, a security matrix, and canonical parity gates.

It is still not production-ready for live Fiber settlement. The Rust `fiber-mpp-server` crate is currently a visible HTTP 402 gateway prototype; challenge issuance, durable storage, method adapter wiring, and production gateway behavior are not feature-complete there.

## Ready

- Typed MPP protocol model.
- Canonical HMAC challenge and receipt signing.
- TypeScript route middleware and reverse proxy mode.
- Replay protection.
- Resource/method/amount binding tests.
- Explicit mock-vs-live settlement status.
- F402 compatibility adapter.
- TypeScript CLI and Rust `fiber-mpp-rs` CLI.
- Local Fiber E2E evidence from the 3-node network.
- Rust canonical vector verification with TypeScript harness parity.
- Rust HTTP gateway prototype returns visible `402 Payment Required` responses.

## Blockers before live production

- Add separate testnet Fiber E2E evidence.
- Complete Rust HTTP gateway challenge issuance, storage, method adapter wiring, and receipt issuance before treating Rust server paths as production.
- Complete operational hardening.
- Complete long-running deployment hardening.
- Configure Fiber RPC auth and trusted network binding.
- Decide operational handling for paid-but-denied cases such as handler crashes after redemption.
- Add structured redaction for production logs when integrating with a real logger.

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
