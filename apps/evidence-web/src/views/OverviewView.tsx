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
  const challengeIssued = ["challenge_received", "payment_settled", "receipt_returned", "replay_rejected"].includes(ev.phase);
  const delivered = ["receipt_returned", "replay_rejected"].includes(ev.phase);
  const replayRejected = ev.phase === "replay_rejected" || ev.flow?.replayStatus === 402;

  const navigate = (tab: WorkspaceTab) => {
    ev.setWorkspaceTab(tab);
    document.getElementById("main-content")?.scrollTo({ top: 0 });
  };

  return (
    <div className="overview" data-overview="gateway-lab">
      <section className="overview-hero" aria-labelledby="overview-title" data-panel-id="overview">
        <div className="overview-kicker">Server-side payment enforcement</div>
        <h2 id="overview-title">Turn Fiber settlement into replay-safe HTTP delivery.</h2>
        <p>
          Fiber Paid HTTP protects an upstream route, binds a charge to the exact request, verifies Fiber settlement,
          consumes the credential once, and issues a receipt only after successful delivery.
        </p>
        <div className="overview-audience"><span>For API developers</span><span>Service operators</span></div>
        <div className="btn-row overview-actions">
          <button className="btn primary" data-overview-action="live-flow" onClick={() => navigate("flow")}>
            <Icon name="Timeline" /> Start payment demo
          </button>
          <button className="btn" data-overview-action="runtime" onClick={() => navigate("bootstrap")}>
            <Icon name="FiberNetwork" /> Check runtime
          </button>
        </div>
      </section>

      <section className="overview-section demo-runbook" aria-labelledby="demo-runbook-title">
        <div className="section-heading">
          <div><span>Recommended recording order</span><h3 id="demo-runbook-title">Five steps, one story</h3></div>
          <code>setup → 402 → pay → replay → use case</code>
        </div>
        <ol className="demo-steps">
          <DemoStep number="01" title="Confirm runtime" state={status?.livePaymentEnabled ? "ready" : "action"} detail={status?.livePaymentEnabled ? "Fiber payer, payee, and gateway are executable." : "Open Runtime setup and connect real Fiber RPC roles."} onClick={() => navigate("bootstrap")} />
          <DemoStep number="02" title="Show the 402 boundary" state={challengeIssued ? "done" : "next"} detail="Request the protected route without payment and inspect the bound challenge." onClick={() => navigate("flow")} />
          <DemoStep number="03" title="Pay, deliver, receipt" state={delivered ? "done" : challengeIssued ? "next" : "locked"} detail="Settle over Fiber, retry once, then show upstream 2xx and Payment-Receipt." onClick={() => navigate("flow")} />
          <DemoStep number="04" title="Reject replay" state={replayRejected ? "done" : delivered ? "next" : "locked"} detail="Reuse the credential and show 402 without executing the service again." onClick={() => navigate("attacks")} />
          <DemoStep number="05" title="Apply it to Battlecode" state="next" detail="Lock a bot, buy one entry ticket, run the real engine, and export evidence." onClick={() => navigate("tournament")} />
        </ol>
      </section>

      <section className="overview-section" aria-labelledby="enforcement-title">
        <div className="section-heading">
          <div><span>One enforcement lifecycle</span><h3 id="enforcement-title">What the gateway owns</h3></div>
          <code>HTTP → Fiber → upstream</code>
        </div>
        <ol className="enforcement-grid">
          {[
            ["01", "Bind request", "Method, URL, body digest, amount, payment hash, and expiry."],
            ["02", "Settle over Fiber", "Create the invoice and verify payer/payee settlement through real Fiber RPC."],
            ["03", "Verify & consume once", "The Rust verifier checks the exact challenge and atomically rejects replay."],
            ["04", "Deliver & receipt", "Forward once; emit Payment-Receipt only after upstream 2xx delivery."],
          ].map(([step, title, detail]) => (
            <li className="enforcement-card" key={step}>
              <span>{step}</span><h4>{title}</h4><p>{detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="overview-section" aria-labelledby="readiness-title">
        <div className="section-heading">
          <div><span>Current API and committed reports</span><h3 id="readiness-title">Verified readiness</h3></div>
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

      <details className="overview-boundary">
        <summary>Protocol and ecosystem boundary</summary>
        <div className="boundary-list">
          <div><span className="boundary-tag primary">PRIMARY</span><strong>MPP draft</strong><p>HTTP challenge, credential, and receipt contract.</p></div>
          <div><span className="boundary-tag">PROPOSED</span><strong>Fiber method</strong><p>Invoice and settlement profile verified by the Rust gateway.</p></div>
          <div><span className="boundary-tag">ADAPTER</span><strong>F402 / x402 v2</strong><p>Explicit ingress conversion; no alternate verifier or facilitator.</p></div>
          <div><span className="boundary-tag experimental">EXPERIMENTAL</span><strong>F-L402</strong><p>Disabled by default and terminates at the same verifier.</p></div>
        </div>
      </details>
    </div>
  );
}

function DemoStep({ number, title, detail, state, onClick }: { number: string; title: string; detail: string; state: "ready" | "action" | "next" | "locked" | "done"; onClick: () => void }) {
  const label = state === "done" ? "done" : state === "ready" ? "ready" : state === "next" ? "open" : state === "action" ? "configure" : "after prior step";
  return (
    <li className={`demo-step ${state}`}>
      <span className="demo-step-number">{number}</span>
      <div><strong>{title}</strong><p>{detail}</p></div>
      <button type="button" onClick={onClick}>{label}</button>
    </li>
  );
}

function ReadinessCard({ label, state, detail }: { label: string; state: EvidenceLabel; detail: string }) {
  return (
    <article className={`readiness-card ${evidenceTone(state)}`} data-readiness-state={state}>
      <span>{label}</span><strong>{state}</strong><p>{detail}</p>
    </article>
  );
}
