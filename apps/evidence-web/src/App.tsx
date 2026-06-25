import React, { useState, useMemo } from "react";
import { EvidenceProvider, useEvidence } from "./state/EvidenceContext.js";
import { ApiClient, getInitialApiBase, readConsoleSessionId } from "./lib/api.js";
import { readStorage, boundedInteger } from "./lib/utils.js";
import { mergeConsoleSettings } from "./constants.js";
import type { ConsolePreferences } from "./types.js";
import { Header } from "./layouts/Header.js";
import { Sidebar } from "./layouts/Sidebar.js";
import { Inspector } from "./layouts/Inspector.js";
import { SettingsDrawer } from "./settings/SettingsDrawer.js";
import { PreferencesPopover } from "./settings/PreferencesPopover.js";
import { FlowView } from "./views/FlowView.js";
import { TournamentView } from "./views/TournamentView.js";
import { BootstrapView } from "./views/BootstrapView.js";
import { EvidenceView } from "./views/EvidenceView.js";
import { AttacksView } from "./views/AttacksView.js";
import { NetworkView } from "./views/NetworkView.js";

function ConsoleApp() {
  const ev = useEvidence();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const shellClass = [
    "app-shell",
    "console",
    ev.density === "compact" ? "layout-density-compact" : "layout-density-standard",
  ].filter(Boolean).join(" ");

  const bodyClass = [
    "app-body",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    ev.inspectorOpen ? "" : "inspector-collapsed",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClass} data-workspace={ev.workspaceTab}>
      <div className="app-header">
        <Header onToggleSidebar={() => setSidebarCollapsed((v) => !v)} sidebarCollapsed={sidebarCollapsed} onOpenPrefs={() => setPrefsOpen(true)} />
      </div>
      <div className={bodyClass}>
        <Sidebar />
        <main className="app-main">
          {ev.workspaceTab === "flow" && <FlowView />}
          {ev.workspaceTab === "tournament" && <TournamentView />}
          {ev.workspaceTab === "bootstrap" && <BootstrapView />}
          {ev.workspaceTab === "evidence" && <EvidenceView />}
          {ev.workspaceTab === "attacks" && <AttacksView />}
          {ev.workspaceTab === "network" && <NetworkView />}
        </main>
        <Inspector />
      </div>
      {ev.settingsOpen && <SettingsDrawer />}
      {prefsOpen && <PreferencesPopover onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}

export default function App() {
  const api = useMemo(() => {
    const routeParams = new URLSearchParams(window.location.search);
    const sessionId = readConsoleSessionId(routeParams);
    const prefsRaw = readStorage("fiberMppConsolePreferences");
    let prefs: ConsolePreferences = {};
    if (prefsRaw) { try { const p = JSON.parse(prefsRaw); if (p && typeof p === "object") prefs = p; } catch { /* empty */ } }
    const apiBase = getInitialApiBase(prefs.apiBase);
    const pollMs = boundedInteger(routeParams.get("pollMs"), 1200, 60000, 15000);
    return { client: new ApiClient(apiBase, sessionId), prefs, apiBase, pollMs };
  }, []);

  return (
    <EvidenceProvider api={api.client} initialApiBase={api.apiBase} savedPrefs={api.prefs} pollMs={api.pollMs}>
      <ConsoleApp />
    </EvidenceProvider>
  );
}
