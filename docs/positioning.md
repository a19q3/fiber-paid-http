# Positioning

> Turn Fiber settlement into replay-safe HTTP delivery.

Fiber Paid HTTP is a Rust-first paid HTTP gateway and proposed Fiber payment-method toolkit. Its primary users are API developers and service operators who need to charge for an HTTP resource without rebuilding request binding, settlement verification, replay storage, delivery accounting, and receipts. Judges and security auditors use the Gateway Lab to inspect the same boundary. Machines, robots, and agents use the HTTP contract and SDKs rather than the GUI.

The product is the **server-side enforcement layer**, not the payment rail or an end-user application.

| Layer | Role |
| --- | --- |
| MPP | External HTTP challenge, credential, and receipt contract |
| Proposed `fiber` method profile | Invoice creation, payment execution, and settlement evidence |
| Rust gateway | Trusted binding, settlement, replay, delivery, and receipt verifier |
| TypeScript | Client SDK, Gateway Lab, adapters, vectors |
| F402 / F-L402 | Optional ingress mappings into the MPP-draft verifier; F-L402 is experimental and disabled by default |
| x402 v2 | Independent `exact`/Fiber format converter using official HTTP codecs; not a facilitator or settlement path |

MPP and x402 are not presented as one canonical protocol. The current MPP draft is the primary wire contract. x402 v2 and F402 are explicit ingress adapters into the same Rust enforcement lifecycle; F-L402 remains experimental and disabled by default. `fiber` is a proposed project method profile, not a claimed registered or upstream-adopted method.

## Ecosystem boundary

| Project or layer | Owns | Fiber Paid HTTP relationship |
| --- | --- | --- |
| Fiber Network Node (FNN) | Channels, routing, invoices, and off-chain settlement | Required payment rail; the gateway verifies its RPC settlement evidence |
| `fiber-pay` | Node/payment lifecycle, CLI/SDK, payer and browser tooling | Optional payer or operations connector; never part of the trusted gateway verifier |
| Fiber x402 backend/facilitator work | x402 facilitation and network-facing settlement services | Complementary; this project only converts supported x402 v2 input at its own ingress |
| FiberLatch | Application-specific signed access receipts | Separate vertical service; not replaced or reimplemented here |
| Infern | AI marketplace and F402 application policy | Example upstream/application that can reuse the gateway boundary |
| Fiber L402/x402 demos | Paywall examples | Compatibility and integration references, not the production verifier |
| Battlecode reference integration | Paid entry and prize demonstration | Example protected service; not the product or a participant platform |

## Non-goals

The project does not define a competing paid-HTTP envelope. It is not a Fiber node dashboard, wallet, checkout, custody service, marketplace, liquidity router, x402 facilitator, or Battlecode platform. It does not move payer authorization into the gateway and does not put `fiber-pay` or TypeScript inside the trusted verifier.

The integration pitch is:

> Protect an HTTP route, settle through Fiber, consume the credential once, and issue a receipt only after successful delivery.

## Evidence language

The Gateway Lab uses evidence labels as claims with defined sources:

| Label | Meaning |
| --- | --- |
| `LIVE` | The current API process reports a configured live Fiber runtime and the evidence belongs to the current session |
| `PRESERVED EVIDENCE` | A committed report verifies a prior run; it is not represented as current live execution |
| `STATIC DEMO` | A deterministic fixture or in-process adapter demonstrates UI and protocol behavior without real Fiber settlement |
| `BLOCKED` | A required runtime, artifact, or configuration is absent or failed |
| `EXPERIMENTAL` | An explicit opt-in surface, such as F-L402, that is disabled by default and does not imply production readiness |

Unknown and loading states are never promoted to ready. Battlecode capabilities are read from `/api/tournament/battlecode/status`; canonical and production claims are read from the report-backed status API.
