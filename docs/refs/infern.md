# Infern / F402 Reference Notes

Infern is an AI compute marketplace that uses F402, meaning HTTP 402 wired to Fiber. Its flow is: request without payment, 402 with Fiber invoice, Fiber payment, retry with proof, then service response.

What Fiber Paid HTTP learns:

- Fiber invoices and payment hashes are a natural fit for HTTP 402 paid APIs.
- F402 should be treated as a compatibility adapter because it is Fiber-specific and not the whole MPP method model.
- Server-side verification may need to poll Fiber invoice status because Fiber RPC does not expose a Lightning-style preimage proof to the consumer in the same way L402 expects.

What Fiber Paid HTTP does not copy:

- No model marketplace.
- No provider registry, router marketplace, staking, slashing, or reputation layer.
- No OpenAI-compatible inference surface.

Compatibility implementation:

- `packages/f402-compat` accepts an F402-like challenge body with `invoice`, `paymentHash`, `amount`, and `expiresAt`.
- It converts to an internal MPP `PaymentChallenge`.
- It converts an F402-like proof into an MPP `PaymentCredential`.
