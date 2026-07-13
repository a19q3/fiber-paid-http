import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { formatTime } from "../lib/utils.js";
import type { FlowEvent } from "../types.js";

function eventIcon(level: string) {
  if (level === "ERROR") return "StatusFailed" as const;
  if (level === "WARN") return "StatusUnavailable" as const;
  return "StatusPassed" as const;
}

function staticEvents(apiBase: string, reports: Record<string, unknown>, mode?: string): FlowEvent[] {
  if (mode === "api-unreachable") {
    return [
      { time: new Date().toISOString(), level: "ERROR", actor: "web", message: "evidence API unreachable", detail: apiBase },
      { time: new Date().toISOString(), level: "WARN", actor: "reports", message: "status unavailable", detail: "badges require /api/status" },
      { time: new Date().toISOString(), level: "WARN", actor: "client", message: "evidence actions disabled", detail: "no API session" },
    ];
  }
  const canonicalLoaded = Boolean((reports.canonical as Record<string, unknown>)?.exists);
  const fiberLoaded = Boolean((reports.fiberTestnet as Record<string, unknown>)?.exists || (reports.gateLocal as Record<string, unknown>)?.exists || (reports.fiber as Record<string, unknown>)?.exists);
  return [
    { time: new Date().toISOString(), level: "INFO", actor: "client", message: "GET /paid/protocol-service", detail: "awaiting unpaid request" },
    { time: new Date().toISOString(), level: "INFO", actor: "server", message: "402 challenge", detail: "awaiting live request" },
    { time: new Date().toISOString(), level: canonicalLoaded ? "INFO" : "WARN", actor: "rust", message: "canonical report", detail: canonicalLoaded ? "loaded" : "unavailable" },
    { time: new Date().toISOString(), level: "INFO", actor: "typescript", message: "compatibility tooling", detail: "not production boundary" },
    { time: new Date().toISOString(), level: fiberLoaded ? "INFO" : "WARN", actor: "fiber", message: "Fiber E2E evidence", detail: fiberLoaded ? "loaded" : "unavailable" },
  ];
}

export function Inspector() {
  const ev = useEvidence();

  const events = [...(ev.flow.events || []), ...ev.localLogs];
  const visible = events.length ? events : staticEvents(ev.apiBase, ev.reports, ev.status?.mode);

  const replayRejected = ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402;
  const receipt = ev.flow?.receipt;
  const paymentHash = ev.flow?.fiberChallenge?.paymentHash || receipt?.reference || "pending";

  const actuatorState = (() => {
    if (ev.status?.mode === "api-unreachable") return { state: "error", detail: "API unreachable", service: "not executed", replay: "not attempted", reissued: "false", health: "offline" };
    if (replayRejected) return { state: "blocked", detail: "replay blocked", service: receipt ? "executed after receipt" : "not executed", replay: "blocked", reissued: "false", health: "guard active" };
    if (ev.busy && ev.phase !== "idle") return { state: "executing", detail: "protocol step running", service: receipt ? "executed after receipt" : "pending receipt", replay: "not attempted", reissued: "false", health: "API connected" };
    if (receipt || ev.phase === "receipt_returned") return { state: "active", detail: "receipt accepted", service: "executed after receipt", replay: "not attempted", reissued: "false", health: "API connected" };
    if (ev.flow?.authorization || ev.flow?.fiberChallenge || ev.phase === "payment_settled" || ev.phase === "challenge_received") return { state: "active", detail: ev.flow?.authorization ? "payment proof ready" : "402 challenge issued", service: "awaiting receipt", replay: "not attempted", reissued: "false", health: "API connected" };
    return { state: "idle", detail: "awaiting receipt", service: "not executed", replay: "not attempted", reissued: "false", health: ev.status?.livePaymentEnabled ? "live Fiber ready" : "API connected" };
  })();

  return (
    <aside className="app-inspector">
      <div className="inspector-section" style={{ flex: "1 1 0" }}>
        <div className="inspector-head">
          <span><Icon name="Terminal" /> Event Log</span>
          <button className="icon-btn" id="clear-log" style={{ width: 24, height: 24 }} onClick={() => ev.clearLog()} title="Clear log" aria-label="Clear event log">
            <Icon name="ClearLog" />
          </button>
        </div>
        <div className="inspector-body" id="logs">
          {visible.map((event, i) => (
            <div className="log-line" key={i}>
              <span className="time">{formatTime(event.time)}</span>
              <Icon name={eventIcon(event.level)} />
              <span className={"level-" + event.level}>{event.level}</span>
              <span className="log-message"><span className="actor">{event.actor}</span>{event.message} {event.detail || ""}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-head">
          <span><Icon name="Activity" /> Service / Actuator</span>
        </div>
        <div className="actuator-body">
          <div className="actuator-head">
            <strong>{actuatorState.state}</strong>
            <span>{actuatorState.detail}</span>
          </div>
          <div className="actuator-grid">
            <span>service</span><strong id="actuator-service">{actuatorState.service}</strong>
            <span>replay</span><strong id="actuator-replay">{actuatorState.replay}</strong>
            <span>receipt reissued</span><strong id="actuator-reissued">{actuatorState.reissued}</strong>
            <span>health</span><strong id="actuator-health">{actuatorState.health}</strong>
          </div>
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-head">
          <span><Icon name="AttackReplay" /> Attack Replay</span>
          <span className={"chip " + (replayRejected ? "green" : "orange")} style={{ fontSize: 9 }}>{replayRejected ? "rejected" : "pending"}</span>
        </div>
        <div className="inspector-body">
          <div className="attack-grid">
            <div><span>Status</span><strong>{replayRejected ? "REPLAY REJECTED" : "PENDING"}</strong></div>
            <div><span>Reason</span><strong>{replayRejected ? "Receipt not reused" : "Awaiting replay"}</strong></div>
            <div><span>receipt_reference</span><strong id="inspector-receipt-reference">{receipt?.reference || "pending"}</strong></div>
            <div><span>challenge_id</span><strong id="inspector-challenge-id">{receipt?.challengeId || "pending"}</strong></div>
            <div><span>payment_hash</span><strong id="inspector-payment-hash">{paymentHash}</strong></div>
            <div><span>Service</span><strong>{replayRejected ? "not re-executed" : "awaiting replay"}</strong></div>
          </div>
        </div>
      </div>
    </aside>
  );
}
