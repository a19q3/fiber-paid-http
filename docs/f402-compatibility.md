# F402 and F-L402 compatibility

Compatibility is implemented at explicit ingress boundaries. The gateway never emits an alternative internal payment model.

## F402

An F402 charge is decoded and mapped to an MPP-draft `PaymentChallenge` with `method="fiber"`, `intent="charge"`, and an encoded Fiber charge request. An F402 proof maps to an MPP-draft `PaymentCredential` only when its payment hash matches the challenge.

The mapped credential passes through the normal challenge binding, resource, expiry, settlement, and atomic replay checks.

## F-L402 (experimental, disabled by default)

When enabled, the gateway adds:

```http
WWW-Authenticate: L402 capability="...", invoice="...", payment_hash="..."
```

The client retries with:

```http
Authorization: L402 <capability>:<preimage>
```

The capability format is project scoped:

```text
fiber-l402-capability-v1.<jcs-base64url>.<hmac-sha256-hex>
```

Its caveats bind challenge ID, resource, resource hash, invoice, payment hash, amount, currency, issuer, expiry, and hash algorithm. The gateway verifies the HMAC in constant time, checks the preimage using `ckb_hash` or `sha256`, loads the exact stored challenge, and creates a standard credential.

F-L402 does not claim byte compatibility with third-party token libraries. It is an experimental, opt-in adapter: omitting the `fl402` gateway configuration disables both its challenge and authorization path. When enabled, it uses the same Fiber settlement and MPP-draft receipt path.
