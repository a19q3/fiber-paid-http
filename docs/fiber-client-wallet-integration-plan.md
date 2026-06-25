# Fiber Client And Wallet Integration Plan

Status: decision record for FiberMPP integration boundaries.

Last checked: 2026-06-25.

## Decision Update

Best current path:

```text
FiberMPP production path:
  Rust gateway/verifier
  -> direct FNN JSON-RPC
  -> FNN built-in wallet and channel state

Payer default:
  payer-owned FNN JSON-RPC
  -> send_payment
  -> FiberMPP Authorization: Payment

Ops helper:
  fiber-pay CLI/runtime may bootstrap and monitor nodes,
  but it must not sit inside the gateway trusted verifier path.

Future browser payer:
  fiber-pay/react or fiber-js WASM node,
  optionally funded by CCC/WalletConnect-style CKB transaction signing.
```

The important split is:

```text
Fiber node = payment executor
CKB wallet/CCC/WalletConnect = funding transaction signer
FiberMPP = challenge, verification, receipt, replay and delivery boundary
```

Using the FNN built-in wallet is not a compromise path. For merchants, agents,
automation, and production server deployments, it is the best default because it
keeps CKB keys, Fiber channel state, routing, invoices, and `send_payment` in the
same native node boundary. The operational price is clear: the node directory and
`FIBER_SECRET_KEY_PASSWORD` become critical production assets that must be backed
up, monitored, and rotated under runbook control.

## Audit Conclusion

Best path for FiberMPP:

```text
Production server/payee: native FNN JSON-RPC + FNN built-in wallet
Programmatic payer/agent: native FNN JSON-RPC + FNN built-in wallet
Optional ops/client helper: fiber-pay, outside the trusted verifier path
Browser self-custody: fiber-pay/react or fiber-js WASM node, later
External wallet: CCC/WalletConnect only for CKB channel funding signatures
```

Do not model WalletConnect as a Fiber payment provider. A wallet connector can
sign CKB transactions, but it does not maintain Fiber channel state, gossip,
route discovery, invoice settlement, or `send_payment` execution. The thing that
pays a Fiber invoice must be a Fiber node: native FNN, browser/Node `fiber-js`,
or a tool such as `fiber-pay` that controls one of those nodes.

The immediate production baseline should therefore remain direct FNN JSON-RPC
with the FNN built-in wallet. This is the smallest trusted surface and matches
FiberMPP's current live local and testnet E2E evidence paths. Browser wallets
and WalletConnect-style flows belong to channel funding and payer UX, not to
gateway verification.

FiberMPP should integrate with Fiber clients without becoming a wallet, checkout product, or node dashboard. The production payment truth remains:

```text
FiberMPP gateway/verifier -> Fiber JSON-RPC -> FNN
```

Payer UX can be pluggable, but the server-side trusted boundary must not depend on `fiber-pay`, browser wallets, WalletConnect, or any hosted wallet service.

## Sources Checked

- Fiber official quick start: native FNN is recommended for production services, server deployments, persistent storage, and full control. It exposes `fnn-cli` and raw JSON-RPC.
- Fiber official WASM docs: `@nervosnetwork/fiber-js` can run a browser/Node.js Fiber node with IndexedDB persistence in browser contexts. It requires cross-origin isolation because it uses `SharedArrayBuffer`.
- Fiber official native-node docs: FNN includes built-in wallet functionality for signing funding transactions. Nodes require `FIBER_SECRET_KEY_PASSWORD` at startup, and the node data directory stores key/channel state.
- Fiber official backup docs: the entire node directory and `FIBER_SECRET_KEY_PASSWORD` are operationally critical; `ckb/key`, `fiber/sk`, and `fiber/store` must be backed up with the node stopped or under a crash-consistent snapshot.
- Fiber public-node docs: a private local node can connect to public relay nodes and route payments without exposing a public address.
- Fiber external funding support: `open_channel_with_external_funding` and `submit_signed_funding_tx` move CKB funding transaction signing to an external wallet, while preserving Fiber channel negotiation and payment execution in the node.
- `fiber-pay` local checkout and README: current package split is `@fiber-pay/cli`, `@fiber-pay/sdk`, `@fiber-pay/react`, `@fiber-pay/runtime`, `@fiber-pay/node`, and experimental `@fiber-pay/agent`.
- `fiber-pay` browser references: browser mode wraps `fiber-js`, supports password/passkey credential providers, and can hand off external funding to CCC-style signers.
- Nervos CCC docs: CCC is a CKB wallet connector for connecting wallets and signing/managing CKB assets. It is not, by itself, a Fiber payment node.

Source links:

- <https://www.fiber.world/docs/quick-start/run-a-node>
- <https://www.fiber.world/docs/quick-start/run-a-node/rust>
- <https://www.fiber.world/docs/quick-start/run-a-node/fiberjs>
- <https://www.fiber.world/docs/operate/backup>
- <https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md>
- <https://github.com/nervosnetwork/fiber/pull/1120>
- <https://github.com/RetricSu/fiber-pay>
- <https://talk.nervos.org/t/fiber-pay-an-ai-friendly-cli-for-fiber-network/9974>
- <https://docs.nervos.org/docs/integrate-wallets/ccc-wallet>

## Current Facts

- Fiber Network Node (FNN) is the reference node. It manages channels, routes payments, signs CKB settlement transactions, and exposes JSON-RPC.
- FNN has a built-in wallet: the node data directory contains `ckb/key`, encrypted at startup with `FIBER_SECRET_KEY_PASSWORD`.
- Fiber's current payment RPCs are sufficient for FiberMPP:
  - `new_invoice`
  - `send_payment`
  - `get_payment`
  - `get_invoice`
- Fiber also supports `fiber-js`, a WASM node that can run in browser or Node.js, with IndexedDB persistence in browser contexts.
- `fiber-pay` has tracked Fiber `v0.9.0-rc4` and provides:
  - `@fiber-pay/cli`
  - `@fiber-pay/sdk`
  - `@fiber-pay/react`
  - `@fiber-pay/runtime`
  - `@fiber-pay/node`
  - experimental `@fiber-pay/agent`
- `fiber-pay` browser support includes WASM node startup, passkey/password credential providers, payment hooks, and external channel funding helpers.
- CCC (`@ckb-ccc/connector-react`) is the CKB wallet connector layer. It supports CKB wallet connection and CKB transaction signing. It does not, by itself, execute Fiber `send_payment`.
- WalletConnect/Reown is a generic wallet transport. For FiberMPP it is useful only through a CKB wallet connector path, usually CCC, and only when the task is signing CKB transactions such as external funding.

## Options Compared

| Option | Executes Fiber payment? | Signs channel funding? | Custody model | Main value | Main gap | Fit For FiberMPP |
| --- | --- | --- | --- | --- | --- | --- |
| Direct FNN JSON-RPC | Yes | Yes, through built-in wallet | Operator or user node | Minimal trusted path; already proven by local and testnet E2E; exact control over `new_invoice`, `send_payment`, settlement polling, receipt issuance | Requires funded FNN nodes and ops discipline | Best default for production gateway and CLI payer |
| FNN built-in wallet | Yes, because it is inside FNN | Yes | Operator-managed node key | Durable service wallet; no browser dependency; matches native FNN docs | Key/channel-state backup is critical; custodial if run for users | Best for merchants, agents, automation, relayers, testnet/mainnet production services |
| `fiber-pay` CLI/runtime | Yes, by operating FNN underneath | Yes, through FNN and helper workflows | Operator or local agent | Rich setup, jobs, monitoring, payment/channel lifecycle, AI-friendly JSON output | Adds runtime/policy layer if placed in core path | Optional payer-side connector and ops companion, not a FiberMPP trusted dependency |
| `fiber-pay` SDK | Yes, by calling FNN or browser WASM node | Yes, with helper flows | Depends on adapter | Typed Fiber RPC client, browser/node utilities, external funding helpers | Duplicates FiberMPP adapter surface if imported into core | Useful for optional client package, test helpers, or future browser payer integration |
| `fiber-pay/react` + browser WASM | Yes, through browser Fiber node | Yes, internally or via external funding helper | User-browser node | User-owned browser Fiber node, passkey/password UX, no native install | Heavy WASM, COOP/COEP, IndexedDB/channel-state risk, relay dependency | Best long-term self-custody web payer path, behind explicit user intent |
| `fiber-js` directly | Yes | Yes, internally or via external funding RPCs | User-browser or Node.js node | Lowest-level browser/Node Fiber runtime | More raw integration burden than fiber-pay SDK/React | Good for custom advanced clients; not first client path |
| CCC external wallet | No | Yes, for CKB transaction signing | User wallet | Connects JoyID/OKX/UniSat/MetaMask/etc.; signs funding txs | Does not execute Fiber `send_payment` | Best way to fund/open channels for browser/native payer nodes |
| Raw WalletConnect/Reown | No | Maybe, only if the target wallet/chain adapter can sign the required CKB tx | User wallet | Broad generic wallet transport | Not Fiber-native, not CKB/Fiber semantics by itself, extra integration risk | Avoid as first-class path; use only through CCC or target-wallet adapter |
| Hosted/custodial payer node | Yes, through hosted FNN | Yes | Third-party/operator custody | Zero-install API-consumer UX | Custody, limits, KYC/risk, abuse controls, balance accounting | Future product option, not current protocol core |

## Bootstrap Ownership

| Actor | Recommended bootstrap | Payment executor | Wallet/signer role | Why |
| --- | --- | --- | --- | --- |
| Merchant/payee API | Native FNN on private network, managed by ops | Payee FNN creates invoices and verifies settlement state | FNN built-in wallet signs channel funding/settlement | Strongest production boundary; no browser/runtime dependency |
| Programmatic payer/agent | Payer-owned native FNN first; `fiber-pay` may assist setup | Payer FNN executes `send_payment` | FNN built-in wallet by default | Matches proven FiberMPP E2E and keeps agent UX scriptable |
| Browser user, self-custody | `fiber-pay/react` or `@fiber-pay/sdk/browser` later | Browser WASM Fiber node executes `send_payment` | Passkey/password key provider; optional CCC signer for external funding | Best long-term consumer UX, but needs browser E2E, COOP/COEP and backup guidance |
| External wallet user | CCC connector or WalletConnect-backed signer only after external-funding E2E | FNN/WASM node still executes payment | Wallet signs `open_channel_with_external_funding` transaction | Correctly uses wallets for CKB signing without pretending they are Fiber nodes |
| Operator/admin | `fiber-pay` CLI/runtime as optional companion | Direct FNN remains canonical for FiberMPP verification | FNN built-in wallet, secured by deployment secret manager | Useful for node lifecycle, jobs, logs and readiness without adding verifier dependency |

## Integration Recommendation

### 1. Ship Direct FNN As The Only Production Payment Provider

Keep the production contract narrow:

```text
FIBER_PAYEE_RPC_URL -> payee FNN
FIBER_PAYER_RPC_URL -> payer FNN, for CLI/E2E/agent payer flows
FIBER_*_RPC_AUTH   -> Biscuit or equivalent RPC auth when exposed beyond loopback
```

This is the only path that should be called "production Fiber payment support"
until another connector has its own live E2E evidence. It is also the only path
that should decide `production_ready_for_fiber_method`.

### 2. Add `fiber-pay` As A Payer/Ops Connector, Not A Gateway Dependency

Best use:

```text
fiber-pay node/config/channel/job/logs
  -> prepares or monitors payer/payee FNN
FiberMPP gateway
  -> still calls FNN JSON-RPC directly
```

Do not make the core path:

```text
FiberMPP gateway -> fiber-pay runtime -> FNN
```

That would add a second policy/runtime layer to the verifier path and make
receipt/replay semantics harder to audit. `fiber-pay` is more valuable as a
bootstrap, monitoring, and payer-side automation tool.

### 3. Treat Browser WASM As The First Real Wallet-Like UX

If FiberMPP later needs a user-facing payer, the best wallet-like path is not raw
WalletConnect. It is a browser Fiber node:

```text
FiberMPP 402 invoice
  -> browser WASM node through fiber-pay/react or fiber-js
  -> send_payment
  -> Authorization: Payment
```

This path owns channel state and can actually pay a Fiber invoice. It should be
implemented only after a dedicated browser E2E proves node startup, channel
funding/opening, payment settlement, receipt acceptance, and replay rejection.

### 4. Use CCC/WalletConnect Only For External Funding

Correct use:

```text
wallet connector
  -> sign unsigned CKB funding transaction
  -> FNN submit_signed_funding_tx
  -> ChannelReady
  -> Fiber node pays invoices
```

Wrong use:

```text
WalletConnect
  -> Fiber payment provider
```

Raw WalletConnect Pay targets generic wallet payment rails and PSP flows; it
does not by itself maintain Fiber channels, gossip, routing, invoices, or
`send_payment`. In FiberMPP docs and UI, name this path "external channel
funding" or "CKB funding signer".

## Recommended Default UX

### Merchant / Payee

Use a managed native FNN with its built-in wallet:

```text
merchant API -> FiberMPP Rust gateway -> private payee FNN RPC -> FNN built-in wallet
```

Why this wins:

- It is the only production-shaped path with minimal moving parts.
- It keeps invoice creation and settlement inspection inside the same private node boundary.
- It avoids browser wallet availability, remote hosted wallet custody, and WalletConnect chain support ambiguity.

Operational obligations:

- Store `FIBER_SECRET_KEY_PASSWORD` in a secret manager.
- Back up the full FNN data directory, including `ckb/key`, `fiber/sk`, `fiber/store`, config, and logs.
- Keep FNN RPC on loopback or a private network with auth/firewalling.
- Monitor peer count, `ChannelReady` channels, liquidity, invoice settlement, and FiberMPP receipt issuance.

### Programmatic Payer / Agent

Use a payer-owned native FNN first:

```text
agent / CLI -> payer FNN RPC -> send_payment -> FiberMPP Authorization: Payment
```

`fiber-pay` can improve bootstrap and automation here, but it should remain a
client-side or ops-side companion. FiberMPP should still accept the same
`fiber-payment-proof-v1` shape and verify settlement through Fiber RPC.

### Browser User

Use browser self-custody later, only after explicit E2E evidence:

```text
browser -> fiber-pay/react or fiber-js -> WASM Fiber node -> send_payment
```

This is the best long-term wallet-like UX because the browser actually runs a
Fiber node. It should be lazy-loaded and isolated because it requires
cross-origin isolation, WASM assets, IndexedDB persistence, browser-reachable
`/ws/` or `/wss/` peers, and clear backup/recovery language.

### External Wallet / WalletConnect User

Use CCC/WalletConnect only to sign channel funding transactions:

```text
CCC wallet signer
  -> sign unsigned_funding_tx
  -> FNN submit_signed_funding_tx
  -> ChannelReady
  -> FNN/WASM node pays Fiber invoices
```

This should be labeled "external channel funding", not "WalletConnect payment".
The payment executor remains the Fiber node.

## Decision Matrix

Scores: 5 is best. The score is about FiberMPP fit, not general product quality.

| Path | Production safety | User UX | Implementation risk | Protocol purity | Best timing |
| --- | ---: | ---: | ---: | ---: | --- |
| Native FNN + built-in wallet | 5 | 3 | 2 | 5 | Now |
| Native FNN + fiber-pay ops companion | 4 | 4 | 3 | 4 | After baseline docs/tests |
| Browser WASM through fiber-pay/react | 3 | 5 | 5 | 4 | Later, client-only |
| Browser WASM through raw fiber-js | 3 | 4 | 5 | 5 | Later, advanced users |
| CCC external funding for node channels | 4 | 4 | 4 | 5 | Add when external funding E2E exists |
| Raw WalletConnect payment provider | 1 | 3 | 5 | 1 | Do not build |
| Hosted payer node | 2 | 5 | 5 | 3 | Separate product, not FiberMPP core |

## Recommended Architecture

Use a two-plane design.

### Trusted Payment Plane

```text
merchant API
  -> FiberMPP gateway
  -> FiberMethodAdapter
  -> payee FNN JSON-RPC
  -> issued invoice

payer client
  -> Fiber-capable payer connector
  -> payer FNN / browser WASM node
  -> send_payment
  -> Authorization: Payment
  -> FiberMPP receipt
```

Rules:

- Keep direct FNN JSON-RPC as the canonical implementation path.
- Keep all receipt verification, replay protection, resource binding, and delivery outcome recording inside FiberMPP.
- Do not route gateway challenge issuance, payment verification, or receipt signing through `fiber-pay`.
- Do not expose privileged FNN RPC ports to browsers. Browser clients must use their own WASM node or a narrow backend proxy with scoped auth.

### Payer Connector Plane

Introduce payer-side connectors only as optional client adapters. Suggested interface:

```ts
export interface FiberPayerConnector {
  id: "fnn-rpc" | "fiber-pay-runtime" | "fiber-pay-browser" | "custom";
  capabilities: {
    canPayInvoice: boolean;
    canOpenChannel: boolean;
    canExternalFundChannel: boolean;
    custody: "operator" | "user-browser" | "user-wallet" | "third-party";
  };
  doctor(): Promise<PayerReadiness>;
  payInvoice(input: {
    invoice: string;
    paymentHash: string;
    amountShannons: string;
  }): Promise<FiberPaymentProof>;
}
```

Do not add this abstraction to the gateway verifier first. Add it to `packages/client` or a new client-facing package when a second real payer connector is implemented and tested.

## Best Path

### Phase 1: Production Baseline

Default production path:

```text
gateway/payee: native FNN with built-in wallet
payer/agent: native FNN with built-in wallet
FiberMPP: direct JSON-RPC adapter
```

This is the best path now because it is the only path already proven end-to-end by local and testnet Fiber E2E. It has the smallest security surface and matches Fiber's documented production node model.

Required work:

- Keep `FIBER_PAYEE_RPC_URL` / `FIBER_PAYER_RPC_URL` direct FNN RPC as the primary config.
- Keep docs for built-in-wallet key import/export, `FIBER_SECRET_KEY_PASSWORD`, node data backups, and channel state backup risk current with upstream Fiber docs.
- Keep direct-FNN testnet E2E evidence green with two funded FNN nodes before release.
- Add gateway runbook entries for Fiber node health, channel liquidity, peer readiness, and RPC auth.

### Phase 2: Optional `fiber-pay` Ops Companion

Use `fiber-pay` outside the FiberMPP core:

```text
operators / agents -> fiber-pay CLI/runtime -> FNN
FiberMPP gateway    -> direct FNN RPC
```

Good uses:

- Node/profile setup.
- Peer connection and channel lifecycle jobs.
- Payment/channel monitoring.
- Agent-facing automation.

Avoid:

- `FiberMPP gateway -> fiber-pay -> FNN` as the primary payment path.
- Treating `@fiber-pay/agent` as production until its own hardening says so.
- Duplicating receipt/replay semantics in `fiber-pay`.

Integration shape:

```text
fiber-mpp doctor --role payer
  -> detect FIBER_PAYER_RPC_URL first
  -> optionally detect fiber-pay profile/node status later
  -> report readiness

fiber-mpp pay
  -> default: direct FNN RPC
  -> optional future flag: --payer-connector fiber-pay
  -> still returns the same FiberPaymentProof shape
```

The optional connector must prove parity against the direct FNN path before it is advertised:

```text
402 challenge
invoice paid by fiber-pay
payment settled
Authorization: Payment accepted
Payment-Receipt issued
replay rejected
same canonical hashes/error codes as direct FNN
```

### Phase 3: Browser Self-Custody Payer

Use `fiber-pay/react` or `@fiber-pay/sdk/browser` for payer UX:

```text
browser app
  -> Fiber WASM node via fiber-js
  -> passkey/password credential
  -> optional CCC external funding
  -> send_payment(invoice)
  -> FiberMPP Authorization: Payment
```

This gives the cleanest user-owned wallet story, but it is heavier:

- Requires COOP/COEP headers for SharedArrayBuffer.
- Ships a large WASM/runtime chunk.
- Stores node/channel state in browser storage, so backup/recovery language must be explicit.
- Needs relay/public-node guidance.

This path should be lazy-loaded and isolated from the Evidence Console's protocol visualization.

### Phase 4: CCC / WalletConnect For External Funding

Use CCC as the wallet bridge for CKB transaction signing:

```text
CCC wallet signer
  -> sign external funding tx
  -> FNN open_channel_with_external_funding
  -> submit_signed_funding_tx
  -> channel ready
  -> Fiber payment by FNN/WASM node
```

Important boundary:

- CCC/WalletConnect funds or signs CKB transactions.
- FNN/WASM node pays Fiber invoices.
- FiberMPP verifies Fiber payment proof and receipt semantics.

Raw WalletConnect is not a first-class Fiber payment provider and should not be a first-class FiberMPP integration. If needed, it should appear as one implementation behind CCC or a wallet-specific signer adapter.

The key reason: a wallet connector can sign a CKB transaction, but it does not own Fiber channel state, run route discovery, or execute `send_payment`. FiberMPP should never describe "WalletConnect payment" unless a real Fiber payer node is behind it.

## Bootstrap Plan By Role

### Merchant / Payee

Default:

```text
merchant server
  -> FiberMPP Rust gateway
  -> payee FNN RPC on private network
  -> FNN built-in wallet
  -> payee channels and invoices
```

Setup obligations:

- Run native FNN with a durable data directory.
- Keep FNN RPC private, authenticated, and firewalled.
- Provide `FIBER_SECRET_KEY_PASSWORD` through the deployment secret manager.
- Back up the full FNN data directory, including `ckb/key`, `fiber/store`, config, and logs needed for incident response.
- Monitor peers, channels, invoice settlement, and gateway receipt issuance.

### Payer / Agent

Default:

```text
payer CLI / agent
  -> payer FNN RPC
  -> FNN built-in wallet
  -> send_payment(invoice)
  -> Authorization: Payment
```

Good optional assistance:

- Use `fiber-pay` to start/monitor the payer node, connect peers, manage channels, and expose JSON status for agents.
- Keep the actual proof submitted to FiberMPP in FiberMPP's `fiber-payment-proof-v1` shape.

### Browser User

Future self-custody path:

```text
browser app
  -> fiber-pay/react or fiber-js
  -> browser WASM Fiber node
  -> passkey/password credentials
  -> optional CCC funding signer
  -> send_payment(invoice)
```

Constraints:

- Must be cross-origin isolated.
- Must explain IndexedDB/channel-state backup and loss risk.
- Must use browser-reachable `/ws/` or `/wss/` peers.
- Must not receive merchant/payee FNN RPC credentials.

### External Wallet User

Correct boundary:

```text
CCC / wallet
  -> sign CKB funding tx
  -> FNN submit_signed_funding_tx
  -> channel becomes ready
  -> Fiber node pays invoice
```

Incorrect boundary:

```text
WalletConnect
  -> pay Fiber invoice directly
```

That is not a real Fiber payment path unless another component runs the Fiber node and preserves channel state.

## Implementation Guardrails

- FiberMPP core accepts and verifies Fiber payment proofs; it does not manage user wallets.
- The gateway must call FNN JSON-RPC directly for invoice creation and payment-status inspection.
- `packages/client` may gain payer connector selection later, but only after at least two connectors have live E2E parity.
- A `fiber-pay` connector must live on the payer side, never inside the server verifier.
- CCC/WalletConnect integration must be named "external channel funding" or "CKB funding signer", not "Fiber payment".
- Built-in FNN wallet is the preferred production baseline for service/payee nodes because it is native to FNN and avoids browser wallet availability assumptions.
- Hosted/custodial payer is explicitly out of scope for the current FiberMPP protocol core.

## Product Positioning

FiberMPP should say:

```text
FiberMPP supports any payer that can produce a settled Fiber payment proof for the issued invoice.
The default supported payer is a real FNN JSON-RPC node.
Browser and external-wallet payer flows are optional connector layers.
```

It should not say:

```text
FiberMPP is a wallet.
FiberMPP replaces fiber-pay.
FiberMPP manages user assets.
FiberMPP supports WalletConnect payments directly.
```

## Implementation Checklist

1. Document FNN built-in wallet bootstrap for merchant/payee and payer roles.
2. Add `docs/payer-connectors.md` once a second connector is actually implemented.
3. Keep `packages/fiber-method` focused on direct FNN JSON-RPC.
4. Keep `packages/client` as the right place for optional payer connector selection.
5. Add a `fiber-pay` connector only after a live test proves:
   - challenge received,
   - invoice paid through `fiber-pay`,
   - Fiber payment settled,
   - Authorization retry accepted,
   - replay rejected.
6. Add a browser WASM connector only after a real browser E2E proves:
   - node starts with passkey/password,
   - channel funding/opening path is documented,
   - `send_payment` settles,
   - receipt/replay semantics match the direct FNN path.
7. Add CCC only to the external funding flow, not to Fiber payment verification.
8. Keep `production_ready_for_fiber_method: false` when separate testnet evidence is absent; allow it to become `true` only when direct FNN testnet evidence and operations gates pass.

## Decision

Best immediate path:

```text
Direct native FNN JSON-RPC + FNN built-in wallet
```

Best optional client path after the production baseline:

```text
fiber-pay SDK/React browser WASM node + CCC external funding
```

Best non-goal:

```text
Raw WalletConnect as a Fiber payment provider
```

That path signs generic wallet transactions, but it does not own Fiber channel state or execute Fiber routed payments. It should remain below CCC/fiber-pay abstractions, not become a FiberMPP surface.

## Final Recommendation

FiberMPP should ship one production payment path first:

```text
Rust gateway + direct FNN JSON-RPC + FNN built-in wallet
```

Then add client-side adapters in this order:

1. `fiber-pay` payer/ops connector, because it already wraps local FNN operations and agent-friendly JSON output.
2. `fiber-pay/react` or `@fiber-pay/sdk/browser` for browser self-custody, because it owns a real WASM Fiber node.
3. CCC external funding, only as the signer handoff for `open_channel_with_external_funding` and `submit_signed_funding_tx`.

Do not add raw WalletConnect as a named FiberMPP payment provider.
