# Security matrix

| Scenario | Expected result | Evidence |
| --- | --- | --- |
| Valid credential and settled invoice | accepted once | `credential.valid.json`, middleware/server tests |
| Replay or concurrent duplicate | `replay` | `attack.replay.json`, atomic redemption tests |
| Wrong URL or HTTP method | `wrong-resource` / `wrong-method` | attack vectors and gateway tests |
| Wrong body | `wrong-body-digest` | middleware body-digest test |
| Wrong amount or payment hash | `wrong-amount` / `wrong-payment-hash` | attack vectors |
| Fetched invoice address, amount, currency/network, hash algorithm, UDT, or expiry differs | reject before payment/authorization | TS payer and Rust gateway invoice-record tests |
| Expired challenge | `expired-challenge` | `attack.expired-challenge.json` |
| Tampered challenge binding | fresh 402 | middleware/server tests |
| Upstream non-2xx or exception | no receipt | `attack.receipt-on-error.json`, gateway tests |
| Forged upstream receipt header | stripped | gateway delivery logic |
| Wrong F-L402 preimage | `wrong-preimage` | `attack.fl402-wrong-preimage.json` |
| Tampered F-L402 capability | `bad-fl402-capability-signature` | `attack.fl402-tampered-capability.json` |
| Changed x402 accepted requirement | `x402-fiber-requirement-mismatch` | `attack.x402-tampered-requirement.json` |
| Unsupported SQLite schema | startup failure | storage tests |
