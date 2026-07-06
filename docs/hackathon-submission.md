# Hackathon Submission

This document is the working submission packet for the Gone in 60ms Fiber Network Infrastructure Hackathon. It is intentionally explicit about what is working, what is evidence-backed, and what still needs an external URL before final CKBoost submission.

## Submission Fields

| Field | Value |
| --- | --- |
| Project name | Fiber Paid HTTP |
| Selected category | Merchant, Liquidity, LSP, and Multi-Asset Infrastructure |
| Repository | TODO: public GitHub URL after the private repo is opened |
| Hosted demo | TODO: public Evidence Console URL |
| Video demonstration | TODO: unlisted video URL |
| Team members | TODO: final submitter/team roster |
| AI allowance claim | Optional. If claimed, state that AI assisted research/docs/code review while implementation was validated by the committed gates and human review. |

## Project Summary

Fiber Paid HTTP is Rust-first paid-HTTP infrastructure for metered APIs, agents, and service access on Fiber. It turns HTTP `402 Payment Required` into a reusable Fiber settlement flow: issue a resource-bound challenge, settle a Fiber invoice, retry with `Authorization: Payment`, verify settlement and replay state, serve the protected resource once, and return a signed `Payment-Receipt`.

MPP + Fiber is the primary envelope. F402 and F-L402 are compatibility adapters over the same settlement, replay, and receipt verifier. The project is deliberately infrastructure: it is not a wallet, checkout product, marketplace, or Fiber node dashboard.

## Infrastructure Gap Addressed

Fiber can move value quickly, but external developers still need boring service-metering infrastructure for API access, subscriptions, agents, micropayments, and merchant-style resource delivery. Fiber Paid HTTP fills that gap with:

- route middleware and a Rust gateway;
- canonical JSON, signing, resource hashing, receipts, and replay protection;
- Fiber JSON-RPC settlement checks for local and testnet payer/payee nodes;
- SDK and CLI tooling for developers;
- F402 and F-L402 compatibility adapters;
- shared TypeScript/Rust conformance vectors;
- evidence reports that make the trusted boundary auditable.

See `docs/service-metering.md` for the category-specific rationale.

## Fully Working

- MPP-style `402` challenge issuance.
- `WWW-Authenticate: Payment`.
- `Authorization: Payment` retry.
- `Payment-Receipt` issuance and verification.
- Optional `WWW-Authenticate: L402` challenge issuance.
- Optional `Authorization: L402 macaroon:preimage` retry in TypeScript middleware and Rust gateway.
- F402 proof-to-credential conversion.
- F-L402 TypeScript and Rust adapters.
- Local Fiber E2E payment flow.
- Testnet Fiber E2E evidence snapshot.
- Rust canonical verifier and Rust axum gateway path.
- Route middleware and reverse proxy helper.
- Client helper.
- Role-aware `doctor` checks for Fiber RPC, peers, and `ChannelReady` channels.
- Evidence API and Evidence Console.
- Security tests for replay, wrong resource, wrong method, wrong amount, expiry, no-store, bad signatures, wrong F-L402 preimage, and tampered F-L402 macaroon.
- 16 deterministic conformance vectors plus 2 live-Fiber evidence fixtures, tracked as 18 shared vector files.

## Evidence Artifacts

The strongest evidence files for judges are:

| Artifact | Why it matters |
| --- | --- |
| `reports/canonical-core-parity.json` | Rust canonical engine, TypeScript harness parity, 18 shared vector files, receipt/F402/F-L402 parity, RPC semantics parity. |
| `reports/fiber-paid-http-rust-gate.json` | Rust trusted boundary: fmt, clippy, tests, vectors, gateway features, production path evidence. |
| `reports/fiber-testnet-e2e-evidence.json` | Preserved testnet Fiber payment evidence with payment hash, receipt id, Fiber commit, digest, and no blockers. |
| `reports/production-bootstrap-e2e.json` | Production-like gateway bootstrap: unpaid `402`, paid `200`, receipt signature valid, SQLite WAL/integrity checks. |
| `reports/security-matrix.json` | Attack-to-check mapping for replay, wrong resource, wrong amount, wrong method, expired challenge, tampered receipt, and F-L402 attacks. |
| `reports/evidence-console-browser-smoke.json` | Browser flow smoke evidence for challenge, payment, receipt, replay rejection, and served web origin. |

The default gate can show `fiber_e2e_status: "skipped"` when live Fiber env vars are not set locally. That is expected. Testnet evidence is preserved separately in `reports/fiber-testnet-e2e-evidence.json` and should be refreshed before final submission if funded testnet nodes are available.

## Demo Path For Judges

Local evidence-console demo:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm evidence:api
```

In another shell:

```bash
pnpm evidence:web
```

Open the Evidence Console, run the Flow workspace, and demonstrate:

1. unpaid request returns `402`;
2. Fiber payment/proof step completes;
3. authorization retry returns a signed receipt;
4. replay of the same credential is rejected;
5. Evidence workspace shows parity, reports, and attack coverage.

Live Fiber local demo:

```bash
scripts/fiber_local_network.sh up

RUN_FIBER_E2E=1 \
FIBER_MODE=local \
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 \
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 \
FIBER_CURRENCY=Fibd \
FIBER_E2E_AMOUNT_SHANNONS=100 \
FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)" \
pnpm test:fiber
```

Testnet demo requires two funded Fiber testnet nodes with connected peers and at least one `ChannelReady` route from payer to payee. See `docs/fiber-testnet-e2e.md`.

## Video Demo Script

Target length: 5-8 minutes.

1. Problem and positioning: HTTP `402` plus Fiber, reusable infrastructure, not a wallet or marketplace.
2. Protocol flow: challenge, Fiber payment, authorization retry, receipt, replay rejection.
3. Evidence Console flow: unpaid request, pay, retry, replay.
4. Evidence view: canonical parity, testnet evidence, production bootstrap, security matrix.
5. Category fit: service-metering infrastructure for pay-as-you-go APIs, agents, and merchant resources.
6. Roadmap: durable stores, stronger paid-but-denied handling, x402 boundary, wallet/client integrations.

Do not use historical reports such as `reports/console-theatre-audit.md` as current demo evidence; they are archived audits from a pre-rename topology.

## Technical Breakdown

Rust is the production trusted boundary. `crates/fiber-paid-http-core` owns canonical verification and vector checks. `crates/fiber-paid-http-server` provides the axum gateway path with signed challenge issuance, Fiber settlement inspection, SQLite-backed replay/receipt storage, `Payment-Receipt` issuance, and replay rejection.

TypeScript is the integration and evidence layer: SDK, route middleware, CLI, vector generation, F402/F-L402 adapters, evidence API, and evidence console. TypeScript remains maintained and tested, but `typescript_trusted_boundary: false` is asserted by the canonical parity gate.

The shared data model is enforced by canonical JSON, HMAC-SHA256 signing, resource hashes, explicit amount/payment-hash binding, and single-use credential storage.

## What Is Local-Only Or Simulated

- The Evidence Console can run against a local temporary API for browser smoke tests when live Fiber env vars are absent.
- Live payment execution is not simulated by the production path. `FiberMethodAdapter.fromEnv` only accepts `FIBER_MODE=local` or `FIBER_MODE=testnet` with real Fiber RPC endpoints.
- Battlecode tournament awards default to a local claimable xUDT award ledger unless `BATTLECODE_AWARD_SETTLEMENT=fiber-xudt` is explicitly enabled with live Fiber xUDT channels.
- Native x402 is a future adapter boundary until Fiber-native verify/settle support is stable enough to keep the verifier honest.

## Roadmap

- Public hosted demo with a read-only Evidence Console and downloadable reports.
- Fresh deadline-week testnet Fiber E2E evidence with current Fiber commit and runner environment metadata.
- Redis-compatible or Postgres-compatible production store for horizontally scaled gateways.
- Stronger paid-but-denied incident tooling around commercial refunds, replacement challenges, and delivery outcome exports.
- Native x402 adapter once Fiber node verify/settle APIs are stable.
- Payer-side integrations through Fiber clients, browser WASM, or `fiber-pay` without moving wallet custody into Fiber Paid HTTP.
- More runnable examples beyond the current README-only skeletons.

## Final Submission Checklist

- [ ] Public GitHub repository URL.
- [ ] Root `LICENSE` included.
- [ ] Team member roster filled.
- [ ] Hosted demo URL filled.
- [ ] Video URL filled.
- [ ] Fresh gate reports or clear note that preserved testnet evidence is from 2026-06-25.
- [ ] README links to this submission packet.
- [ ] CKBoost form mirrors the "what is working / what is local-only or simulated" boundary above.
