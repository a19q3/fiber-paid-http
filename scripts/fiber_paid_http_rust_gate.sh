#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p fiber-paid-http-cli -- vectors verify
bash scripts/fiber_paid_http_ops_gate.sh

node <<'JSON'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { productionBootstrapReadiness } = require("./scripts/lib/production-bootstrap-readiness.cjs");
const {
  normalizePreservedTestnetEvidence,
  verifyPreservedTestnetEvidence
} = require("./scripts/lib/testnet-fiber-evidence-readiness.cjs");
const conformance = JSON.parse(fs.readFileSync("reports/rust-conformance.json", "utf8"));
const ops = JSON.parse(fs.readFileSync("reports/production-operations-matrix.json", "utf8"));
const testnetEvidencePath = "reports/fiber-testnet-e2e-success.json";
let testnetEvidenceReport = fs.existsSync(testnetEvidencePath)
  ? JSON.parse(fs.readFileSync(testnetEvidencePath, "utf8"))
  : null;
const productionBootstrap = fs.existsSync("reports/production-bootstrap-e2e.json")
  ? JSON.parse(fs.readFileSync("reports/production-bootstrap-e2e.json", "utf8"))
  : {};
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
const testnetFiberE2e = testnetEvidenceCheck.verified;
const productionBootstrapCheck = productionBootstrapReadiness(productionBootstrap);
const productionBootstrapReady = productionBootstrapCheck.ready;
const productionBlockers = [
  ...(testnetFiberE2e ? [] : ["testnet Fiber E2E evidence still pending"]),
  ...(productionBootstrapReady ? [] : [`production bootstrap E2E readiness evidence still pending: ${productionBootstrapCheck.missing.join(", ") || "reports/production-bootstrap-e2e.json missing"}`]),
  ...(ops.production_ops_ready === true ? [] : ["production operations hardening evidence incomplete"])
];
const report = {
  engine: "rust",
  canonical_engine: true,
  trusted_boundary: "rust",
  cargo_fmt: true,
  cargo_clippy: true,
  cargo_tests: true,
  rust_vectors: conformance.failed === 0,
  shared_vectors_total: conformance.shared_vectors_total,
  shared_vectors_passed_rust: conformance.shared_vectors_passed,
  fiber_rpc_semantics: {
    methods: ["new_invoice", "send_payment", "get_payment", "get_invoice"],
    numeric_encoding: "hex JSON quantities",
    settlement_statuses: {
      payment: "Success",
      invoice: "Paid"
    }
  },
  production_operations: ops.production_ops_ready === true,
  production_operations_report: "reports/production-operations-matrix.json",
  production_bootstrap_e2e: productionBootstrapReady,
  production_bootstrap_report: "reports/production-bootstrap-e2e.json",
  production_bootstrap_e2e_blockers: productionBootstrapCheck.missing,
  testnet_fiber_e2e: testnetFiberE2e,
  testnet_fiber_e2e_evidence: testnetFiberE2e,
  testnet_fiber_e2e_evidence_report: testnetEvidencePath,
  testnet_evidence_recorded_at: testnetEvidenceCheck.recordedAt,
  testnet_evidence_digest: testnetEvidenceCheck.evidenceDigest,
  testnet_fiber_e2e_evidence_verified: testnetEvidenceCheck.verified,
  testnet_fiber_e2e_evidence_blockers: testnetEvidenceCheck.blockers,
  fiber_commit: currentFiberCommit,
  rust_gateway_production_path: true,
  rust_gateway_evidence: {
    server_crate_tests: true,
    cli_server_command_starts_gateway: true,
    features: [
      "signed 402 challenge issuance",
      "Fiber invoice creation through FNN JSON-RPC",
      "Fiber settlement inspection through FNN JSON-RPC",
      "Authorization: Payment verification",
      "durable SQLite challenge/credential/receipt storage",
      "Payment-Receipt issuance",
      "replay rejection"
    ]
  },
  production_ready_for_fiber_method: productionBlockers.length === 0,
  production_blockers: productionBlockers
};
fs.writeFileSync("reports/fiber-paid-http-rust-gate.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function readFiberCommit() {
  for (const repo of fiberRepoCandidates()) {
    try {
      if (!fs.existsSync(repo)) continue;
      return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      // Try the next configured Fiber checkout.
    }
  }
  return null;
}

function fiberRepoCandidates() {
  return Array.from(new Set([
    process.env.FIBER_REPO,
    "/home/arthur/a19q3/fiber"
  ].filter(Boolean)));
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
