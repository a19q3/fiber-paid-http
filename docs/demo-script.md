# Gateway Lab Demo Script

This is the judge-facing 90-second demonstration for **Category 3 — Merchant, Liquidity, LSP, and Multi-Asset Infrastructure**, specifically service metering and paid HTTP delivery.

The audience is API developers and service operators. The GUI is an integration and evidence surface; machines and agents use the HTTP contract and SDKs.

## Evidence rules

Say only what the active source proves:

- `LIVE`: the current API reports `livePaymentEnabled: true`, real Fiber RPC endpoints are configured, and the evidence belongs to this session.
- `PRESERVED EVIDENCE`: a committed report records a prior verified run. State its source and do not call it live.
- `STATIC DEMO`: deterministic adapters or fixtures exercise the protocol and UI without real Fiber settlement. `reports/evidence-console-browser-smoke.json` is this lane.
- `BLOCKED`: a prerequisite is absent or a check failed. Read the blocker; do not click through or substitute sample output.
- `EXPERIMENTAL`: an opt-in surface is disabled by default and is not a production-readiness claim. F-L402 is the current example.

If Overview says `BLOCKED`, present the preserved or static evidence lane by its actual label. If Examples reports missing JDK 21 or engine jar, leave match actions disabled and show that blocker.

## Before recording

Choose one lane and keep its label visible:

1. **Live Fiber:** start the configured local/testnet operator lane with `bash scripts/evidence_live_demo.sh all`.
2. **Local inspection:** run `pnpm evidence:api` and `pnpm evidence:web`; unconfigured live dependencies remain visibly blocked while committed reports remain preserved evidence.
3. **Static regression:** run `pnpm --filter @fiber-paid-http/evidence-web check-browser-smoke`; this regenerates the explicitly static browser report with deterministic in-process Fiber adapters.

There is no public hosted URL claimed in this repository. Do not invent one for a submission. Publish one only after the deployment passes the same health, payment, receipt, and replay checks.

## 90-second narration

### 0–12 seconds — the infrastructure gap

Open **Overview**.

> Fiber already settles fast off-chain payments. The missing infrastructure is enforcing what one payment unlocks: this exact HTTP request, once, followed by a receipt only if delivery succeeds.

Point to the audience chips and the four-step enforcement lifecycle. Do not describe the Gateway Lab as a wallet, node dashboard, or participant UI.

### 12–25 seconds — integration boundary

Point to the protocol boundary cards.

> MPP draft is the primary HTTP wire contract and `fiber` is our proposed settlement profile. F402 and x402 v2 are explicit adapters. They all terminate at the same Rust verifier; this is not another facilitator or settlement rail.

Point to the current readiness labels. Name the label exactly: `LIVE`, `PRESERVED EVIDENCE`, or `BLOCKED`.

### 25–55 seconds — paid delivery

Open **Live flow** and select a protected resource.

1. Click **Send unpaid request** and show `402` plus the bound challenge and resource hash.
2. Click **Pay with Fiber** only when the action is enabled by the active lane.
3. Click **Retry with Authorization** and show the upstream execution plus `Payment-Receipt`.

> The Rust gateway checks method, URL, body digest when present, amount, payment hash, expiry, and Fiber settlement. SQLite atomically consumes the challenge before one upstream delivery. A failed upstream never receives a success receipt.

For a static run, replace “Fiber settled” with “the deterministic adapter exercised the settlement boundary.”

### 55–68 seconds — replay is the proof

Click **Replay same credential**.

> The second request returns a fresh 402. The service is not executed again and no receipt is reissued. This is the part an invoice-only demo does not solve.

Show `replay_status: blocked` and `receipt_reissued: false` in the inspector or Verifier.

### 68–80 seconds — reusable infrastructure

Open **Verifier** and briefly show canonical parity and committed reports.

> Paid APIs, agent tools, merchants, and games reuse this enforcement lifecycle. FNN owns channels and settlement; payer tools own authorization; the application keeps its own product policy.

Do not imply that TypeScript is trusted production verification. It is SDK, adapters, UI, and conformance tooling.

### 80–90 seconds — reference integration

Open **Examples**.

> Battlecode is a reference integration, not the product. It demonstrates a paid xUDT entry binding an external service to the same challenge, one-time redemption, delivery, and receipt evidence.

Point to scaffold, JDK 21, engine jar, Fiber payment, and prize mode. If any item is blocked, stop there and read the exact blocker. A local award ledger is not a Fiber xUDT payout and is labeled separately.

## Closing line

> Fiber Paid HTTP turns Fiber settlement into replay-safe HTTP delivery, with one canonical Rust enforcement path that other Fiber applications can reuse.
