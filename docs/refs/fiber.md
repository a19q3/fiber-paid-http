# Fiber Reference Notes

FiberMPP uses Fiber through JSON-RPC only. The RPC README warns that exposing the RPC port to arbitrary machines is dangerous, so production deployments should bind it to trusted local networks or loopback and put FiberMPP in front.

Relevant RPC methods from `/home/arthur/a19q3/fiber/crates/fiber-lib/src/rpc/README.md`:

- `new_invoice`: creates a Fiber invoice with amount, currency, optional payment hash or preimage, expiry, and routing options.
- `get_invoice`: retrieves invoice status by payment hash. Useful server-side verification statuses are `Received` and `Paid`.
- `send_payment`: pays a target or invoice. The client helper uses the invoice path when real RPC mode is configured.
- `get_payment`: retrieves payment status by payment hash. Success-like statuses are normalized as settled.
- `list_payments`, `list_channels`, `node_info`: useful for diagnostics and future `doctor` checks.

Current implementation status:

- Mock mode creates local simulated Fiber challenges and proofs.
- Local/testnet mode can create invoices, send payments, and verify invoice/payment status over JSON-RPC when `FIBER_RPC_URL` is set.
- No live mainnet claim is made.

Safety notes:

- `FIBER_MODE=mock` produces `settlement.status = "simulated"`.
- `FIBER_MODE=local` or `testnet` only produces `settlement.status = "settled"` after Fiber RPC reports settled status.
- Fiber RPC credentials must not be logged.
