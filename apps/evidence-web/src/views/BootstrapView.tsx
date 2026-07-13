import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { formatCheckValue } from "../lib/utils.js";

function statusIcon(status: string): string {
  if (status === "ready") return "StatusPassed";
  if (status === "evidence") return "StatusUnavailable";
  return "StatusFailed";
}

function checkIcon(status: string): string {
  if (status === "pass") return "StatusPassed";
  if (status === "warn") return "StatusUnavailable";
  return "StatusFailed";
}

function bootstrapRoleIcon(role: string): string {
  if (role === "payer") return "ActorClient";
  if (role === "payee") return "ActorFiber";
  return "ActorServer";
}

function bootstrapSummaryText(roles: { status: string }[], mode: string, productionReady?: boolean): string {
  const total = roles.length || 3;
  const readyCount = roles.filter((r) => r.status === "ready").length;
  const evidenceCount = roles.filter((r) => r.status === "evidence").length;
  if (readyCount === total) return `payer, payee, and gateway are live-ready in ${mode} mode`;
  if (productionReady) return `${readyCount}/${total} live-ready, ${evidenceCount}/${total} backed by production evidence`;
  return `${readyCount}/${total} live-ready; blockers visible below`;
}

export function BootstrapView() {
  const ev = useEvidence();
  const bootstrap = ev.bootstrap;
  const roles = bootstrap?.roles || [];
  const readyCount = roles.filter((r) => r.status === "ready").length;
  const evidenceCount = roles.filter((r) => r.status === "evidence").length;
  const productionReady = bootstrap?.evidence?.productionReady;
  const liveReady = bootstrap?.liveReady;

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="FiberNetwork" /> Production Bootstrap</div>
        <div className="btn-row">
          <button
            className={"btn" + (ev.refreshing ? " is-busy" : "")}
            id="refresh-bootstrap"
            data-refreshing={ev.refreshing ? "true" : "false"}
            data-last-refreshed-at={ev.lastRefreshedAt || ""}
            disabled={ev.busy || ev.refreshing}
            onClick={() => ev.refreshAll("bootstrap refresh")}
          >
            <Icon name="ActionRetry" /> Refresh checks
          </button>
          <button className="btn" onClick={() => ev.setSettingsOpen(true)}>
            <Icon name="Settings" /> Configure
          </button>
        </div>
      </div>

      <div className="panel bootstrap-panel" data-panel-id="bootstrap">
        <div className="panel-title">
          <Icon name="FiberNetwork" /> Bootstrap Summary
        </div>
        <div className="panel-body">
          <div className="bootstrap-summary" id="bootstrap-summary" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontSize: 12 }}>{bootstrapSummaryText(roles, bootstrap?.mode || "unconfigured", productionReady)}</span>
            <strong style={{ color: productionReady ? "var(--green)" : liveReady ? "var(--cyan)" : "var(--orange)" }}>
              {productionReady ? "production ready" : liveReady ? "live ready" : "evidence mode"}
            </strong>
          </div>

          <div className="bootstrap-flow" id="bootstrap-flow" style={{ display: "flex", gap: 12, marginBottom: 14 }}>
            {roles.map((role) => (
              <div className={"bootstrap-node " + role.status} key={role.role} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="bootstrap-orb"><Icon name={bootstrapRoleIcon(role.role) as never} /></span>
                <span style={{ fontSize: 11 }}>{role.role}</span>
              </div>
            ))}
          </div>

          <div className="bootstrap-roles" id="bootstrap-roles">
            <div className="bootstrap-grid">
              {roles.map((role) => (
                <div className={"bootstrap-card " + role.status} key={role.role}>
                  <div className="bootstrap-card-head">
                    <strong>{role.title}</strong>
                    <span className={"chip " + (role.status === "ready" ? "green" : role.status === "evidence" ? "orange" : "red")} style={{ fontSize: 9 }}>
                      <Icon name={statusIcon(role.status) as never} /> {role.status}
                    </span>
                  </div>
                  <p>{role.summary || "awaiting bootstrap report"}</p>
                  <div className="bootstrap-checks">
                    {(role.checks || []).slice(0, 4).map((check, i) => (
                      <div className={"bootstrap-check " + check.status} key={i}>
                        <Icon name={checkIcon(check.status) as never} />
                        <span className="bootstrap-check-label">{check.label}</span>
                        <em>{formatCheckValue(check.value)}</em>
                      </div>
                    ))}
                  </div>
                  <span style={{ fontSize: 10, color: "var(--dim)", display: "block", marginTop: 6 }}>
                    {role.blockers?.[0] || role.nextSteps?.[0] || "ready"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
