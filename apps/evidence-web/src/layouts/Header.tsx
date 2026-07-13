import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { formatTime } from "../lib/utils.js";

interface HeaderProps {
  onToggleSidebar: () => void;
  navigationExpanded: boolean;
  onOpenPrefs: () => void;
}

export function Header({ onToggleSidebar, navigationExpanded, onOpenPrefs }: HeaderProps) {
  const ev = useEvidence();
  const isBusy = ev.busy || ev.refreshing;
  const connClass = ev.refreshing ? "refreshing" : ev.apiConnection;

  return (
    <>
      <button
        className="icon-btn"
        id="toggle-navigation"
        onClick={onToggleSidebar}
        title={navigationExpanded ? "Collapse navigation" : "Expand navigation"}
        aria-label={navigationExpanded ? "Collapse navigation" : "Expand navigation"}
        aria-controls="workspace-navigation"
        aria-expanded={navigationExpanded}
      >
        <Icon name="Navigation" />
      </button>
      <div className="header-brand">
        <div className="header-mark" />
        <div>
          <h1>Fiber Paid HTTP Evidence Console <span className="header-version">MPP</span></h1>
          <p>Machine Payments Protocol over Fiber</p>
        </div>
      </div>
      <div className="header-spacer" />
      <div className="header-tools">
        <div className="header-conn">
          <span className={"conn-dot " + connClass} />
          <span id="api-state-text">{ev.apiMessage || "not connected"}{ev.lastRefreshedAt ? ` · ${formatTime(ev.lastRefreshedAt)}` : ""}</span>
        </div>
        <button className={"icon-btn" + (ev.refreshing ? " is-busy" : "")} onClick={() => ev.refreshAll("manual refresh")} disabled={isBusy} title="Refresh" aria-label="Refresh console">
          <Icon name="ActionRetry" />
        </button>
        <button className="icon-btn" onClick={onOpenPrefs} title="Preferences" aria-label="Open preferences">
          <Icon name="Settings" />
        </button>
        <button id="open-settings" className={"icon-btn" + (ev.settingsOpen ? " active" : "")} onClick={() => ev.setSettingsOpen(!ev.settingsOpen)} title="Console settings" aria-label="Open console settings">
          <Icon name="Method" />
        </button>
      </div>
    </>
  );
}
