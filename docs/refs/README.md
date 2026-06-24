# FiberMPP Reference Index

This index records the external sources inspected before implementation. Reference notes live under `docs/refs` only. External repositories are cloned read-only under `/home/arthur/a19q3`.

## mpp.dev

- URL: https://mpp.dev/
- Local repo path: none
- Why it matters: public protocol home for Machine Payments Protocol.
- FiberMPP behavior learned: MPP is for charging API requests, tool calls, and content in the same HTTP flow. Fiber can be introduced as a custom payment method.
- What not to copy: do not duplicate the whole MPP SDK surface. FiberMPP implements only the pieces needed for Fiber and local demos.

## Cloudflare Agents MPP overview

- URL: https://developers.cloudflare.com/agents/tools/payments/mpp/
- Local repo path: none
- Why it matters: clear summary of the 402 lifecycle: request, `WWW-Authenticate: Payment`, payment, retry with `Authorization: Payment`, response with `Payment-Receipt`.
- FiberMPP behavior learned: endpoints should be payment-method agnostic and can expose multiple methods simultaneously. The implementation follows this challenge/credential/receipt flow.
- What not to copy: do not make Cloudflare Workers or Agents a runtime requirement.

## Cloudflare charge for HTTP content

- URL: https://developers.cloudflare.com/agents/agentic-payments/mpp/charge-for-http-content/
- Local repo path: none
- Why it matters: practical middleware framing for paid HTTP content.
- FiberMPP behavior learned: route-level middleware and reverse proxy mode are both important integration surfaces.
- What not to copy: do not copy Cloudflare-specific bindings, deployment assumptions, or account model.

## Infern announcement

- URL: https://talk.nervos.org/t/introducing-infern-serve-an-ai-model-from-your-own-machine-and-get-paid-per-request-over-fiber/10408
- Local repo path: `/home/arthur/a19q3/infern`
- Why it matters: describes F402: HTTP 402 carrying a Fiber invoice, payment over Fiber, retry with proof, and serving the response.
- FiberMPP behavior learned: F402 should be an adapter, not the primary protocol. FiberMPP should provide infrastructure that Infern-like apps can use.
- What not to copy: do not build an AI inference marketplace, routing marketplace, registry, stake/slashing system, or model UI.

## Fiber infrastructure hackathon announcement

- URL: https://talk.nervos.org/t/gone-in-60ms-fiber-network-infrastructure-hackathon-announcement/10418
- Local repo path: none
- Why it matters: likely frames Fiber infrastructure priorities and hackathon submission expectations.
- FiberMPP behavior learned: unresolved from this environment because the page timed out during fetch on 2026-06-24.
- What not to copy: no implementation details were copied.

## nervosnetwork/fiber

- URL: https://github.com/nervosnetwork/fiber
- Local repo path: `/home/arthur/a19q3/fiber`
- Why it matters: reference Fiber Network Node implementation and JSON-RPC surface.
- FiberMPP behavior learned: Fiber exposes invoice and payment RPC methods that are sufficient for an MPP method adapter: `new_invoice`, `get_invoice`, `send_payment`, `get_payment`, `list_payments`, `list_channels`, and `node_info`.
- What not to copy: do not import or modify Fiber internals. FiberMPP talks over JSON-RPC.

## Fiber RPC README

- URL: https://github.com/nervosnetwork/fiber/blob/develop/crates/fiber-lib/src/rpc/README.md
- Local repo path: `/home/arthur/a19q3/fiber/crates/fiber-lib/src/rpc/README.md`
- Why it matters: current method names, parameter shapes, statuses, and warnings.
- FiberMPP behavior learned: the RPC port must be treated as trusted-only; invoice status `Received` or `Paid` and payment status success-like states can count as settled.
- What not to copy: do not expose Fiber RPC directly to browsers or untrusted networks.

## Fiber glossary

- URL: https://github.com/nervosnetwork/fiber/blob/develop/docs/glossary.md
- Local repo path: `/home/arthur/a19q3/fiber/docs/glossary.md`
- Why it matters: clarifies payment channels, invoices, payment hashes, preimages, HTLC/PTLC language, and node identifiers.
- FiberMPP behavior learned: use pubkey/node id carefully and keep invoice/payment-hash semantics visible in docs and proofs.
- What not to copy: do not overspecify PTLC behavior that is not exposed by current RPC.

## lightninglabs/l402

- URL: https://github.com/lightninglabs/l402
- Local repo path: `/home/arthur/a19q3/l402`
- Why it matters: precedent for combining HTTP 402, invoices, and bearer credentials.
- FiberMPP behavior learned: challenge tokens should bind resource, amount, payment hash, expiration, and issuer. Replay must be tracked when credentials are bearer-like.
- What not to copy: do not use Lightning-specific macaroon or BOLT11 assumptions as Fiber requirements.

## Fewsats awesome-L402

- URL: https://github.com/Fewsats/awesome-L402
- Local repo path: `/home/arthur/a19q3/awesome-L402`
- Why it matters: ecosystem map for L402 tooling and patterns.
- FiberMPP behavior learned: middleware, clients, and CLI tools are the right reusable surfaces.
- What not to copy: do not imply FiberMPP is a Lightning L402 implementation.

## Five Attacks on x402 Agentic Payment Protocol

- URL: https://arxiv.org/abs/2605.11781
- Local repo path: none
- Why it matters: identifies practical attacks around authorization, binding, replay, and web-layer handling that can produce unpaid service or paid-but-denied outcomes.
- FiberMPP behavior learned: test resource binding, method binding, amount binding, expiry, single-use credentials, no-store 402 responses, and wrong-resource attempts.
- What not to copy: do not copy paper text or implement only a superficial 402 demo.

## A402

- URL: https://arxiv.org/abs/2603.01179
- Local repo path: none
- Why it matters: argues that service execution and payment need stronger binding than simple pay-then-serve flows.
- FiberMPP behavior learned: FiberMPP should document paid-but-denied limits and move toward stronger delivery/payment coupling in future work.
- What not to copy: do not claim TEE-assisted adaptor signatures or Atomic Service Channels are implemented.

## Additional cloned repositories

- `/home/arthur/a19q3/fiber-docs`: Fiber docs reference.
- `/home/arthur/a19q3/fiber-pay`: CLI/payment UX reference.
- `/home/arthur/a19q3/fiber-l402`: Fiber L402 precedent.
- `/home/arthur/a19q3/fiber-checkout`: React checkout/payment component reference.
