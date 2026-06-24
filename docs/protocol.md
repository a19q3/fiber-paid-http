# Protocol

FiberMPP implements an MPP-style HTTP 402 flow.

## PaymentChallenge

The challenge domain is `fiber-mpp-challenge-v1`. It binds:

- HTTP method, URL, optional body hash, and content type,
- amount and currency,
- available payment methods,
- nonce,
- issue and expiry timestamps,
- server id,
- max use count of 1.

The server signs the canonical JSON challenge with HMAC-SHA256.

## PaymentCredential

The credential domain is `fiber-mpp-credential-v1`. It binds:

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

The receipt domain is `fiber-mpp-receipt-v1`. It includes challenge id, method, resource hash, amount, settlement evidence, server id, issue timestamp, and HMAC signature.

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
