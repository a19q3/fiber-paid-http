import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { fallbackEndpoints, personaActionReason } from "../constants.js";
import { short, copyTextToClipboard } from "../lib/utils.js";

interface TimelineStep {
  actor: string;
  label: string;
  snippet: string;
  status: string;
  statusLabel: string;
  time?: string;
  icon: string;
  current?: boolean;
}

const PHASE_ORDER = ["idle", "unpaid_request_sent", "challenge_received", "payment_settled", "receipt_returned", "replay_rejected"];

function hasPhase(current: string, target: string): boolean {
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target);
}

function eventTime(events: { time: string; message: string; detail?: string }[], needle: string): string | undefined {
  const event = events.find((item) => `${item.message} ${item.detail || ""}`.toLowerCase().includes(needle.toLowerCase()));
  return event ? event.time.slice(11, 23) : undefined;
}

function flowChallengeId(flow: { challengeId?: string; challengeBody?: { challengeId?: string; challenge?: { challengeId?: string } } | null }): string | undefined {
  return flow.challengeId || flow.challengeBody?.challengeId || flow.challengeBody?.challenge?.challengeId;
}

function flowResourceHash(flow: { resourceHash?: string; credential?: { resourceHash?: string } | null; challengeBody?: { resourceHash?: string } | null }): string | undefined {
  return flow.resourceHash || flow.credential?.resourceHash || flow.challengeBody?.resourceHash;
}

function isLiveFiberFlow(flow: { proof?: { mode?: string } | null; fiberChallenge?: unknown | null }, status?: { livePaymentEnabled?: boolean; mode?: string }): boolean {
  if (flow.fiberChallenge) return true;
  const mode = flow.proof?.mode || (status?.livePaymentEnabled ? status?.mode : undefined);
  return mode === "local" || mode === "testnet";
}

export function Timeline() {
  const ev = useEvidence();
  const challengeId = flowChallengeId(ev.flow);
  const paymentHash = ev.flow?.fiberChallenge?.paymentHash || ev.flow?.receipt?.reference;
  const receiptReference = ev.flow?.receipt?.reference;
  const events = ev.flow?.events || [];
  const liveFiberFlow = isLiveFiberFlow(ev.flow, ev.status || undefined);
  const proofMode = ev.flow?.proof?.mode || ev.status?.mode || "unconfigured";

  const mkStep = (actor: string, label: string, snippet: string, passed: boolean, icon: string, time?: string): TimelineStep => ({
    actor, label, snippet: snippet || "pending", status: passed ? "passed" : "idle", statusLabel: passed ? "passed" : "idle", time, icon,
  });

  const steps: TimelineStep[] = [
    mkStep("CLIENT / AGENT", "Request paid resource", `GET ${ev.selected}`, hasPhase(ev.phase, "challenge_received"), "ActorClient", eventTime(events, "GET")),
    mkStep("SERVER", "402 Payment Required", `challenge: ${short(challengeId)}`, hasPhase(ev.phase, "challenge_received"), "ActorServer", eventTime(events, "402")),
    mkStep(liveFiberFlow ? "PAYER FNN" : "FIBER METHOD", liveFiberFlow ? "Authorize & send invoice payment" : "Live Fiber required", `send_payment · ${short(paymentHash)}`, hasPhase(ev.phase, "payment_settled"), "ActorFiber", eventTime(events, liveFiberFlow ? "send_payment" : "payment proof")),
    mkStep(liveFiberFlow ? "FIBER NETWORK" : "METHOD VERIFIER", liveFiberFlow ? "Observe settlement" : "No payment executed", liveFiberFlow ? "payment Success · invoice Paid" : `mode: ${proofMode}`, hasPhase(ev.phase, "payment_settled"), "ActorFiber", eventTime(events, liveFiberFlow ? "payment payload returned" : "live Fiber")),
    mkStep("CLIENT / AGENT", "Resume request with payment credential", `Authorization: Payment · ${short(paymentHash)}`, hasPhase(ev.phase, "receipt_returned"), "ActorClient", eventTime(events, "continue with Authorization")),
    mkStep("SERVER", "Verify payment credential", `receipt_reference: ${short(receiptReference)}`, hasPhase(ev.phase, "receipt_returned"), "ActorServer", eventTime(events, "payment verified")),
    mkStep("PROTECTED API", "Execute protected service", "HTTP 200 OK", hasPhase(ev.phase, "receipt_returned"), "ActorProtectedApi", eventTime(events, "service executed")),
    mkStep("SERVER", "Return response + Payment-Receipt", `receipt_reference: ${short(receiptReference)}`, hasPhase(ev.phase, "receipt_returned"), "ActorServer", eventTime(events, "Payment-Receipt returned")),
  ];

  if (!hasPhase(ev.phase, "receipt_returned")) {
    const idx = steps.findIndex((s) => s.status === "idle");
    if (idx >= 0) {
      steps[idx]!.current = true;
      if (ev.busy) { steps[idx]!.status = "running"; steps[idx]!.statusLabel = "running"; }
    }
  }

  return (
    <div className="timeline" id="timeline" role="list" aria-label="MPP payment transaction sequence">
      {steps.map((step, i) => {
        const status = step.status === "passed" ? "passed" : step.status === "rejected" ? "rejected" : step.status === "running" ? "running" : "";
        return (
          <div className={"timeline-row" + (status ? " " + status : "") + (step.current ? " current" : "")} role="listitem" key={i}>
            <div className="timeline-actor"><Icon name={step.icon as never} /> <span>{step.actor}</span></div>
            <div className="timeline-rail"><span className="num">{i + 1}</span></div>
            <div className="timeline-desc"><strong>{step.label}</strong><span className="snippet">{step.snippet}</span></div>
            <div className={"step-status " + status}>{step.statusLabel}<span>{step.time || "--:--:--"}</span></div>
          </div>
        );
      })}
    </div>
  );
}

export function FlowView() {
  const ev = useEvidence();
  const endpoints = ev.status?.endpoints || fallbackEndpoints;
  const selected = endpoints.find((e) => e.path === ev.selected) || fallbackEndpoints[0]!;
  const challengeId = flowChallengeId(ev.flow) || "pending";
  const resourceHash = flowResourceHash(ev.flow) || "pending";
  const routeValue = ev.status?.localFiberNetwork?.route;
  const route = Array.isArray(routeValue) ? routeValue.map((name) => String(name)) : [];
  const apiUnavailable = ev.status?.mode === "api-unreachable";
  const guidedMode = ev.flowMode === "guided";

  const profileReason = (() => {
    for (const role of ["payer", "payee", "gateway"] as const) {
      const cap = ev.configuration?.executionRoleCapabilities?.[role];
      if (cap && !cap.liveExecution) return `${cap.label} is not live executable: ${cap.blockers?.[0] || "blocked"}`;
    }
    const profiles = (["payer", "payee", "gateway"] as const).map((r) => ev.configuration?.profiles?.[r]?.find((p) => p.id === ev.profileSelection[r])).filter(Boolean);
    const reportProfile = profiles.find((p) => p?.source === "report");
    if (reportProfile) return "Recorded evidence profiles can be exported, but only env-backed or UI runtime-backed profiles can execute a payment flow.";
    return "";
  })();

  const validationReason = ev.validation.ok ? "" : ev.validation.message;
  const sendReason = personaActionReason(ev.persona, "send") || (apiUnavailable ? "Evidence API unreachable." : validationReason || profileReason);
  const paymentComplete = Boolean(ev.flow?.receipt);
  const replayRejected = ev.flow?.replayStatus === 402;
  const replayAttempted = typeof ev.flow?.replayStatus === "number";
  const replayFailed = replayAttempted && !replayRejected;
  const payReason = personaActionReason(ev.persona, "pay") || (apiUnavailable ? "Evidence API unreachable." : validationReason || profileReason || (!ev.flow?.fiberChallenge ? "Send an unpaid request to receive a Fiber challenge first." : ev.flow?.authorization ? "Fiber payment is already settled for this challenge." : ""));
  const continueReason = personaActionReason(ev.persona, "continue") || (apiUnavailable ? "Evidence API unreachable." : !ev.flow?.authorization ? "Pay with Fiber to create an Authorization: Payment credential first." : paymentComplete ? "Payment and service delivery are already complete." : "");
  const replayReason = personaActionReason(ev.persona, "replay") || (apiUnavailable ? "Evidence API unreachable." : !paymentComplete ? "Complete the authenticated request and receive Payment-Receipt first." : replayRejected ? "Replay protection is already verified for this credential." : "");
  const hintReason = [sendReason, payReason, guidedMode ? "" : continueReason].filter(Boolean)[0] || "";
  const deliveryPending = Boolean(ev.flow?.authorization) && !paymentComplete;

  let hintTone = "warn";
  let hintText = hintReason || "Ready to send the unpaid request.";
  if (ev.actionError) { hintTone = "fail"; hintText = ev.actionError; }
  else if (paymentComplete) { hintTone = "pass"; hintText = "Payment complete: protected service delivered and receipt returned."; }
  else if (deliveryPending) {
    hintTone = ev.busy ? "pass" : "warn";
    hintText = guidedMode
      ? ev.busy ? "Payment settled; the SDK is resuming the protected request." : "Payment settled, but delivery did not finish. Resume delivery without paying again."
      : "Payment settled. Continue with the credential in Manual Protocol mode.";
  }
  else if (ev.flow?.fiberChallenge) { hintTone = ev.status?.livePaymentEnabled ? "pass" : "warn"; hintText = ev.status?.livePaymentEnabled ? guidedMode ? "Challenge ready. Confirm payment; the SDK will resume the request automatically." : "Challenge ready. Execute the payer step, then continue manually with the credential." : "Challenge present, but this process is not live Fiber ready."; }
  else if (apiUnavailable) { hintTone = "fail"; hintText = "Evidence API unreachable; controls are disabled."; }

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="Timeline" /> Protocol Flow</div>
        <div className="btn-row">
          <button className="btn" onClick={() => ev.copyEnv()} disabled={ev.busy} title="Copy environment template">
            <Icon name="Copy" /> Copy env
          </button>
          <button className="btn" onClick={() => ev.exportEvidence()} disabled={ev.busy || apiUnavailable}>
            <Icon name="Evidence" /> Export
          </button>
          <button className="btn" onClick={() => ev.setSettingsOpen(true)}>
            <Icon name="Settings" /> Configure
          </button>
        </div>
      </div>

      <div className="panel request-panel" data-panel-id="request">
        <div className="panel-title"><Icon name="RequestScenario" /> Request / Scenario</div>
        <div className="panel-body">
          <div className="resource-card">
            <div className="kv">
              <div className="kv-row">
                <span className="kv-label"><Icon name="RequestScenario" />Resource</span>
                <code id="selected-label" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{selected.label}</code>
                <span className="chip cyan selected-chip">selected</span>
              </div>
              <div className="kv-row">
                <span className="kv-label"><Icon name="Price" />Price</span>
                <strong id="price">{ev.parameters.amountCkb} CKB</strong>
                <button className="copy-btn" data-copy={`${ev.parameters.amountCkb} CKB`} onClick={async () => { await copyTextToClipboard(`${ev.parameters.amountCkb} CKB`); }} aria-label="Copy price"><Icon name="Copy" /></button>
              </div>
              <div className="kv-row">
                <span className="kv-label"><Icon name="Method" />Method</span>
                <strong>Fiber</strong>
              </div>
              <div className="kv-row">
                <span className="kv-label"><Icon name="ResourceHash" />Challenge ID</span>
                <strong id="challenge-id">{challengeId}</strong>
                <button className="copy-btn" data-copy-target="challenge-id" onClick={async () => { await copyTextToClipboard(challengeId); }} aria-label="Copy challenge ID"><Icon name="Copy" /></button>
              </div>
              <div className="kv-row">
                <span className="kv-label"><Icon name="ResourceHash" />Resource Hash</span>
                <strong id="resource-hash">{resourceHash}</strong>
                <button className="copy-btn" data-copy-target="resource-hash" onClick={async () => { await copyTextToClipboard(resourceHash); }} aria-label="Copy resource hash"><Icon name="Copy" /></button>
              </div>
              <div className="kv-row">
                <span className="kv-label"><Icon name="Route" />Route</span>
                <div className="route-chips" id="route-chips">
                  {route.length ? route.map((name, i) => <span key={i}>{name}</span>) : <span>no live route</span>}
                </div>
              </div>
            </div>
          </div>

          <div className="scenario-list" id="scenarios">
            {endpoints.filter((e) => e.path !== ev.selected).map((ep) => (
              <button key={ep.path} className="scenario-btn scenario" disabled={ev.busy} onClick={async () => {
                ev.setSelected(ep.path);
                ev.setAmountShannons(ep.charge.amount);
                await ev.resetEvidenceFlow("resource selected");
              }}>
                <Icon name="RequestScenario" />
                <span>{ep.label}</span>
                <span>{ep.charge.display}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="purchase-action">
          <div className="flow-mode-switch" role="group" aria-label="Evidence flow mode">
            <span>Run mode</span>
            <button id="flow-mode-guided" className={guidedMode ? "active" : ""} aria-pressed={guidedMode} disabled={ev.busy} onClick={() => ev.setFlowMode("guided")}>Guided demo</button>
            <button id="flow-mode-manual" className={!guidedMode ? "active" : ""} aria-pressed={!guidedMode} disabled={ev.busy} onClick={() => ev.setFlowMode("manual")}>Manual protocol</button>
          </div>
          <div className="protocol-run-context">
            <span>{guidedMode ? "Video-ready guided flow" : "Protocol debugger · not product SOP"}</span>
            <p>{guidedMode ? "Two intentional actions: request the resource, then approve payment. The SDK resumes delivery automatically." : "Exposes credential continuation as a separate step for protocol inspection and troubleshooting."}</p>
          </div>
          <div className={`actions protocol-action-grid ${guidedMode ? "guided" : "manual"}`} id="flow-actions">
            <button className={"btn protocol-action-step" + (ev.activeAction === "unpaid" ? " is-busy" : "")} id="send" disabled={ev.busy || Boolean(sendReason)} onClick={() => ev.runAction("unpaid")}>
              <span className="protocol-step-index">1</span>
              <Icon name="ActionSend" />
              <span className="protocol-step-copy"><small>Client / AI Agent</small><strong>{ev.activeAction === "unpaid" ? "Requesting…" : "Request paid resource"}</strong><em>Unauthenticated HTTP request</em></span>
              <span className="key">Ctrl+U</span>
            </button>
            <button className={"btn primary protocol-action-step" + (ev.activeAction === "pay" ? " is-busy" : "")} id="pay" disabled={ev.busy || Boolean(payReason)} onClick={() => ev.runAction("pay")}>
              <span className="protocol-step-index">2</span>
              <Icon name="ActionPay" />
              <span className="protocol-step-copy"><small>Payer FNN · Wallet</small><strong>{ev.activeAction === "pay" ? ev.phase === "payment_settled" ? "Delivering protected response…" : "Paying through Payer FNN…" : "Pay with Fiber"}</strong><em>{guidedMode ? "Pay once; SDK resumes delivery" : "Authorize and send invoice payment"}</em></span>
              <span className="key">Ctrl+P</span>
            </button>
            {!guidedMode && (
              <button className={"btn protocol-action-step" + (ev.activeAction === "continue" ? " is-busy" : "")} id="continue" disabled={ev.busy || Boolean(continueReason)} onClick={() => ev.runAction("continue")}>
                <span className="protocol-step-index">3</span>
                <Icon name="ActionRetry" />
                <span className="protocol-step-copy"><small>Client / AI Agent · Debug</small><strong>{ev.activeAction === "continue" ? "Continuing with credential…" : "Continue with credential"}</strong><em>Manual protocol inspection only</em></span>
                <span className="key">Ctrl+R</span>
              </button>
            )}
            {guidedMode && deliveryPending && !ev.busy && (
              <button className="btn protocol-action-step recovery" id="resume-delivery" disabled={Boolean(continueReason)} onClick={() => ev.runAction("continue")}>
                <span className="protocol-step-index">↻</span>
                <Icon name="ActionRetry" />
                <span className="protocol-step-copy"><small>Recovery · no new payment</small><strong>Resume delivery</strong><em>Reuse the settled credential</em></span>
              </button>
            )}
          </div>
          <div className={"action-hint " + hintTone} id="action-hint">
            <Icon name={hintTone === "pass" ? "StatusPassed" : hintTone === "fail" ? "StatusFailed" : "StatusUnavailable"} />
            <span>{hintText}</span>
          </div>
        </div>
      </div>

      <div className="panel timeline-panel" data-panel-id="timeline">
        <div className="panel-title">
          <Icon name="Timeline" /> MPP payment flow
          <span className={"chip " + (paymentComplete ? "green" : "orange")} id="payment-completion-state">
            {paymentComplete ? "COMPLETE" : "IN PROGRESS"}
          </span>
        </div>
        <div className="panel-body">
          <Timeline />
          <section className={"security-check " + (replayRejected ? "verified" : replayFailed ? "failed" : paymentComplete ? "ready" : "locked")} id="replay-security-check" aria-labelledby="replay-security-title">
            <div className="security-check-copy">
              <span>Post-transaction security check · optional</span>
              <strong id="replay-security-title">Single-use credential replay protection</strong>
              <p>
                {replayRejected
                  ? "Verified: reusing the consumed credential returned HTTP 402 without reissuing a receipt or executing the service."
                  : replayFailed
                    ? `Expected HTTP 402, but the replay request returned HTTP ${ev.flow?.replayStatus}. Inspect the event log.`
                    : paymentComplete
                      ? "The payment transaction is already complete. Run this separate check to prove the consumed credential cannot be reused."
                      : "Locked until the authenticated request returns Payment-Receipt and completes service delivery."}
              </p>
            </div>
            <span className={"chip " + (replayRejected ? "green" : replayFailed ? "red" : paymentComplete ? "cyan" : "orange")} id="replay-security-state">
              {replayRejected ? "VERIFIED" : replayFailed ? "FAILED" : paymentComplete ? "READY" : "LOCKED"}
            </span>
            <button className="btn" id="replay" disabled={ev.busy || Boolean(replayReason)} onClick={() => ev.runAction("replay")} title={replayReason || "Send the consumed credential again and expect HTTP 402"}>
              <Icon name="ActionReplay" /><span>Test replay protection</span><span className="key">Ctrl+Y</span>
            </button>
          </section>
        </div>
      </div>
    </>
  );
}
