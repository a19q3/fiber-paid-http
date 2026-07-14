import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { channelEvidenceText } from "../lib/utils.js";

export function NetworkView() {
  const ev = useEvidence();
  const network = ev.status?.localFiberNetwork || {};
  const nodes = ["node1", "node2", "node3"].flatMap((name) => {
    const node = network[name] as Record<string, string> | undefined;
    return node?.rpc ? [[name, node.role || "node", node.rpc, node.status || "unknown"]] : [];
  });

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="FiberNetwork" /> Fiber Network Context</div>
      </div>

      <div className="panel network-panel" data-panel-id="network">
        <div className="panel-title"><Icon name="FiberNetwork" /> Local Route</div>
        <div className="panel-body network" id="network">
          {nodes.length === 0 && <div className="empty-state">No live network topology has been reported by the evidence API.</div>}
          {nodes.map(([name, role, rpc, status]) => (
            <div className="node-row" key={name}>
              <span style={{ fontWeight: 600 }}>{name}</span>
              <span className="pill">{role}</span>
              <span className="hash">{rpc}</span>
              <span className={"node-state " + status}>{status}</span>
            </div>
          ))}
          <div className="network-footer">
            <span>Channel Evidence <strong>{channelEvidenceText(network)}</strong></span>
            <span>Route Status <strong>{(network.routeStatus as string) || "not configured"}</strong></span>
          </div>
        </div>
      </div>
    </>
  );
}
