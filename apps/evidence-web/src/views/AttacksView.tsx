import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";

export function AttacksView() {
  const ev = useEvidence();
  const replayRejected = ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402;
  const receipt = ev.flow?.receipt;
  const paymentHash = ev.flow?.fiberChallenge?.paymentHash || receipt?.settlement?.paymentHash || "pending";

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="AttackReplay" /> Attack Replay</div>
      </div>

      <div className="panel" data-panel-id="attacks" style={{ borderColor: replayRejected ? "rgba(57,231,173,.25)" : "var(--line)" }}>
        <div className="panel-title">
          <Icon name="AttackReplay" /> Replay Attack Demonstration
          <span className={"chip " + (replayRejected ? "green" : "orange")} style={{ marginLeft: "auto" }}>
            {replayRejected ? "REJECTED" : "PENDING"}
          </span>
        </div>
        <div className="panel-body">
          <div className="grid-2">
            <div className="panel" style={{ borderColor: "var(--line)", margin: 0 }}>
              <div className="panel-title"><Icon name="StatusPassed" /> Result</div>
              <div className="panel-body">
                <div className="kv">
                  <div className="kv-row"><span className="kv-label">Status</span><strong style={{ color: replayRejected ? "var(--green)" : "var(--orange)" }}>{replayRejected ? "REPLAY REJECTED" : "PENDING"}</strong></div>
                  <div className="kv-row"><span className="kv-label">Reason</span><strong>{replayRejected ? "Receipt not reused" : "Awaiting replay"}</strong></div>
                  <div className="kv-row"><span className="kv-label">Service</span><strong>{replayRejected ? "not re-executed" : "awaiting replay"}</strong></div>
                  <div className="kv-row"><span className="kv-label">Receipt reissued</span><strong style={{ color: "var(--red)" }}>false</strong></div>
                </div>
              </div>
            </div>
            <div className="panel" style={{ borderColor: "var(--line)", margin: 0 }}>
              <div className="panel-title"><Icon name="ResourceHash" /> Evidence</div>
              <div className="panel-body">
                <div className="kv">
                  <div className="kv-row"><span className="kv-label">receipt_id</span><strong>{receipt?.receiptId || "pending"}</strong></div>
                  <div className="kv-row"><span className="kv-label">payment_hash</span><strong>{paymentHash}</strong></div>
                  <div className="kv-row"><span className="kv-label">replay_status</span><strong>{replayRejected ? "402 rejected" : "not attempted"}</strong></div>
                </div>
              </div>
            </div>
          </div>

          {replayRejected ? (
            <div className="action-hint pass" style={{ marginTop: 14 }}>
              <Icon name="StatusPassed" />
              <span>Replay rejected — this is a pass condition. The single-use credential store prevented credential reuse.</span>
            </div>
          ) : (
            <div className="action-hint warn" style={{ marginTop: 14 }}>
              <Icon name="StatusUnavailable" />
              <span>Complete the payment flow first, then replay the same credential to demonstrate rejection.</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function NetworkView() {
  const ev = useEvidence();
  const network = ev.status?.localFiberNetwork || {};
  const nodes = [
    ["node1", (network.node1 as Record<string, string>)?.role || "payer", (network.node1 as Record<string, string>)?.rpc || "127.0.0.1:21714", (network.node1 as Record<string, string>)?.status || "unconfigured"],
    ["node2", (network.node2 as Record<string, string>)?.role || "router", (network.node2 as Record<string, string>)?.rpc || "127.0.0.1:21715", (network.node2 as Record<string, string>)?.status || "unconfigured"],
    ["node3", (network.node3 as Record<string, string>)?.role || "payee", (network.node3 as Record<string, string>)?.rpc || "127.0.0.1:21716", (network.node3 as Record<string, string>)?.status || "unconfigured"],
  ];

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="FiberNetwork" /> Fiber Network Context</div>
      </div>

      <div className="panel network-panel" data-panel-id="network">
        <div className="panel-title"><Icon name="FiberNetwork" /> Local Route</div>
        <div className="panel-body network" id="network">
          {nodes.map(([name, role, rpc, status]) => (
            <div className="node-row" key={name}>
              <span style={{ fontWeight: 600 }}>{name}</span>
              <span className="pill">{role}</span>
              <span className="hash">{rpc}</span>
              <span className={"node-state " + status}>{status}</span>
            </div>
          ))}
          <div className="network-footer">
            <span>Channel Evidence <strong>{channelText(network)}</strong></span>
            <span>Route Status <strong>{(network.routeStatus as string) || "not configured"}</strong></span>
          </div>
        </div>
      </div>
    </>
  );
}

function channelText(network: Record<string, unknown>): string {
  const channelCount = network.channelCount;
  if (typeof channelCount === "number") {
    const suffix = network.channelCountSource === "fiber-local-e2e-report" ? " from report" : " configured";
    return `${channelCount}${suffix}`;
  }
  if (network.channelCountSource === "not-polled") return "not polled";
  return "unavailable";
}
