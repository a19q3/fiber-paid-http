import React, { useMemo } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { evidenceTabs, reportDisplayList } from "../constants.js";
import { booleanSummary, readinessSummary, vectorSummary, flowChallengeId, flowResourceHash } from "../lib/utils.js";

export function EvidenceView() {
  const ev = useEvidence();

  const parityItems = useMemo(() => {
    const canonical = ((ev.reports.canonical as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const local = ((ev.reports.gateLocal as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const testnet = ((ev.reports.fiberTestnet as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const tsGate = ((ev.reports.tsGate as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const production = (ev.status?.productionEvidence || {}) as Record<string, unknown>;
    return [
      ["Fiber Commit", (tsGate.fiber_commit as string) || "unavailable"],
      ["Vectors", vectorSummary(canonical)],
      ["Error Code Parity", booleanSummary(canonical.error_code_parity)],
      ["F402 Parity", booleanSummary(canonical.f402_parity)],
      ["Canonical Hash", booleanSummary(canonical.canonical_hash_parity)],
      ["Testnet E2E", booleanSummary(production.testnetFiberE2e ?? testnet.testnet_fiber_e2e)],
      ["Local E2E", booleanSummary(local.live_fiber_local_e2e ?? ev.status?.badges?.localFiberE2e)],
      ["Bootstrap E2E", booleanSummary(production.productionBootstrapReady)],
      ["Production Ready", readinessSummary(production.productionReady)],
      ["Gate Ready", readinessSummary(production.gateReady)],
      ["Conflicts", Array.isArray(production.conflicts) && production.conflicts.length ? String(production.conflicts.length) : "0"],
      ["TS Boundary", booleanSummary(canonical.typescript_trusted_boundary)],
    ] as [string, string][];
  }, [ev.reports, ev.status]);

  const evidenceData = useMemo(() => {
    const tab = ev.activeTab;
    if (tab === "chain") {
      return {
        challenge_id: flowChallengeId(ev.flow),
        resource: ev.flow?.resourceUrl || ev.selected,
        method: "Fiber",
        amount: `${ev.parameters.amountCkb} CKB`,
        fiber_amount_shannons: ev.parameters.amountShannons,
        profile_selection: ev.profileSelection,
        execution_role_capabilities: ev.configuration?.executionRoleCapabilities,
        route: ev.status?.localFiberNetwork?.route || [],
        route_source: ev.status?.localFiberNetwork?.routeSource,
        resource_hash: flowResourceHash(ev.flow),
        payment_hash: ev.flow?.fiberChallenge?.paymentHash,
        payment_proof_mode: ev.flow?.proof?.mode || ev.status?.mode,
        mode: ev.status?.mode,
        blockers: ev.status?.blockers,
      };
    }
    if (tab === "receipt") return ev.flow?.receipt || (ev.reports.fiber as Record<string, unknown>)?.data || { status: "unavailable", reason: "receipt pending" };
    if (tab === "security") return (ev.reports.security as Record<string, unknown>)?.data || { status: "unavailable", reason: "security matrix unavailable" };
    if (tab === "canonical") return (ev.reports.canonical as Record<string, unknown>)?.data || { status: "unavailable", reason: "canonical report unavailable" };
    return (ev.reports.fiberTestnet as Record<string, unknown>)?.data || (ev.reports.fiber as Record<string, unknown>)?.data || (ev.reports.gateLocal as Record<string, unknown>)?.data || { status: "unavailable", reason: "Fiber evidence unavailable" };
  }, [ev.activeTab, ev.flow, ev.selected, ev.parameters, ev.profileSelection, ev.configuration, ev.status, ev.reports]);

  const jsonContent = JSON.stringify(evidenceData, null, 2);
  const apiUnreachable = ev.status?.mode === "api-unreachable";

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="Evidence" /> Evidence &amp; Reports</div>
      </div>

      <div className="panel parity-grid" id="parity" data-panel-id="parity" style={{ marginBottom: 14, padding: 14 }}>
        {parityItems.map(([label, value]) => (
          <div className="mini-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="panel evidence-panel" data-panel-id="evidence">
        <div className="panel-title"><Icon name="Evidence" /> Evidence Detail</div>
        <div className="panel-body">
          <div className="evidence-tabs" id="tabs">
            {evidenceTabs.map((tab) => (
              <button key={tab.id} className={"tab-btn tab" + (ev.activeTab === tab.id ? " active" : "")} onClick={() => {
                document.getElementById("main-content")?.scrollTo({ top: 0 });
                ev.setActiveTab(tab.id);
              }}>
                <Icon name={tab.icon as never} /> {tab.label}
              </button>
            ))}
          </div>
          <pre className="json-view" id="json" aria-label="Selected evidence JSON">{jsonContent}</pre>

          <div className="reports-attack">
            <div>
              <h3 style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--muted)", marginBottom: 8 }}>Reports</h3>
              <div className="report-list" id="report-list">
                {reportDisplayList.map(({ file, key }) => {
                  const report = ev.reports[key] as Record<string, unknown> | undefined;
                  return (
                    <div className="report-row" key={file}>
                      <Icon name="ReportArtifact" />
                      <strong>{file}</strong>
                      <span className={"badge " + (report?.exists ? "pass" : "warn")}>
                        {report?.exists ? "loaded" : apiUnreachable ? "unavailable" : "missing"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="attack-panel">
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--muted)", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="AttackReplay" /> Attack Replay
                <span className={"chip " + ((ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402) ? "green" : "orange")} style={{ fontSize: 9 }} id="attack-chip">
                  {(ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402) ? "rejected" : "pending"}
                </span>
              </div>
              <div className="attack-grid" id="attack-grid">
                {(() => {
                  const rejected = ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402;
                  const receipt = ev.flow?.receipt;
                  const ph = ev.flow?.fiberChallenge?.paymentHash || receipt?.reference || "pending";
                  return [
                    ["Status", rejected ? "REPLAY REJECTED" : "PENDING"],
                    ["Reason", rejected ? "Receipt not reused" : "Awaiting replay"],
                    ["receipt_reference", receipt?.reference || "pending"],
                    ["challenge_id", receipt?.challengeId || "pending"],
                    ["payment_hash", ph],
                    ["Service", rejected ? "not re-executed" : "awaiting replay"],
                  ].map(([label, value]) => (
                    <div key={label}><span>{label}</span><strong>{value}</strong></div>
                  ));
                })()}
              </div>
              <div id="blocked" style={{ fontSize: 11, color: (ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402) ? "var(--green)" : "var(--muted)", marginTop: 6 }}>
                {(ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402) ? "replay blocked" : "waiting for replay"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
