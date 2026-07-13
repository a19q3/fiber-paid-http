# x402 v2 compatibility boundary

Fiber Paid HTTP exposes an independent x402 v2 conversion package. It is not an x402 facilitator and does not create another payment lifecycle.

The TypeScript package `@fiber-paid-http/x402-compat` uses the official pinned `@x402/core` package. The Rust crate `fiber-paid-http-x402` implements the same strict conversion rules. Shared vectors require both engines to agree on the canonical input hash, acceptance result, and error code.

## Mapping

| x402 v2 field | Fiber Paid HTTP value |
| --- | --- |
| `scheme` | `exact` |
| `network` | project-local CAIP-2-shaped `fiber:mainnet`, `fiber:testnet`, or `fiber:dev` |
| `amount` | the Fiber charge amount in the asset's smallest unit |
| `asset` | `fiber:{currency}` |
| `payTo` | the explicit Fiber payee node ID |
| `extra.fiber` | invoice, payment hash, hash algorithm, and optional UDT type script |
| `PaymentPayload.payload.paymentHash` | the MPP Fiber credential payload |
| `SettleResponse.transaction` | the successful MPP receipt reference |

`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` are encoded and decoded with the official x402 HTTP helpers. Accepted requirements are compared exactly against the signed MPP Fiber charge before a credential can be produced. Changing amount, asset, payee, invoice, network, payment hash, or method details is rejected.

The conversion ends at the canonical MPP challenge/credential/receipt boundary. Fiber RPC settlement verification, durable single-use redemption, protected-service delivery, and receipt issuance remain exclusively in the Rust gateway.

The `fiber:*` network identifiers and `fiber-charge-v1` profile are project proposals, not claims of registration or endorsement by the x402 project.

References:

- [x402 protocol repository](https://github.com/x402-foundation/x402)
- [x402 HTTP 402 documentation](https://docs.x402.org/core-concepts/http-402)
