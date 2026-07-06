# Positioning

Fiber Paid HTTP is a paid-HTTP protocol-family implementation for Fiber. The repo and CLI names stay stable, while the product surface is broader than one protocol acronym:

```text
Rust       = canonical protocol core, vector verifier, and production gateway path
TypeScript = SDK, middleware, compatibility adapters, demos, evidence console, vector tooling
test-vectors = shared protocol truth across Rust and TypeScript
```

## Protocol Family

| Surface | Implementation | Boundary |
| --- | --- | --- |
| MPP + Fiber | `packages/core`, `packages/server-middleware`, `crates/fiber-paid-http-core`, `crates/fiber-paid-http-server` | Primary paid HTTP envelope and receipt format. |
| F402 | `packages/f402-compat`, `crates/fiber-paid-http-f402` | Compatibility conversion for Fiber invoice/payment-hash 402 applications. |
| F-L402 | `packages/fl402-compat`, `crates/fiber-paid-http-fl402`, TS middleware, Rust gateway | Application-level `L402 macaroon:preimage` adapter backed by Fiber invoice settlement. |
| x402 | Future adapter | Wait for stable Fiber node verify/settle support before adding native x402 headers. |

## Nearby Projects

- Infern: an AI model compute marketplace using F402 over Fiber.
- fiber-pay: AI-friendly CLI and payment UX for Fiber.
- fiber-l402: application-level Fiber L402 precedent.
- fiber-x402-blog: native x402 direction once Fiber node support is available.
- Fiber-checkout: React checkout/payment component.
- Fiber Paid HTTP: reusable paid HTTP infrastructure for APIs, agents, and metered services.

## Boundary

Fiber Paid HTTP should serve Infern-like projects and other paid API developers. It should not duplicate their product surfaces. It does not provide model discovery, inference routing, wallet UX, checkout UX, slashing, staking, or a marketplace.

The TypeScript stack is maintained integration code, but it is not the production trusted verifier. Trusted verification flows go through Rust. TypeScript remains valuable as the JS ecosystem layer, middleware surface, compatibility adapter layer, evidence console, and historical conformance-vector harness.

The Rust HTTP server now issues signed challenges, stores replay/receipt state, verifies Fiber settlement, and accepts optional F-L402 `Authorization: L402` retries. It is still deliberately scoped as a paid HTTP gateway, not a wallet, checkout product, Fiber node dashboard, or x402 node implementation.
