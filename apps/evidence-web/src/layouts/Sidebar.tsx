import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { workspaceTabs } from "../constants.js";
import { Icon } from "../components/Icon.js";
import type { WorkspaceTab } from "../types.js";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const ev = useEvidence();

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
                  document.getElementById("main-content")?.scrollTo({ top: 0 });
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
    </nav>
  );
}
