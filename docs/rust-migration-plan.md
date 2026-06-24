# Rust Migration Plan

The Rust primary stack now exists under `crates/`. This plan tracks the remaining migration hardening work rather than authorizing divergence from TypeScript.

## Oracle Boundary

Rust and TypeScript must continue to match for:

- canonical JSON hashing,
- signed challenge verification,
- resource hashing,
- `Authorization: Payment` credential verification,
- F402 challenge/proof conversion,
- `Payment-Receipt` signing and verification,
- replay, wrong-resource, wrong-amount, wrong-method, expired-challenge, and tampered-receipt rejection codes,
- local Fiber E2E evidence fields copied into gate reports.

## Completed In This Stage

- Rust workspace and `fiber-mpp-rs` CLI.
- Rust vector verifier against the shared `test-vectors/` suite.
- Rust Fiber RPC method/quantity/status parity surface.
- Rust gate and canonical parity gate.
- TypeScript preserved as maintained SDK/demo/F402 compatibility/vector harness.

## Remaining Migration Steps

1. Keep both conformance reports green.
2. Expand the Rust HTTP gateway beyond config inspection only when route ownership is defined.
3. Run Rust against the same local Fiber network from `docs/fiber-local-network.md`.
4. Add separate testnet Fiber E2E evidence.
5. Complete operational hardening for long-running production deployment.

## Readiness Rule

`production_ready_for_fiber_method` remains `false` after local E2E alone. It can only change after separate testnet Fiber E2E evidence and operational hardening are complete.
