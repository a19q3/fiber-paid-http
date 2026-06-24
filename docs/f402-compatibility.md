# F402 Compatibility

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
