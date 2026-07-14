import React from "react";
import { Icon } from "../components/Icon.js";
import { useEvidence } from "../state/EvidenceContext.js";
import type { WorkspaceTab } from "../types.js";

type EvidenceLabel = "LIVE" | "PRESERVED EVIDENCE" | "BLOCKED";

function evidenceTone(label: EvidenceLabel): "pass" | "warn" | "fail" {
  if (label === "LIVE") return "pass";
  if (label === "PRESERVED EVIDENCE") return "warn";
  return "fail";
}

export function OverviewView() {
  const ev = useEvidence();
  const status = ev.status;
  const productionEvidence = status?.productionEvidence || {};
  const runtimeLabel: EvidenceLabel = ev.apiConnection === "connected" && status?.livePaymentEnabled
    ? "LIVE"
    : productionEvidence.testnetFiberE2e === true
      ? "PRESERVED EVIDENCE"
      : "BLOCKED";
  const verifierLabel: EvidenceLabel = status?.badges?.rustCanonicalEngine === true ? "PRESERVED EVIDENCE" : "BLOCKED";
  const deliveryLabel: EvidenceLabel = status?.badges?.gateReady === true ? "PRESERVED EVIDENCE" : "BLOCKED";
  const blockers = status?.blockers || [];

  const navigate = (tab: WorkspaceTab) => ev.setWorkspaceTab(tab);

  return (
    <div className="overview" data-overview="gateway-lab">
      <section className="overview-hero" aria-labelledby="overview-title">
        <div className="overview-kicker">Server-side payment enforcement</div>
        <h2 id="overview-title">Turn Fiber settlement into replay-safe HTTP delivery.</h2>
        <p>
          Fiber Paid HTTP protects an upstream route, binds a charge to the exact request, verifies Fiber settlement,
          consumes the credential once, and issues a receipt only after successful delivery.
        </p>
        <div className="overview-audience">
          <span>For API developers</span><span>Service operators</span><span>Judges &amp; auditors</span>
        </div>
        <div className="btn-row overview-actions">
          <button className="btn primary" data-overview-action="live-flow" onClick={() => navigate("flow")}>
            <Icon name="Timeline" /> Run live flow
          </button>
          <button className="btn" data-overview-action="runtime" onClick={() => navigate("bootstrap")}>
            <Icon name="FiberNetwork" /> Configure runtime
          </button>
          <button className="btn" data-overview-action="verifier" onClick={() => navigate("evidence")}>
            <Icon name="Evidence" /> Inspect verifier
          </button>
        </div>
      </section>

      <section className="overview-section" aria-labelledby="enforcement-title">
        <div className="section-heading">
          <div><span>One enforcement lifecycle</span><h3 id="enforcement-title">What the gateway owns</h3></div>
          <code>HTTP → Fiber → upstream</code>
        </div>
        <div className="enforcement-grid">
          {[
            ["01", "Bind request", "Method, URL, body digest, amount, payment hash, and expiry."],
            ["02", "Settle over Fiber", "Create the invoice and verify payer/payee settlement through real Fiber RPC."],
            ["03", "Verify & consume once", "The Rust verifier checks the exact challenge and atomically rejects replay."],
            ["04", "Deliver & receipt", "Forward once; emit Payment-Receipt only after upstream 2xx delivery."],
          ].map(([step, title, detail]) => (
            <article className="enforcement-card" key={step}>
              <span>{step}</span><h4>{title}</h4><p>{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="overview-section" aria-labelledby="readiness-title">
        <div className="section-heading">
          <div><span>Current API and committed reports</span><h3 id="readiness-title">Readiness, without theatre</h3></div>
          <button className="btn" onClick={() => ev.refreshAll("overview refresh")} disabled={ev.refreshing}>
            <Icon name="ActionRetry" /> Refresh
          </button>
        </div>
        <div className="readiness-grid" id="overview-readiness">
          <ReadinessCard label="Payment runtime" state={runtimeLabel} detail={status?.livePaymentEnabled ? `${status.mode} Fiber RPC configured` : blockers[0] || "Live Fiber RPC is not configured."} />
          <ReadinessCard label="Rust verifier" state={verifierLabel} detail={status?.badges?.rustCanonicalEngine ? "Canonical verifier report is present." : "Canonical Rust verifier evidence is unavailable."} />
          <ReadinessCard label="Delivery gate" state={deliveryLabel} detail={status?.badges?.gateReady ? "Committed gate evidence covers delivery and replay." : "Current gate evidence does not report ready."} />
        </div>
        {blockers.length > 0 && (
          <div className="overview-blockers" role="status">
            <strong>Runtime blockers</strong>
            <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
          </div>
        )}
      </section>

      <section className="overview-boundary" aria-label="Protocol and ecosystem boundary">
        <div><span className="boundary-tag primary">PRIMARY</span><strong>MPP draft</strong><p>HTTP challenge, credential, and receipt contract.</p></div>
        <div><span className="boundary-tag">PROPOSED</span><strong>Fiber method</strong><p>Invoice and settlement profile verified by the Rust gateway.</p></div>
        <div><span className="boundary-tag">ADAPTER</span><strong>F402 / x402 v2</strong><p>Explicit ingress conversion; no alternate verifier or facilitator.</p></div>
        <div><span className="boundary-tag experimental">EXPERIMENTAL</span><strong>F-L402</strong><p>Disabled by default and terminates at the same verifier.</p></div>
      </section>
    </div>
  );
}

function ReadinessCard({ label, state, detail }: { label: string; state: EvidenceLabel; detail: string }) {
  return (
    <article className={`readiness-card ${evidenceTone(state)}`} data-readiness-state={state}>
      <span>{label}</span><strong>{state}</strong><p>{detail}</p>
    </article>
  );
}
