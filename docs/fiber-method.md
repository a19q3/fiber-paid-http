# Proposed MPP Fiber charge method

Status: project specification. The method identifier `fiber` is not claimed as registered or standardized. The HTTP layer follows the current [Payment authentication draft](https://paymentauth.org/draft-httpauth-payment-00.txt) and [charge intent draft](https://paymentauth.org/draft-payment-intent-charge-00.txt); this document defines the Fiber-specific request, credential payload, verification, settlement, and receipt rules required by those drafts.

## Identifier and intent

```text
method = fiber
intent = charge
```

Both values are lowercase and case-sensitive. Implementations that do not explicitly support this project profile must treat the challenge as unsupported.

## Charge request

The MPP `request` parameter is unpadded base64url of RFC 8785 JCS for this object:

```json
{
  "amount": "100000000",
  "currency": "ckb",
  "recipient": "optional-payee-node-id",
  "description": "optional human-readable purpose",
  "externalId": "optional merchant correlation id",
  "methodDetails": {
    "invoice": "Fiber invoice address",
    "paymentHash": "0x-prefixed 32-byte lowercase-or-uppercase hex",
    "network": "mainnet | testnet | dev",
    "hashAlgorithm": "ckb_hash | sha256",
    "invoiceCurrency": "Fibb | Fibt | Fibd",
    "invoiceExpiresAt": "RFC 3339 timestamp",
    "invoiceUdtScript": "optional 0x-prefixed Molecule Script bytes",
    "udtTypeScript": {
      "code_hash": "0x-prefixed 32-byte hex",
      "hash_type": "type",
      "args": "0x-prefixed hex"
    }
  }
}
```

`amount` is a positive decimal string in the smallest unit of `currency`. Fiber JSON-RPC quantities are encoded separately as `0x` hex strings. `methodDetails.invoice` and `methodDetails.paymentHash` must identify the same invoice created by the payee gateway. Rust-issued challenges bind `invoiceCurrency` and `invoiceExpiresAt`; `invoiceUdtScript` binds the exact encoded invoice attribute when present. `udtTypeScript` is omitted for native CKB and required when the invoice asset needs a script identity.

## Credential payload

The `Authorization: Payment` credential exactly echoes the issued challenge. Its method payload is:

```json
{
  "paymentHash": "0x-prefixed 32-byte hex"
}
```

The payment hash is a lookup and binding value, not sufficient proof by itself. The gateway must load the exact challenge and charge request it issued, require the payload hash to match, and query its trusted payee Fiber RPC endpoint for that invoice.

## Verification and settlement

The gateway must complete all of these checks before delivery:

1. validate the MPP challenge schema, exact echoed challenge, expiry, HMAC binding, and current resource/body binding;
2. load the stored charge and require its canonical form to match the decoded `request`;
3. require payload, stored charge, and invoice payment hashes to agree;
4. require `get_invoice` to return the exact invoice address and verify payment hash, amount, invoice currency/network, hash algorithm, UDT script bytes, and expiry against the bound charge;
5. poll `get_invoice` by payment hash through a trusted payee node until status is exactly `Paid`, rejecting terminal states and timeouts;
6. atomically consume the challenge, credential hash, and payment hash so concurrent retries allow at most one delivery.

The client-side payer flow parses the invoice and performs the same payment hash, amount, currency/network, hash-algorithm, UDT, and expiry checks before calling `send_payment`; any missing or changed field fails closed. It then polls `get_payment` until status is exactly `Success`.

## Receipt

After the protected upstream returns `2xx`, the gateway may return unpadded base64url JSON in `Payment-Receipt`:

```json
{
  "status": "success",
  "method": "fiber",
  "timestamp": "2026-07-13T12:00:01.000Z",
  "reference": "0x-payment-hash",
  "challengeId": "base64url-challenge-id"
}
```

`reference` is the Fiber payment hash. `challengeId` is the method-specific correlation extension. This implementation emits deterministic JCS bytes, while conforming clients and verifiers accept any valid JSON member order. A receipt is never emitted on a non-`2xx` response and does not replace the Fiber settlement record or durable delivery outcome.

## Errors and retries

Malformed credentials, unknown/expired/consumed challenges, wrong resource or body digest, mismatched hashes or amounts, failed settlement, and replay return `402` with a fresh `WWW-Authenticate: Payment` challenge. Internal Fiber RPC and upstream details are not returned to clients.

For non-idempotent protected operations, applications should supply an `Idempotency-Key` and maintain a business response/reconciliation record keyed to the consumed challenge. The gateway guarantees at-most-once delivery for one payment credential; it does not claim atomicity between Fiber settlement and an arbitrary external upstream.

## Security requirements

- TLS 1.2 or later is required for public Payment challenges and credentials; TLS 1.3 is recommended.
- `402` responses use `Cache-Control: no-store`; receipt responses use `Cache-Control: private`.
- Authorization credentials, invoices, capabilities, preimages, challenge-binding secrets, and RPC authentication are never logged.
- Fiber RPC remains on loopback or a private trusted network with authentication and firewall controls.
- Challenge issuance and credential verification are rate-limited and body sizes are bounded at the deployment edge.
