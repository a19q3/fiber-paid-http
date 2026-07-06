# Documentation Index

This index maps the repo documentation by reader intent. Start with the shortest path that matches what you need; most docs are deliberately narrow.

## New Here

- [`../README.md`](../README.md): project story, architecture diagrams, quick start, and ecosystem positioning.
- [`architecture.md`](architecture.md): package/crate layout and request flow.
- [`positioning.md`](positioning.md): project boundary against nearby Fiber, F402, L402, x402, wallet, checkout, and marketplace work.
- [`service-metering.md`](service-metering.md): why paid APIs, agents, and merchant resources need a reusable service-metering layer on Fiber.
- [`hackathon-submission.md`](hackathon-submission.md): current hackathon submission packet and final checklist.

## Building A Paid Resource

- [`protocol.md`](protocol.md): challenge, credential, receipt, and replay model.
- [`bootstrap.md`](bootstrap.md): gateway config, secrets, storage, doctor checks, and operational bootstrap.
- [`security.md`](security.md): implemented security checks.
- [`security-matrix.md`](security-matrix.md): attack vector to test/vector mapping.
- [`f402-compatibility.md`](f402-compatibility.md): F402 and F-L402 compatibility model.

## Running Evidence

- [`conformance-vectors.md`](conformance-vectors.md): deterministic fixtures and live-Fiber evidence vector rules.
- [`fiber-local-network.md`](fiber-local-network.md): reproducible local three-node Fiber network.
- [`fiber-local-e2e.md`](fiber-local-e2e.md): local live payment test lane.
- [`fiber-testnet-e2e.md`](fiber-testnet-e2e.md): funded testnet payer/payee evidence path.
- [`fiber-local-network.md`](fiber-local-network.md): local xUDT route setup for tournament-style demos.

## Production And Operations

- [`production-readiness.md`](production-readiness.md): readiness definition and gate expectations.
- [`production-operations.md`](production-operations.md): alerting, trusted RPC binding, Fiber node backup, gateway storage backup, and paid-but-denied reconciliation.
- [`fiber-client-wallet-integration-plan.md`](fiber-client-wallet-integration-plan.md): payer/client/wallet boundary and non-goals.
- [`rust-migration-plan.md`](rust-migration-plan.md): Rust production-boundary migration notes.

## Rust Engine

- [`canonical-core.md`](canonical-core.md): canonical verification boundary.
- [`rust-architecture.md`](rust-architecture.md): Rust crate responsibilities.
- [`rust-conformance.md`](rust-conformance.md): Rust vector verification and parity.
- [`rust-fiber-rpc.md`](rust-fiber-rpc.md): Fiber JSON-RPC method semantics.

## Demos And Design Records

- [`battlecode-paid-http-tournament.md`](battlecode-paid-http-tournament.md): paid-entry xUDT tournament demo flow.
- [`evidence-console-frontend-plan.md`](evidence-console-frontend-plan.md): archived design plan for the evidence console.
- [`evidence-console-redesign-plan.md`](evidence-console-redesign-plan.md): archived redesign plan for the evidence console shell.

## External References

- [`refs/README.md`](refs/README.md): reference index for Fiber, MPP, F402, L402, Infern, and security sources.
- [`refs/fiber.md`](refs/fiber.md), [`refs/mpp.md`](refs/mpp.md), [`refs/l402.md`](refs/l402.md), [`refs/infern.md`](refs/infern.md), [`refs/security.md`](refs/security.md): short source notes.
