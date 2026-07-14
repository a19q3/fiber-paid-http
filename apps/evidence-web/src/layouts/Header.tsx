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
          <h1>Fiber Paid HTTP <span className="header-version">Gateway Lab</span></h1>
          <p>Turn Fiber settlement into replay-safe HTTP delivery.</p>
        </div>
      </div>
      <div className="header-protocol-tags" aria-label="Protocol boundaries">
        <span>MPP draft</span><span>Fiber settlement</span><span>Rust verified</span>
      </div>
      <div className="header-spacer" />
      <div className="header-tools">
        <div className="header-conn">
          <span className={"conn-dot " + connClass} />
          <span id="api-state-text">{ev.apiMessage || "not connected"}{ev.lastRefreshedAt ? ` · ${formatTime(ev.lastRefreshedAt)}` : ""}</span>
        </div>
        <button className={"icon-btn" + (ev.refreshing ? " is-busy" : "")} onClick={() => ev.refreshAll("manual refresh")} disabled={isBusy} title="Refresh" aria-label="Refresh Gateway Lab">
          <Icon name="ActionRetry" />
        </button>
        <button className="icon-btn" onClick={onOpenPrefs} title="Preferences" aria-label="Open preferences">
          <Icon name="Settings" />
        </button>
        <button id="open-settings" className={"icon-btn" + (ev.settingsOpen ? " active" : "")} onClick={() => ev.setSettingsOpen(!ev.settingsOpen)} title="Gateway Lab settings" aria-label="Open Gateway Lab settings">
          <Icon name="Method" />
        </button>
      </div>
    </>
  );
}
