#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports

node <<'JSON'
const fs = require("node:fs");

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
const report = {
  production_ops_ready: failed.length === 0,
  production_ready_for_fiber_method: false,
  artifacts: {
    runbook: "docs/production-operations.md",
    alert_rules: "deploy/prometheus/fiber-mpp-alerts.yml",
    client_wallet_plan: "docs/fiber-client-wallet-integration-plan.md"
  },
  checks,
  remaining_blockers: [
    "testnet Fiber E2E evidence still pending"
  ]
};

fs.writeFileSync("reports/production-operations-matrix.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (failed.length > 0) {
  process.exit(1);
}
JSON
