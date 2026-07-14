import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";

export function AttacksView() {
  const ev = useEvidence();
  const replayRejected = ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402;
  const receipt = ev.flow?.receipt;
  const paymentHash = ev.flow?.fiberChallenge?.paymentHash || receipt?.reference || "not recorded";

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="AttackReplay" /> Attack Replay</div>
      </div>

      <div className="panel" data-panel-id="attacks" style={{ borderColor: replayRejected ? "rgba(57,231,173,.25)" : "var(--line)" }}>
        <div className="panel-title">
          <Icon name="AttackReplay" /> Replay Attack Demonstration
          <span className={"chip " + (replayRejected ? "green" : "orange")} style={{ marginLeft: "auto" }}>
            {replayRejected ? "REJECTED" : "NOT TESTED"}
          </span>
        </div>
        <div className="panel-body">
          <div className="grid-2">
            <div className="panel" style={{ borderColor: "var(--line)", margin: 0 }}>
              <div className="panel-title"><Icon name="StatusPassed" /> Result</div>
              <div className="panel-body">
                <div className="kv">
                  <div className="kv-row"><span className="kv-label">Status</span><strong style={{ color: replayRejected ? "var(--green)" : "var(--muted)" }}>{replayRejected ? "REPLAY REJECTED" : "NOT TESTED"}</strong></div>
                  <div className="kv-row"><span className="kv-label">Reason</span><strong>{replayRejected ? "Receipt not reused" : "Run the replay step"}</strong></div>
                  <div className="kv-row"><span className="kv-label">Service</span><strong>{replayRejected ? "not re-executed" : "not observed"}</strong></div>
                  <div className="kv-row"><span className="kv-label">Receipt reissued</span><strong style={{ color: "var(--red)" }}>false</strong></div>
                </div>
              </div>
            </div>
            <div className="panel" style={{ borderColor: "var(--line)", margin: 0 }}>
              <div className="panel-title"><Icon name="ResourceHash" /> Evidence</div>
              <div className="panel-body">
                <div className="kv">
                  <div className="kv-row"><span className="kv-label">receipt_reference</span><strong>{receipt?.reference || "not recorded"}</strong></div>
                  <div className="kv-row"><span className="kv-label">challenge_id</span><strong>{receipt?.challengeId || "not recorded"}</strong></div>
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
