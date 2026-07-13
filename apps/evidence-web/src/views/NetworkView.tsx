import React from "react";
import { useEvidence } from "../state/EvidenceContext.js";
import { Icon } from "../components/Icon.js";
import { channelEvidenceText } from "../lib/utils.js";

export function NetworkView() {
  const ev = useEvidence();
  const network = ev.status?.localFiberNetwork || {};
  const nodes = [
    ["node1", (network.node1 as Record<string, string>)?.role || "payer", (network.node1 as Record<string, string>)?.rpc || "127.0.0.1:21714", (network.node1 as Record<string, string>)?.status || "unconfigured"],
    ["node2", (network.node2 as Record<string, string>)?.role || "router", (network.node2 as Record<string, string>)?.rpc || "127.0.0.1:21715", (network.node2 as Record<string, string>)?.status || "unconfigured"],
    ["node3", (network.node3 as Record<string, string>)?.role || "payee", (network.node3 as Record<string, string>)?.rpc || "127.0.0.1:21716", (network.node3 as Record<string, string>)?.status || "unconfigured"],
  ];

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title"><Icon name="FiberNetwork" /> Fiber Network Context</div>
      </div>

      <div className="panel network-panel" data-panel-id="network">
        <div className="panel-title"><Icon name="FiberNetwork" /> Local Route</div>
        <div className="panel-body network" id="network">
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
