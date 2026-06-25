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
- Rust HTTP gateway production path: signed 402 challenges, FNN invoice creation, FNN settlement inspection, durable SQLite challenge/credential/receipt storage, `Authorization: Payment` verification, `Payment-Receipt` issuance, and replay rejection.
- `fiber-mpp-rs server --config` now starts the Rust gateway instead of only inspecting config.
- Rust gate and canonical parity gate.
- TypeScript preserved as maintained SDK/demo/F402 compatibility/vector harness.

## Remaining Migration Steps

1. Keep both conformance reports green.
2. Run Rust against the same local Fiber network from `docs/fiber-local-network.md`.
3. Keep separate testnet Fiber E2E evidence green.

## Readiness Rule

`production_ready_for_fiber_method` remains `false` after local E2E alone. It can be `true` only while separate testnet Fiber E2E evidence and production operations gates are both present.
