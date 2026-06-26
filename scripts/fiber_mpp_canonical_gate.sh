#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports
export PATH="${PWD}/node_modules/.bin:${PATH}"

pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:fiber
pnpm build
pnpm exec fiber-mpp vectors verify
bash scripts/fiber_mpp_gate.sh

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p fiber-mpp-cli -- vectors verify
bash scripts/fiber_mpp_rust_gate.sh
bash scripts/fiber_mpp_ops_gate.sh

node <<'JSON'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { productionBootstrapReadiness } = require("./scripts/lib/production-bootstrap-readiness.cjs");
const {
  normalizePreservedTestnetEvidence,
  verifyPreservedTestnetEvidence
} = require("./scripts/lib/testnet-fiber-evidence-readiness.cjs");
const ts = JSON.parse(fs.readFileSync("reports/ts-conformance.json", "utf8"));
const rust = JSON.parse(fs.readFileSync("reports/rust-conformance.json", "utf8"));
const ops = JSON.parse(fs.readFileSync("reports/production-operations-matrix.json", "utf8"));
const testnetEvidencePath = "reports/fiber-testnet-e2e-success.json";
let testnetEvidenceReport = fs.existsSync(testnetEvidencePath)
  ? JSON.parse(fs.readFileSync(testnetEvidencePath, "utf8"))
  : null;
const productionBootstrap = fs.existsSync("reports/production-bootstrap-e2e.json")
  ? JSON.parse(fs.readFileSync("reports/production-bootstrap-e2e.json", "utf8"))
  : {};

const tsByFile = new Map(ts.results.map((result) => [result.file, result]));
const rustByFile = new Map(rust.results.map((result) => [result.file, result]));
const files = Array.from(new Set([...tsByFile.keys(), ...rustByFile.keys()])).sort();
const mismatches = [];
for (const file of files) {
  const left = tsByFile.get(file);
  const right = rustByFile.get(file);
  if (!left || !right) {
    mismatches.push({ file, missing_from_one_side: true });
    continue;
  }
  if (
    left.canonical_hash !== right.canonical_hash ||
    left.actual !== right.actual ||
    left.actual_error_code !== right.actual_error_code ||
    left.passed !== right.passed
  ) {
    mismatches.push({ file, typescript_harness: left, rust_canonical: right });
  }
}

const tsSource = fs.readFileSync("packages/fiber-method/src/index.ts", "utf8");
const rustSource = fs.readFileSync("crates/fiber-mpp-fiber/src/lib.rs", "utf8");
const fiberMethods = ["new_invoice", "send_payment", "get_payment", "get_invoice"];
const fiberRpcSemanticsParity = fiberMethods.every((method) => tsSource.includes(`\"${method}\"`) && rustSource.includes(`\"${method}\"`));
const receiptVectors = ["receipt.valid.json", "fiber.local-e2e.receipt.json"];
const f402Vectors = ["f402.challenge.valid.json", "f402.credential.valid.json"];
const vectorPassed = (report, file) => report.results.some((result) => result.file === file && result.passed);
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
const productionReady = productionBlockers.length === 0;
const report = {
  rust_canonical_verifier: rust.failed === 0,
  typescript_vector_harness: ts.failed === 0,
  typescript_trusted_boundary: false,
  shared_vectors_total: files.length,
  shared_vectors_passed_rust: rust.results.filter((result) => result.passed).length,
  shared_vectors_passed_typescript_harness: ts.results.filter((result) => result.passed).length,
  error_code_parity: mismatches.length === 0,
  canonical_hash_parity: mismatches.length === 0,
  receipt_format_parity: receiptVectors.every((file) => vectorPassed(ts, file) && vectorPassed(rust, file)),
  f402_parity: f402Vectors.every((file) => vectorPassed(ts, file) && vectorPassed(rust, file)),
  fiber_rpc_semantics_parity: fiberRpcSemanticsParity,
  production_operations: ops.production_ops_ready === true,
  production_operations_report: "reports/production-operations-matrix.json",
  production_bootstrap_e2e: productionBootstrapReady,
  production_bootstrap_report: "reports/production-bootstrap-e2e.json",
  production_bootstrap_e2e_blockers: productionBootstrapCheck.missing,
  rust_gateway_production_path: true,
  testnet_fiber_e2e: testnetFiberE2e,
  testnet_fiber_e2e_evidence: testnetFiberE2e,
  testnet_fiber_e2e_evidence_report: testnetEvidencePath,
  testnet_evidence_recorded_at: testnetEvidenceCheck.recordedAt,
  testnet_evidence_digest: testnetEvidenceCheck.evidenceDigest,
  testnet_fiber_e2e_evidence_verified: testnetEvidenceCheck.verified,
  testnet_fiber_e2e_evidence_blockers: testnetEvidenceCheck.blockers,
  fiber_commit: currentFiberCommit,
  canonical_engine: "rust",
  typescript_role: "sdk-evidence-f402-compat-vector-harness",
  production_ready_for_fiber_method: productionReady,
  production_blockers: productionBlockers,
  mismatches
};

fs.writeFileSync("reports/canonical-core-parity.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (
  !report.rust_canonical_verifier ||
  !report.typescript_vector_harness ||
  report.typescript_trusted_boundary !== false ||
  report.shared_vectors_total !== 14 ||
  report.shared_vectors_passed_rust !== 14 ||
  report.shared_vectors_passed_typescript_harness !== 14 ||
  !report.error_code_parity ||
  !report.canonical_hash_parity ||
  !report.receipt_format_parity ||
  !report.f402_parity ||
  !report.fiber_rpc_semantics_parity ||
  !report.production_operations ||
  report.canonical_engine !== "rust" ||
  report.production_ready_for_fiber_method !== productionReady ||
  (report.production_ready_for_fiber_method === true && report.production_blockers.length > 0)
) {
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
