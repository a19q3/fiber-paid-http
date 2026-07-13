# Positioning

Fiber Paid HTTP is a paid HTTP gateway and protocol toolkit. Its HTTP wire contract follows the current MPP draft; its proposed payment-method identifier is `fiber`; its production verifier is Rust.

| Layer | Role |
| --- | --- |
| MPP | External HTTP challenge, credential, and receipt contract |
| Proposed `fiber` method profile | Invoice creation, payment execution, and settlement evidence |
| Rust gateway | Trusted binding, settlement, replay, delivery, and receipt verifier |
| TypeScript | Client SDK, Evidence Console, adapters, vectors |
| F402 / F-L402 | Optional ingress mappings into the MPP-draft verifier; F-L402 is experimental and disabled by default |
| x402 v2 | Independent `exact`/Fiber format converter using official HTTP codecs; not a facilitator or settlement path |

The project does not define a competing paid-HTTP envelope. It also does not claim to be a wallet, checkout system, marketplace, custody service, or x402 node implementation.

The user-facing pitch is:

> Put an MPP-draft paywall in front of any HTTP API and settle it through Fiber, with a Rust verifier and inspectable evidence.
