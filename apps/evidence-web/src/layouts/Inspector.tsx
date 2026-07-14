import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { formatTime } from "../lib/utils.js";

function eventIcon(level: string) {
  if (level === "ERROR") return "StatusFailed" as const;
  if (level === "WARN") return "StatusUnavailable" as const;
  return "StatusPassed" as const;
}

export function Inspector() {
  const ev = useEvidence();

  const events = [...(ev.flow.events || []), ...ev.localLogs];

  const replayRejected = ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402;
  const receipt = ev.flow?.receipt;

  const actuatorState = (() => {
    if (ev.status?.mode === "api-unreachable") return { state: "error", detail: "API unreachable", service: "not executed", replay: "not attempted", reissued: "false", health: "offline" };
    if (replayRejected) return { state: "blocked", detail: "replay blocked", service: receipt ? "executed after receipt" : "not executed", replay: "blocked", reissued: "false", health: "guard active" };
    if (ev.busy && ev.phase !== "idle") return { state: "executing", detail: "protocol step running", service: receipt ? "executed after receipt" : "receipt not issued", replay: "not attempted", reissued: "false", health: "API connected" };
    if (receipt || ev.phase === "receipt_returned") return { state: "active", detail: "receipt accepted", service: "executed after receipt", replay: "not attempted", reissued: "false", health: "API connected" };
    if (ev.flow?.authorization || ev.flow?.fiberChallenge || ev.phase === "payment_settled" || ev.phase === "challenge_received") return { state: "active", detail: ev.flow?.authorization ? "payment proof ready" : "402 challenge issued", service: "awaiting receipt", replay: "not attempted", reissued: "false", health: "API connected" };
    return { state: "idle", detail: "awaiting receipt", service: "not executed", replay: "not attempted", reissued: "false", health: ev.status?.livePaymentEnabled ? "live Fiber ready" : "API connected" };
  })();

  return (
    <aside className="app-inspector">
      <div className="inspector-section" style={{ flex: "1 1 0" }}>
        <div className="inspector-head">
          <span><Icon name="Terminal" /> Event Log</span>
          <div className="inspector-actions">
            <button className="icon-btn" id="clear-log" onClick={() => ev.clearLog()} title="Clear log" aria-label="Clear event log">
              <Icon name="ClearLog" />
            </button>
            <button className="icon-btn" id="close-inspector" onClick={() => ev.setInspectorOpen(false)} title="Hide inspector" aria-label="Hide inspector">
              <Icon name="Navigation" />
            </button>
          </div>
        </div>
        <div className="inspector-body" id="logs">
          {events.length === 0 && <div className="empty-state">No events in this session. Start the payment demo to populate this log.</div>}
          {events.map((event, i) => (
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

    </aside>
  );
}
