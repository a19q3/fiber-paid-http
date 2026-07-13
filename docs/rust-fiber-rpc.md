# Rust Fiber RPC

The Rust Fiber adapter mirrors the live-proven TypeScript method shapes.

## Methods

```text
new_invoice   payee creates invoice
send_payment  payer sends payment for invoice
get_payment   payer polls payment by payment_hash
get_invoice   payee polls invoice by payment_hash
```

## Numeric Encoding

Rust uses the same hex JSON quantity convention as TypeScript:

```text
100 -> 0x64
```

## Settlement Semantics

The live local Fiber path proved:

```text
get_payment status Success
get_invoice status Paid
```

Rust exposes the same constants and helpers in `crates/fiber-paid-http-fiber`.

## Gateway Path

The Rust HTTP gateway uses these method semantics for server-bound MPP challenge issuance, invoice creation, payment settlement inspection, `Authorization: Payment` verification, `Payment-Receipt` issuance, durable SQLite storage, and replay rejection.

## Live E2E

Rust does not infer live readiness from deterministic tests. Production readiness remains false until a fresh testnet run for the current Fiber commit and a fresh production-bootstrap report both verify.
