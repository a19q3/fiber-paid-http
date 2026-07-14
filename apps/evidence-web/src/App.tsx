import React, { useEffect, useState, useMemo } from "react";
import { EvidenceProvider, useEvidence } from "./state/EvidenceContext.js";
import { ApiClient, getInitialApiBase, readConsoleSessionId } from "./lib/api.js";
import { readStorage, boundedInteger } from "./lib/utils.js";
import { mergeConsoleSettings } from "./constants.js";
import type { ConsolePreferences } from "./types.js";
import { Header } from "./layouts/Header.js";
import { Sidebar } from "./layouts/Sidebar.js";
import { Inspector } from "./layouts/Inspector.js";
import { SettingsDrawer } from "./settings/SettingsDrawer.js";
import { FlowView } from "./views/FlowView.js";
import { TournamentView } from "./views/TournamentView.js";
import { BootstrapView } from "./views/BootstrapView.js";
import { EvidenceView } from "./views/EvidenceView.js";
import { AttacksView } from "./views/AttacksView.js";
import { NetworkView } from "./views/NetworkView.js";
import { OverviewView } from "./views/OverviewView.js";

function ConsoleApp() {
  const ev = useEvidence();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => {
      setMobileViewport(event.matches);
      if (!event.matches) setMobileNavOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileNavOpen(false);
      document.getElementById("toggle-navigation")?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("#workspace-navigation .nav-item.active")?.focus());
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    document.getElementById("main-content")?.scrollTo({ top: 0 });
  }, [ev.workspaceTab]);

  const closeMobileNav = (focusMain = false) => {
    setMobileNavOpen(false);
    requestAnimationFrame(() => {
      const target = focusMain ? document.getElementById("main-content") : document.getElementById("toggle-navigation");
      target?.focus();
    });
  };

  const shellClass = [
    "app-shell",
    "console",
    ev.density === "compact" ? "layout-density-compact" : "layout-density-standard",
  ].filter(Boolean).join(" ");

  const bodyClass = [
    "app-body",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    mobileNavOpen ? "mobile-nav-open" : "",
    ev.inspectorOpen ? "inspector-open" : "inspector-collapsed",
  ].filter(Boolean).join(" ");

  const navigationExpanded = mobileViewport ? mobileNavOpen : !sidebarCollapsed;
  const toggleNavigation = () => {
    if (mobileViewport) setMobileNavOpen((open) => !open);
    else setSidebarCollapsed((collapsed) => !collapsed);
  };

  return (
    <div className={shellClass} data-workspace={ev.workspaceTab}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-header" inert={ev.settingsOpen ? true : undefined} aria-hidden={ev.settingsOpen ? true : undefined}>
        <Header onToggleSidebar={toggleNavigation} navigationExpanded={navigationExpanded} />
      </div>
      <div className={bodyClass} inert={ev.settingsOpen ? true : undefined} aria-hidden={ev.settingsOpen ? true : undefined}>
        <Sidebar onNavigate={mobileViewport ? () => closeMobileNav(true) : undefined} />
        <button type="button" className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => closeMobileNav()} />
        <main className="app-main" id="main-content" tabIndex={-1} inert={mobileNavOpen ? true : undefined} aria-hidden={mobileNavOpen ? true : undefined}>
          {ev.workspaceTab === "overview" && <OverviewView />}
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
    </div>
  );
}

export default function App() {
  const api = useMemo(() => {
    const routeParams = new URLSearchParams(window.location.search);
    const sessionId = readConsoleSessionId(routeParams);
    const prefsRaw = readStorage("fiberPaidHttpConsolePreferences");
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
