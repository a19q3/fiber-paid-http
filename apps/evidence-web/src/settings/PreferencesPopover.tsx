import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";

interface Props {
  onClose: () => void;
}

export function PreferencesPopover({ onClose }: Props) {
  const ev = useEvidence();
  return (
    <>
      <div className="popover-overlay" onClick={onClose} />
      <div className="popover">
        <div className="popover-section">
          <div className="popover-label">Density</div>
          <div className="toggle-group">
            <button className={"toggle-btn" + (ev.density === "standard" ? " active" : "")} onClick={() => ev.setDensity("standard")}>Standard</button>
            <button className={"toggle-btn" + (ev.density === "compact" ? " active" : "")} onClick={() => ev.setDensity("compact")}>Compact</button>
          </div>
        </div>
        <div className="popover-section">
          <div className="popover-label">Inspector</div>
          <div className="toggle-group">
            <button className={"toggle-btn" + (ev.inspectorOpen ? " active" : "")} onClick={() => ev.setInspectorOpen(!ev.inspectorOpen)}>
              {ev.inspectorOpen ? "Shown" : "Hidden"}
            </button>
          </div>
        </div>
        <div className="popover-section">
          <div className="popover-label">Auto-refresh</div>
          <div className="toggle-group">
            <button className={"toggle-btn" + (ev.autoRefresh ? " active" : "")} onClick={() => ev.setAutoRefresh(!ev.autoRefresh)}>
              {ev.autoRefresh ? "Live" : "Paused"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
