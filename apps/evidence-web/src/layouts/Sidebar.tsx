import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { workspaceTabs } from "../constants.js";
import { Icon } from "../components/Icon.js";
import type { WorkspaceTab } from "../types.js";

function badgeState(value: unknown): { status: string; text: string } {
  if (value === true) return { status: "pass", text: "passed" };
  if (value === false) return { status: "fail", text: "false" };
  return { status: "warn", text: "unavailable" };
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const ev = useEvidence();
  const badges = ev.status?.badges || {};

  const badgeList: [string, unknown][] = [
    ["Rust engine", badges.rustCanonicalEngine],
    ["TS harness", badges.tsVectorHarness],
    ["Fiber E2E", ev.status?.productionEvidence?.testnetFiberE2e],
    ["F402", badges.f402Compatibility],
    ["Production", badges.productionReady],
  ];

  return (
    <nav className="app-sidebar" id="workspace-navigation" aria-label="Workspace navigation">
      <div className="sidebar-section">
        {["Build", "Verify", "Explore", "Operate"].map((group) => (
          <div className="nav-group" key={group}>
            <div className="sidebar-label">{group}</div>
            {workspaceTabs.filter((tab) => tab.group === group).map((tab) => (
              <button
                key={tab.id}
                className={"nav-item" + (ev.workspaceTab === tab.id ? " active" : "")}
                data-workspace-tab={tab.id}
                onClick={() => {
                  ev.setWorkspaceTab(tab.id as WorkspaceTab);
                  onNavigate?.();
                }}
              >
                <Icon name={tab.icon as never} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-section status-cluster">
        <div className="sidebar-label">Evidence Status</div>
        {badgeList.map(([label, value]) => {
          const badge = badgeState(value);
          return (
            <div className="status-badge" key={label} title={label}>
              <span className={"dot " + badge.status} />
              <span>{label}</span>
              <span>{badge.text}</span>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
