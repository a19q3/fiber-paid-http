# Protocol

Fiber Paid HTTP implements an MPP-style HTTP 402 flow.

## PaymentChallenge

The challenge domain is `fiber-paid-http-challenge-v1`. It binds:

- HTTP method, URL, optional body hash, and content type,
- amount and currency,
- available payment methods,
- nonce,
- issue and expiry timestamps,
- server id,
- max use count of 1.

The server signs the canonical JSON challenge with HMAC-SHA256.

## PaymentCredential

The credential domain is `fiber-paid-http-credential-v1`. It binds:

- challenge id,
- selected method,
- resource hash,
- method-specific payment proof,
- submission timestamp.

Clients send credentials as:

```text
Authorization: Payment <base64url JSON credential>
```

## PaymentReceipt

The receipt domain is `fiber-paid-http-receipt-v1`. It includes challenge id, method, resource hash, amount, settlement evidence, server id, issue timestamp, and HMAC signature.

Servers return receipts as:

```text
Payment-Receipt: <base64url JSON receipt>
```

## 402 response

Unpaid requests return:

```text
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="...", method="fiber", intent="charge", challenge="..."
Content-Type: application/problem+json
Cache-Control: no-store
```

When F-L402 is enabled, the same response also includes an L402 challenge and an `fl402` body:

```text
WWW-Authenticate: L402 macaroon="...", invoice="...", payment_hash="...", amount="...", currency="..."
```

Clients can retry with:

```text
Authorization: L402 <macaroon>:<preimage>
```

The gateway verifies the F-L402 caveats and preimage, converts the proof to a `PaymentCredential`, and then applies the same resource binding, replay, Fiber settlement, and receipt checks used by `Authorization: Payment`.
