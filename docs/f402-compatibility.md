# F402 and F-L402 Compatibility

F402 compatibility is an adapter, not the primary FiberMPP protocol.

FiberMPP accepts F402-like challenge bodies with:

```json
{
  "token": "v1...",
  "invoice": "fibd...",
  "paymentHash": "0x...",
  "amount": "1000",
  "currency": "CKB",
  "expiresAt": "..."
}
```

The adapter converts that shape to an internal MPP `PaymentChallenge` with a Fiber method challenge. It also converts F402-like proof objects to `PaymentCredential`.

## Infern compatibility note

Infern uses F402 for paid AI inference over Fiber. FiberMPP deliberately avoids Infern-specific fields. The adapter focuses on common Fiber invoice, amount, payment hash, expiry, and token fields.

## Difference from primary MPP mode

Primary FiberMPP mode is payment-method agnostic and returns `WWW-Authenticate: Payment`, `Authorization: Payment`, and `Payment-Receipt`. F402 mode exists so Fiber-native 402 applications can bridge into that internal model.

## F-L402 Adapter

F-L402 is the L402-style adapter for clients that expect:

```text
WWW-Authenticate: L402 macaroon="...", invoice="..."
Authorization: L402 <macaroon>:<preimage>
```

FiberMPP issues an application-level token with this format:

```text
fl402-macaroon-v1.<canonical-json-base64url>.<hmac-sha256>
```

The token carries first-party caveats for `challengeId`, `resourceHash`, HTTP method, URL, amount, currency, payment hash, invoice, expiry, issuer, optional Fiber node id, and hash algorithm. The verifier checks the HMAC, expiry, preimage hash, invoice, amount, resource binding, hash algorithm, and settled status before converting the proof into an internal `PaymentCredential`.

This is L402-semantics compatibility for Fiber. It is not byte-level compatibility with Lightning Labs macaroon libraries.
