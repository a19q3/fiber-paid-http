# Fiber Paid HTTP Evidence Console Frontend Plan

## Intent

Build a fancy but thin protocol console for showing one verifiable Fiber Paid HTTP flow:

```text
unpaid HTTP request -> 402 challenge -> Fiber payment -> settlement -> Authorization: Payment retry -> Payment-Receipt -> replay rejection
```

The console is not a Fiber product surface. It visualizes Fiber Paid HTTP evidence. Its job is to make the proof chain legible for judges, developers, and auditors without turning Fiber Paid HTTP into a wallet, node dashboard, checkout widget, or Fiber CLI.

## Product Boundary

Fiber Paid HTTP Evidence Console owns:

- Visual proof flow for a single machine-payment scenario.
- Report and vector evidence presentation.
- Replay-attack demonstration.
- Local Fiber route context for the payment used in the evidence.
- Clear Rust canonical engine positioning.

Fiber Paid HTTP Evidence Console does not own:

- Fiber node monitoring, liquidity analytics, channel management, or network topology dashboards.
- Wallet management, invoice management, checkout UX, merchant payment widgets, or payer account UX.
- AI inference marketplace UX, model routing, paid access marketplace flows, or robot demos as primary product features.
- `fiber-pay` GUI behavior or CLI replacement behavior.
- Production readiness claims.

Nearby-project distinction:

```text
Fiber Dashboard = observe Fiber network state
fiber-pay       = let AI/CLI operate Fiber
fiber-checkout  = merchant checkout component
FiberLatch      = paid access control product surface
Infern          = AI inference marketplace

Fiber Paid HTTP Console = visualize one machine-payment proof flow
```

## Core Message

The first viewport should communicate:

```text
Fiber Paid HTTP Evidence Console
Machine Payments Protocol over Fiber
```

The visible claim should be evidence-oriented:

```text
Rust canonical engine: passed
TS vector harness: passed
Local Fiber E2E: passed
F402 compatibility: passed
Production ready: true only when testnet, operations, and production bootstrap evidence are present
```

`production_ready_for_fiber_method` is read from the gate report. It must remain `false` unless separate testnet Fiber E2E evidence, passing operations gates, and production bootstrap E2E readiness evidence are all present.

## Information Architecture

Use a single cockpit-style page as the primary experience, with lightweight tabs or routes for deeper drilldown:

```text
/
/flow
/evidence
/attacks
```

The main `/flow` page is a three-column evidence console:

```text
Header
  product mark
  status badges
  Rust canonical engine vs TypeScript compatibility tooling indicator

Left column
  Request / Scenario
  Local Fiber Network context

Center column
  Protocol Flow Timeline

Right column
  Evidence & Reports drawer
  Attack Replay panel
  Report parity summary

Bottom band
  Terminal / Event Log
  Robot/API service status indicator
```

## Main Console Layout

### Header

The header should establish that the console is about protocol evidence, not payment checkout.

Required elements:

- `Fiber Paid HTTP Evidence Console`
- Subtitle: `Machine Payments Protocol over Fiber`
- Status badges sourced from reports:
  - Rust canonical engine
  - TS vector harness
  - Local Fiber E2E
  - F402 compatibility
  - Production ready
- Engine stance:

```text
Rust (Canonical Engine) <-> TypeScript (Compatibility Tooling)
```

The TypeScript label must not imply a production trusted boundary.

### Left Column: Request / Scenario

Show the selected machine request and the payment context:

```text
GET /paid/protocol-service
price: 100 CKB
method: Fiber
challenge id: chal_...
resource hash: ...
route: node1 -> node2 -> node3 (only when live local/testnet is configured or local evidence exists)
```

Required controls:

- `Send unpaid request`
- `Pay with Fiber`
- `Retry with Authorization: Payment`
- `Replay same credential`

Controls should drive protocol state, not expose raw Fiber wallet/node operations.

Secondary scenario rows may exist for protocol examples:

- `GET /paid/weather`
- `GET /paid/mpp-tool`
- `GET /paid/file`

They should remain examples of paid HTTP resources, not product modules.

### Local Fiber Network Context

Show only the local route context needed to understand the proof:

```text
node1 payer  : 127.0.0.1:21714
node2 router : 127.0.0.1:21715
node3 payee  : 127.0.0.1:21716
route        : node1 -> node2 -> node3
channel count: 2 (from local E2E evidence report) or not polled
route status : live configured / evidence recorded / not configured
```

Do not add channel open/close controls, balance charts, liquidity graphs, mempool panels, or network-wide observability.

The widget must show the source of route and channel fields. A saved evidence view may show the recorded local E2E route as historical evidence, but it must not label it as live network state. If live Fiber env vars are missing, the console should display `unconfigured` or `evidence recorded`, not `connected`.

### Center Column: Protocol Flow Timeline

This is the hero interaction. It should animate the exact sequence:

```text
Client
  -> GET /paid-resource
Server
  -> 402 Payment Required
Fiber Node A
  -> send_payment
Fiber Node B / C
  -> payment settled
Client
  -> Authorization: Payment
Server
  -> Payment-Receipt
Protected API
  -> service executed
Client
  -> replay same credential
Server
  -> replay rejected
```

Each step has:

- Actor icon.
- Event label.
- Evidence snippet.
- Status: `idle`, `running`, `passed`, `failed`, `blocked`, or `rejected`.
- Timestamp.
- Optional link into the evidence drawer.

Recommended timeline states:

```text
idle
unpaid_request_sent
challenge_received
invoice_observed
payment_sent
payment_settled
authorization_retry_sent
receipt_returned
service_executed
replay_attempted
replay_rejected
failed
```

The success path turns green/teal. Replay rejection should be red/orange but treated as a successful security outcome.

When live Fiber is not configured, payment steps should say `Live Fiber required` and `No payment executed`. `Fiber Node B / C` and routed-settlement language is reserved for live local/testnet proofs whose payment proof mode is `local` or `testnet`.

### Right Column: Evidence & Reports

The evidence drawer should show real artifacts without dumping giant JSON by default.

Tabs:

- `Chain Data (JSON)`
- `Payment Receipt`
- `Security Matrix`
- `Canonical Parity`
- `Local Fiber Evidence`

Required fields:

```text
challenge_id
resource
method
amount
route
resource_hash
payment_hash
receipt_id
canonical_hash
engine: rust
vector parity: passed
error code parity: true
f402 parity: true
replay status: rejected
production_ready_for_fiber_method: report-driven
```

Report artifacts to surface:

```text
reports/canonical-core-parity.json
reports/fiber-local-e2e-evidence.json
reports/fiber-paid-http-gate.local.json
reports/fiber-paid-http-gate.default.json
reports/fiber-paid-http-rust-gate.json
reports/fiber-paid-http-ts-gate.json
reports/security-matrix.json
```

The UI should summarize reports with drilldown JSON, not make JSON the primary visual.

### Attack Replay Panel

Attack replay should be visible in the main console, not buried.

Required output:

```text
status: replay rejected
reason: receipt not reused
receipt_id: ...
payment_hash: ...
protected service: not re-executed
receipt reissued: false
```

The panel should make it obvious that replay rejection is a pass condition.

### Terminal / Event Log

The bottom terminal band should show a compact chronological trace:

```text
[10:21:30.123] INFO client GET /paid/protocol-service
[10:21:30.151] INFO server 402 issued challenge=...
[10:21:30.481] INFO payer invoice created payment_hash=...
[10:21:31.102] ERROR server live Fiber not configured HTTP 503
[10:21:31.347] INFO server payment verified receipt_id=...
[10:21:31.789] WARN server replay rejected reason=not_reused
```

The log should be generated from flow state and evidence reports. It must not imply live Fiber activity when the console is displaying report-only evidence.

## Visual Direction

The console should look like an industrial protocol cockpit:

- Dark mode by default.
- Deep blue-black background with cyan/teal Fiber accents.
- Monospace numbers, hashes, timestamps, and report filenames.
- Green status chips for passed evidence.
- Orange/red chips for failed or rejected attack attempts.
- Thin borders, dense panels, stable grid dimensions.
- Animated protocol path, not animated marketing decoration.
- Small network route graph for local route only.
- JSON viewer with line numbers, copy buttons, and selected-field highlighting.
- Terminal panel with severity coloring.

Avoid:

- Web3/DeFi gradients as the main style.
- Wallet metaphors.
- Checkout page composition.
- Giant landing-page hero sections.
- Fiber network dashboard charts.
- Decorative orbs, bokeh backgrounds, or generic token graphics.

Fancy comes from evidence motion, timing, state transitions, and verifiable artifacts.

## Data Sources

The console should prefer existing Fiber Paid HTTP evidence:

```text
reports/canonical-core-parity.json
reports/fiber-local-e2e-evidence.json
reports/fiber-paid-http-gate.local.json
reports/fiber-paid-http-gate.default.json
reports/fiber-paid-http-rust-gate.json
reports/fiber-paid-http-ts-gate.json
reports/security-matrix.json
test-vectors/*.json
```

If live local Fiber env vars are absent, the UI must show `unconfigured` status or skipped blockers clearly and must not execute payment.

If live local Fiber env vars are present, the UI may call the local evidence API to run the flow:

```text
RUN_FIBER_E2E=1
FIBER_MODE=local
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714
FIBER_CURRENCY=<target Fiber RPC currency code>
FIBER_E2E_AMOUNT_SHANNONS=100
```

The frontend price unit remains `CKB`; Fiber RPC currency codes are runtime adapter configuration, not UI pricing labels.

Do not hide the mode. The console should display `mode: unconfigured`, `mode: local`, or `mode: testnet`.

## API Plan

The frontend should stay thin. A local evidence API can expose only evidence and scenario endpoints:

```text
GET  /api/status
POST /api/evidence/unpaid
POST /api/evidence/pay
POST /api/evidence/retry
POST /api/evidence/replay
POST /api/evidence/reset
GET  /api/reports/canonical
GET  /api/reports/fiber-local
GET  /api/reports/gate-local
GET  /api/reports/gate-default
GET  /api/reports/rust-gate
GET  /api/reports/ts-gate
GET  /api/reports/security
```

Endpoint responsibilities:

- `/api/status`: expose mode, engine, report availability, blockers, and production-ready status.
- `/api/evidence/unpaid`: request protected resource and return the 402 challenge evidence.
- `/api/evidence/pay`: perform the Fiber payment step only when local/testnet Fiber RPC is configured; otherwise return a blocker.
- `/api/evidence/retry`: retry with `Authorization: Payment` and return receipt evidence.
- `/api/evidence/replay`: replay the last credential and return rejection evidence.
- `/api/evidence/reset`: clear the current server-side evidence flow so UI reset controls are not local-only theatre.
- `/api/reports/*`: serve sanitized report summaries plus optional raw JSON.

The API should call Fiber Paid HTTP directly. Do not route the primary evidence path through `fiber-pay`.

Preferred payment path:

```text
Fiber Paid HTTP canonical engine -> Fiber JSON-RPC
```

Future optional client adapter:

```text
Fiber Paid HTTP client -> fiber-pay
```

That future adapter must be visibly labeled as optional and outside the canonical proof path.

## Component Plan

Suggested component tree:

```text
apps/evidence-web/
  src/
    App.tsx
    routes/
      Overview.tsx
      Flow.tsx
      Evidence.tsx
      Attacks.tsx
    components/
      AppShell.tsx
      StatusBadge.tsx
      RequestScenarioPanel.tsx
      FlowTimeline.tsx
      TimelineStep.tsx
      FiberRouteGraph.tsx
      EvidenceDrawer.tsx
      JsonViewer.tsx
      ReportArtifactList.tsx
      AttackReplayPanel.tsx
      TerminalLog.tsx
      RobotApiStatus.tsx
      EngineBoundary.tsx
    lib/
      api.ts
      evidence.ts
      flow-state.ts
      report-normalizers.ts
```

The existing static `apps/evidence-web/index.html` can remain as a fallback, but the fancy console will be easier to maintain as a small Vite/React app or equivalent componentized frontend.

## Interaction Flow

Button sequence:

```text
1. Send unpaid request
   -> timeline step 1 starts
   -> 402 challenge appears
   -> evidence drawer highlights challenge JSON

2. Pay with Fiber
   -> invoice/payment hash appears
   -> route graph animates node1 -> node2 -> node3 only in live local/testnet mode
   -> unconfigured mode blocks payment execution without route-node animation
   -> settlement status becomes passed

3. Retry with Authorization: Payment
   -> receipt appears
   -> service execution status turns passed
   -> canonical receipt hash appears

4. Replay same credential
   -> replay branch animates
   -> attack panel turns rejected
   -> service execution remains not repeated
```

The console should allow reset to replay the animation without mutating evidence.

## Evidence Rules

The UI must not fabricate successful evidence.

Rules:

- Show `passed` only when report fields say passed.
- Show `skipped` with exact blockers when live Fiber env vars are missing.
- Show local Fiber E2E as `passed` only from `reports/fiber-paid-http-gate.local.json` or `reports/fiber-local-e2e-evidence.json`.
- Show production ready as `false` unless report explicitly says otherwise and blockers are empty.
- Show TypeScript as `Compatibility Tooling`, never as backup production verifier.
- Show Rust as `Canonical Engine`.

## Security Matrix View

The security view should summarize:

```text
attack
expected rejection
implemented test
vector file
status
```

Minimum attacks:

- Replay.
- Wrong resource.
- Wrong amount.
- Wrong method.
- Expired challenge.
- Tampered receipt.

Each row should deep-link to the matching vector and test evidence.

## Accessibility And Responsiveness

The console must work on desktop first, with a usable tablet/mobile fallback.

Requirements:

- No text overlap at 1440px, 1280px, 1024px, and 390px widths.
- Hashes truncate in the middle with copy buttons.
- Timeline can collapse into vertical single-column mode on narrow screens.
- Buttons keep stable dimensions while status changes.
- Color is never the only signal; include text labels and icons.
- Keyboard reachable controls.
- Reduced-motion mode disables timeline animation and uses instant state changes.

## Implementation Phases

### Phase 1: Report-Only Evidence Console

Goal: make existing reports look impressive and audit-friendly.

Tasks:

- Replace the current simple page with the three-column evidence console.
- Load local report JSON from the evidence API or bundled fixture endpoint.
- Animate the timeline from existing evidence.
- Render status badges, evidence drawer, report list, security matrix, and replay panel.
- Keep all claims report-backed.

### Phase 2: Local Evidence API State Machine

Goal: make buttons drive the existing local proof flow semantics.

Tasks:

- Add the minimal `/api/evidence/*` endpoints.
- Return structured flow events.
- Keep payment execution blocked when live Fiber env vars are absent.
- Gate local live payment mode behind explicit env vars.

### Phase 3: Live Local Fiber Mode

Goal: run the local 3-node Fiber E2E path from the console when configured.

Tasks:

- Surface local mode from `/api/status`.
- Run unpaid request, pay, retry, and replay through existing Fiber Paid HTTP code.
- Update timeline as events complete.
- Persist latest local evidence report.
- Keep `production_ready_for_fiber_method` report-driven; local-only evidence must not set it true.

### Phase 4: Polish And Judge Mode

Goal: make the console presentation-ready.

Tasks:

- Add deterministic animation playback.
- Add one-click evidence export summary.
- Add keyboard shortcuts only if they do not clutter the UI.
- Add screenshot-friendly state presets.
- Add visual QA across desktop and mobile.

## Acceptance Criteria

The frontend is ready when:

- The first screen clearly says `Fiber Paid HTTP Evidence Console`.
- The primary visual shows the full `402 -> Fiber payment -> receipt -> replay rejection` flow.
- The evidence drawer surfaces actual report fields.
- Replay rejection is visible and treated as a security pass.
- Rust is shown as the canonical engine.
- TypeScript is shown as compatibility/vector tooling.
- Production ready matches the gate report, with blockers visible whenever it is false.
- No Fiber node dashboard, wallet, checkout, or `fiber-pay` GUI behavior is present.
- The console can show report-only evidence with no live Fiber nodes, while payment execution remains blocked.
- The console can run live local mode when env vars are configured.
- `pnpm --filter @fiber-paid-http/evidence-web check-layout` passes across 1440px, 1024px, and 390px viewports with no horizontal overflow or Evidence tab jitter.
- The production gate records `evidence_console_layout: true` and leaves `evidence_console_layout_blockers` empty.
- The production gate records `fiber_paid_http_gate_ready: true`; if layout fails, `fiber_paid_http_gate_blockers` names the layout report even if Fiber method readiness remains true.
- The UI is polished enough to communicate the evidence chain from a screenshot without needing narration.

## Non-Blocking Future Ideas

These are optional and should not be part of the hackathon-critical path:

- Optional adapter that delegates client-side payment execution to `fiber-pay`.
- Testnet evidence mode after separate testnet Fiber E2E evidence exists.
- Read-only link to an external Fiber Network Dashboard for deeper network inspection.
- Exportable evidence bundle for auditors.

None of these should change the canonical path:

```text
Rust canonical core -> Fiber JSON-RPC adapter -> evidence reports -> console visualization
```
