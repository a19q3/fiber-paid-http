# Protocol

Fiber Paid HTTP follows the current MPP HTTP authentication draft with `method="fiber"` and `intent="charge"`.

## Challenge

The gateway returns `402 Payment Required`, `Cache-Control: no-store`, and a `WWW-Authenticate: Payment` header containing:

```json
{
  "id": "base64url-hmac-sha256",
  "realm": "api.example.com",
  "method": "fiber",
  "intent": "charge",
  "request": "base64url-jcs-charge-request",
  "expires": "2026-07-13T12:00:00.000Z",
  "digest": "sha-256=:base64-digest:",
  "description": "optional human description",
  "opaque": "optional-unpadded-base64url-jcs-string-map"
}
```

`id` binds `realm`, `method`, `intent`, `request`, `expires`, `digest`, and `opaque` with the draft's fixed seven-slot HMAC-SHA256 construction. `opaque`, when present, is unpadded base64url of JCS for a flat string-to-string object.

The decoded Fiber charge request is:

```json
{
  "amount": "100000000",
  "currency": "ckb",
  "recipient": "optional Fiber node id",
  "description": "optional description",
  "externalId": "optional merchant id",
  "methodDetails": {
    "invoice": "Fiber invoice",
    "paymentHash": "0x-prefixed 32-byte hash",
    "network": "local or testnet",
    "hashAlgorithm": "ckb_hash",
    "udtTypeScript": null
  }
}
```

All integer values are decimal strings in the MPP charge and hex quantities only at the Fiber JSON-RPC boundary.

## Credential

The client retries with `Authorization: Payment <base64url-json>`:

```json
{
  "challenge": { "id": "...", "realm": "...", "method": "fiber", "intent": "charge", "request": "..." },
  "payload": { "paymentHash": "0x..." }
}
```

The gateway requires an exact field match with the stored challenge, including the originally encoded `request` bytes. It then checks expiry, public resource URL, HTTP method, RFC 9530 body digest for non-GET/HEAD requests, charge details, payment hash, and Fiber settlement. The credential envelope is ordinary base64url JSON as specified by MPP; key order and insignificant JSON whitespace are not security boundaries.

Redemption is a single SQLite transaction. Only one concurrent retry can consume the challenge.

## Receipt

Only a successfully delivered upstream `2xx` response gets `Payment-Receipt` and `Cache-Control: private`:

```json
{
  "status": "success",
  "method": "fiber",
  "timestamp": "2026-07-13T12:00:01.000Z",
  "reference": "0x...",
  "challengeId": "..."
}
```

`reference` is the Fiber payment hash. `challengeId` links the delivery to the consumed challenge. The receipt is schema evidence; the settled Fiber payment and durable delivery record are the authority.

If settlement succeeds but the upstream fails, the gateway records a failed delivery and emits no receipt. Reconciliation uses the payment hash and challenge ID.

## Explicit compatibility entrances

F402 maps its charge or proof into the shapes above.

The optional experimental F-L402 adapter, disabled unless explicitly configured, returns an additional `WWW-Authenticate: L402 capability="..."` challenge. The retry is `Authorization: L402 <capability>:<preimage>`. The gateway verifies the capability, preimage hash, caveats, and stored challenge, then constructs the same MPP credential used by the normal verifier.

No alternate settlement, replay, or receipt path exists.
