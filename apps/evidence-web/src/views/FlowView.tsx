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

function flowResourceHash(flow: { resourceHash?: string; credential?: { resourceHash?: string } | null; receipt?: { resourceHash?: string } | null; challengeBody?: { resourceHash?: string } | null }): string | undefined {
  return flow.resourceHash || flow.credential?.resourceHash || flow.receipt?.resourceHash || flow.challengeBody?.resourceHash;
}

function isLiveFiberFlow(flow: { proof?: { mode?: string } | null }, status?: { livePaymentEnabled?: boolean; mode?: string }): boolean {
  const mode = flow.proof?.mode || (status?.livePaymentEnabled ? status?.mode : undefined);
  return mode === "local" || mode === "testnet";
}

export function Timeline() {
  const ev = useEvidence();
  const challengeId = flowChallengeId(ev.flow);
  const paymentHash = ev.flow?.fiberChallenge?.paymentHash || ev.flow?.receipt?.settlement?.paymentHash;
  const receiptId = ev.flow?.receipt?.receiptId;
  const events = ev.flow?.events || [];
  const liveFiberFlow = isLiveFiberFlow(ev.flow, ev.status || undefined);
  const proofMode = ev.flow?.proof?.mode || ev.status?.mode || "unconfigured";

  const mkStep = (actor: string, label: string, snippet: string, passed: boolean, icon: string, time?: string): TimelineStep => ({
    actor, label, snippet: snippet || "pending", status: passed ? "passed" : "idle", statusLabel: passed ? "passed" : "idle", time, icon,
  });

  let steps: TimelineStep[] = [
    mkStep("CLIENT", "GET /paid/*resource", ev.selected, hasPhase(ev.phase, "challenge_received"), "ActorClient", eventTime(events, "GET")),
    mkStep("SERVER", "402 Payment Required", `challenge: ${short(challengeId)}`, hasPhase(ev.phase, "challenge_received"), "ActorServer", eventTime(events, "402")),
    mkStep(liveFiberFlow ? "FIBER RPC" : "FIBER METHOD", liveFiberFlow ? "send_payment (invoice)" : "Live Fiber required", `payment_hash: ${short(paymentHash)}`, hasPhase(ev.phase, "payment_settled"), "ActorFiber", eventTime(events, liveFiberFlow ? "send_payment" : "payment proof")),
    mkStep(liveFiberFlow ? "SETTLEMENT PROOF" : "METHOD VERIFIER", liveFiberFlow ? "Settlement observed" : "No payment executed", liveFiberFlow ? "settlement: success" : `mode: ${proofMode}`, hasPhase(ev.phase, "payment_settled"), "ActorFiber", eventTime(events, liveFiberFlow ? "payment proof returned" : "live Fiber")),
    mkStep("CLIENT", "Retry with Authorization: Payment", `payment_hash: ${short(paymentHash)}`, hasPhase(ev.phase, "receipt_returned"), "ActorClient", eventTime(events, "retry")),
    mkStep("SERVER", "Verify Payment & Receipt", `receipt_id: ${short(receiptId)}`, hasPhase(ev.phase, "receipt_returned"), "ActorServer", eventTime(events, "payment verified")),
    mkStep("SERVER", "Payment-Receipt Returned", `receipt_id: ${short(receiptId)}`, hasPhase(ev.phase, "receipt_returned"), "ActorServer", eventTime(events, "service executed")),
    mkStep("PROTECTED API", "Service executed", "HTTP 200 OK", hasPhase(ev.phase, "receipt_returned"), "ActorProtectedApi", eventTime(events, "service executed")),
    {
      actor: "CLIENT", label: "Replay same credential", snippet: `receipt_id: ${short(receiptId)}`,
      status: hasPhase(ev.phase, "replay_rejected") ? "rejected" : ev.busy && ev.phase === ("replay_attempted" as never) ? "running" : "idle",
      statusLabel: hasPhase(ev.phase, "replay_rejected") ? "replay rejected" : "idle",
      time: eventTime(events, "replay rejected"), icon: "ActorClient",
    },
  ];

  if (ev.phase !== "replay_rejected") {
    const idx = steps.findIndex((s) => s.status === "idle");
    if (idx >= 0) {
      steps[idx]!.current = true;
      if (ev.busy) { steps[idx]!.status = "running"; steps[idx]!.statusLabel = "running"; }
    }
  }

  return (
    <div className="timeline" id="timeline" role="list" aria-label="Protocol payment evidence sequence">
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
  const payReason = personaActionReason(ev.persona, "pay") || (apiUnavailable ? "Evidence API unreachable." : validationReason || profileReason || (!ev.flow?.fiberChallenge ? "Send an unpaid request to receive a Fiber challenge first." : ""));
  const retryReason = personaActionReason(ev.persona, "retry") || (apiUnavailable ? "Evidence API unreachable." : !ev.flow?.authorization ? "Pay with Fiber to create an Authorization: Payment credential first." : "");
  const replayReason = personaActionReason(ev.persona, "replay") || (apiUnavailable ? "Evidence API unreachable." : !ev.flow?.authorization ? "A replay needs the same paid credential." : "");
  const hintReason = [sendReason, payReason, retryReason, replayReason].filter(Boolean)[0] || "";

  const replayRejected = ev.flow?.replayStatus === 402;
  let hintTone = "warn";
  let hintText = hintReason || "Ready to send the unpaid request.";
  if (replayRejected) { hintTone = "pass"; hintText = "Replay rejected; evidence flow is complete."; }
  else if (ev.flow?.receipt) { hintTone = "pass"; hintText = "Payment receipt returned; replay test is now available."; }
  else if (ev.flow?.authorization) { hintTone = "pass"; hintText = "Authorization: Payment is ready for retry."; }
  else if (ev.flow?.fiberChallenge) { hintTone = ev.status?.livePaymentEnabled ? "pass" : "warn"; hintText = ev.status?.livePaymentEnabled ? "Fiber challenge ready; payer RPC can execute payment." : "Challenge present, but this process is not live Fiber ready."; }
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
                if (ep.price.value) ev.setAmountCkb(ep.price.value);
                if (ep.fiberAmountShannons) ev.setAmountShannons(ep.fiberAmountShannons);
                await ev.resetEvidenceFlow("resource selected");
              }}>
                <Icon name="RequestScenario" />
                <span>{ep.label}</span>
                <span>{ep.price.display}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="purchase-action">
          <div className="actions btn-row" id="flow-actions">
            <button className="btn" id="send" disabled={ev.busy || Boolean(sendReason)} onClick={() => ev.runAction("unpaid")}>
              <Icon name="ActionSend" /><span>Send unpaid</span><span className="key">Ctrl+U</span>
            </button>
            <button className="btn primary" id="pay" disabled={ev.busy || Boolean(payReason)} onClick={() => ev.runAction("pay")}>
              <Icon name="ActionPay" /><span>Pay with Fiber</span><span className="key">Ctrl+P</span>
            </button>
            <button className="btn" id="retry" disabled={ev.busy || Boolean(retryReason)} onClick={() => ev.runAction("retry")}>
              <Icon name="ActionRetry" /><span>Retry w/ Auth</span><span className="key">Ctrl+R</span>
            </button>
            <button className="btn danger" id="replay" disabled={ev.busy || Boolean(replayReason)} onClick={() => ev.runAction("replay")}>
              <Icon name="ActionReplay" /><span>Replay credential</span><span className="key">Ctrl+Y</span>
            </button>
          </div>
          <div className={"action-hint " + hintTone} id="action-hint">
            <Icon name={hintTone === "pass" ? "StatusPassed" : hintTone === "fail" ? "StatusFailed" : "StatusUnavailable"} />
            <span>{hintText}</span>
          </div>
        </div>
      </div>

      <div className="panel timeline-panel" data-panel-id="timeline">
        <div className="panel-title"><Icon name="Timeline" /> Protocol Flow Timeline</div>
        <div className="panel-body">
          <Timeline />
        </div>
      </div>
    </>
  );
}
