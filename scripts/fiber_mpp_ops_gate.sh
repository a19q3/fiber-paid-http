#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports

node <<'JSON'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { productionBootstrapReadiness } = require("./scripts/lib/production-bootstrap-readiness.cjs");
const {
  normalizePreservedTestnetEvidence,
  verifyPreservedTestnetEvidence
} = require("./scripts/lib/testnet-fiber-evidence-readiness.cjs");

const requiredFiles = [
  "docs/production-operations.md",
  "docs/fiber-client-wallet-integration-plan.md",
  "deploy/prometheus/fiber-mpp-alerts.yml"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing production operations artifact: ${file}`);
  }
}

const runbook = fs.readFileSync("docs/production-operations.md", "utf8");
const walletPlan = fs.readFileSync("docs/fiber-client-wallet-integration-plan.md", "utf8");
const alerts = fs.readFileSync("deploy/prometheus/fiber-mpp-alerts.yml", "utf8");

const checks = [
  {
    id: "prometheus_alert_rules",
    evidence: "deploy/prometheus/fiber-mpp-alerts.yml",
    required: [
      "FiberMppGatewayReadinessFailing",
      "FiberMppGatewayHigh5xxRate",
      "FiberMppGatewayRateLimited",
      "FiberMppGatewayNoTraffic",
      "fiber_mpp_gateway_readiness_failures_total",
      "fiber_mpp_gateway_responses_total",
      "fiber_mpp_gateway_rate_limit_rejections_total",
      "fiber_mpp_gateway_requests_total"
    ],
    source: alerts
  },
  {
    id: "operator_runbook",
    evidence: "docs/production-operations.md",
    required: ["/healthz", "/readyz", "/metrics", "fiber-mpp doctor --role gateway", "incident"],
    source: runbook
  },
  {
    id: "fiber_node_backup_restore",
    evidence: "docs/production-operations.md",
    required: ["ckb/key", "fiber/store", "FIBER_SECRET_KEY_PASSWORD", "fnn-migrate", "restore drill"],
    source: runbook
  },
  {
    id: "trusted_network_binding",
    evidence: "docs/production-operations.md",
    required: ["127.0.0.1", "private", "Do not expose FNN JSON-RPC", "RPC auth", "firewall"],
    source: runbook
  },
  {
    id: "paid_but_denied_reconciliation",
    evidence: "docs/production-operations.md",
    required: ["paid-but-denied", "list-deliveries", "Do not mark the credential reusable", "Do not reissue a receipt", "refund/credit"],
    source: runbook
  },
  {
    id: "client_wallet_boundary",
    evidence: "docs/fiber-client-wallet-integration-plan.md",
    required: ["Direct FNN JSON-RPC", "fiber-pay", "CCC", "WalletConnect", "not a first-class Fiber payment provider"],
    source: walletPlan
  }
].map((check) => {
  const missing = check.required.filter((needle) => !check.source.includes(needle));
  return {
    id: check.id,
    status: missing.length === 0 ? "passed" : "failed",
    evidence: check.evidence,
    missing
  };
});

const failed = checks.filter((check) => check.status !== "passed");
const productionBootstrap = fs.existsSync("reports/production-bootstrap-e2e.json")
  ? JSON.parse(fs.readFileSync("reports/production-bootstrap-e2e.json", "utf8"))
  : {};
const testnetEvidencePath = "reports/fiber-testnet-e2e-success.json";
let testnetEvidenceReport = fs.existsSync(testnetEvidencePath)
  ? JSON.parse(fs.readFileSync(testnetEvidencePath, "utf8"))
  : null;
const currentFiberCommit = readFiberCommit();
const testnetEvidenceRecordedAt = readTestnetEvidenceRecordedAt(testnetEvidenceReport);
testnetEvidenceReport = normalizePreservedTestnetEvidence(testnetEvidenceReport, {
  fallbackRecordedAt: testnetEvidenceRecordedAt
});
const testnetEvidenceCheck = verifyPreservedTestnetEvidence(testnetEvidenceReport, {
  path: testnetEvidencePath,
  expectedFiberCommit: currentFiberCommit,
  fallbackRecordedAt: testnetEvidenceRecordedAt
});
const testnetEvidence = testnetEvidenceCheck.verified;
const productionBootstrapCheck = productionBootstrapReadiness(productionBootstrap);
const productionBootstrapReady = productionBootstrapCheck.ready;
const remainingBlockers = [
  ...(testnetEvidence ? [] : ["testnet Fiber E2E evidence still pending"]),
  ...(productionBootstrapReady ? [] : [`production bootstrap E2E readiness evidence still pending: ${productionBootstrapCheck.missing.join(", ") || "reports/production-bootstrap-e2e.json missing"}`]),
  ...(failed.length === 0 ? [] : ["production operations hardening evidence incomplete"])
];
const report = {
  production_ops_ready: failed.length === 0,
  testnet_fiber_e2e: testnetEvidence,
  testnet_fiber_e2e_evidence: testnetEvidence,
  testnet_fiber_e2e_evidence_report: testnetEvidencePath,
  testnet_evidence_recorded_at: testnetEvidenceCheck.recordedAt,
  testnet_evidence_digest: testnetEvidenceCheck.evidenceDigest,
  testnet_fiber_e2e_evidence_verified: testnetEvidenceCheck.verified,
  testnet_fiber_e2e_evidence_blockers: testnetEvidenceCheck.blockers,
  fiber_commit: currentFiberCommit,
  production_bootstrap_e2e: productionBootstrapReady,
  production_bootstrap_e2e_blockers: productionBootstrapCheck.missing,
  production_ready_for_fiber_method: remainingBlockers.length === 0,
  artifacts: {
    runbook: "docs/production-operations.md",
    alert_rules: "deploy/prometheus/fiber-mpp-alerts.yml",
    client_wallet_plan: "docs/fiber-client-wallet-integration-plan.md"
  },
  checks,
  remaining_blockers: remainingBlockers
};

fs.writeFileSync("reports/production-operations-matrix.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (failed.length > 0) {
  process.exit(1);
}

function readFiberCommit() {
  try {
    return execFileSync("git", ["-C", "/home/arthur/a19q3/fiber", "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return null;
  }
}

function readTestnetEvidenceRecordedAt(report) {
  if (report && typeof report === "object") {
    const direct =
      report.testnet_evidence_recorded_at ||
      report.generated_at ||
      report.gate_report?.testnet_evidence_recorded_at ||
      report.gate_report?.generated_at;
    if (direct) {
      return direct;
    }
  }
  const wrapperPath = "reports/fiber-testnet-e2e/testnet-e2e-report.json";
  if (!fs.existsSync(wrapperPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(wrapperPath, "utf8")).generated_at || null;
}
JSON
