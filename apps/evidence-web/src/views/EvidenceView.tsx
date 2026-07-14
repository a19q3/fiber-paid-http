import React, { useMemo } from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { evidenceTabs, reportDisplayList } from "../constants.js";
import { booleanSummary, readinessSummary, vectorSummary, flowChallengeId, flowResourceHash } from "../lib/utils.js";

export function EvidenceView() {
  const ev = useEvidence();

  const parityItems = useMemo(() => {
    const canonical = ((ev.reports.canonical as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const testnet = ((ev.reports.fiberTestnet as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const tsGate = ((ev.reports.tsGate as Record<string, unknown>)?.data || {}) as Record<string, unknown>;
    const production = (ev.status?.productionEvidence || {}) as Record<string, unknown>;
    return [
      ["Fiber Commit", (tsGate.fiber_commit as string) || "unavailable"],
      ["Vectors", vectorSummary(canonical)],
      ["Canonical Hash", booleanSummary(canonical.canonical_hash_parity)],
      ["Testnet E2E", booleanSummary(production.testnetFiberE2e ?? testnet.testnet_fiber_e2e)],
      ["Production Ready", readinessSummary(production.productionReady)],
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
    if (tab === "receipt") return ev.flow?.receipt || (ev.reports.fiber as Record<string, unknown>)?.data || { status: "unavailable", reason: "no receipt recorded in this session" };
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

          <div className="reports-list">
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
        </div>
      </div>
    </>
  );
}
