# Positioning

FiberMPP is an MPP/F402 infrastructure layer for paid HTTP APIs that want Fiber as an MPP payment method.

```text
Rust       = canonical protocol core and verifier target
TypeScript = SDK, demos, examples, F402/MPP JS integration, vector tooling
test-vectors = shared protocol truth
```

## Nearby projects

- Infern: an AI model compute marketplace using F402 over Fiber.
- fiber-pay: AI-friendly CLI and payment UX for Fiber.
- fiber-l402: Fiber L402 / paid HTTP access precedent.
- Fiber-checkout: React checkout/payment component.
- FiberMPP: protocol and middleware infrastructure: Fiber as an MPP payment method plus F402 compatibility.

## Boundary

FiberMPP should serve Infern-like projects. It should not duplicate their product surfaces. It does not provide model discovery, inference routing, wallet UX, checkout UX, slashing, staking, or a marketplace.

The TypeScript stack is not throwaway demo code, but it is also not a production verifier. Future trusted verification flows go through Rust. TypeScript remains valuable as the JS ecosystem layer and historical conformance-vector harness. The current Rust HTTP server is still a gateway prototype until signed challenge issuance, durable storage, Fiber adapter calls, and receipt issuance are implemented there.
