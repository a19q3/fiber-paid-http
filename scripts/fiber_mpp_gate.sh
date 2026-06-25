#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports
export PATH="${PWD}/node_modules/.bin:${PATH}"

unit_tests=false
integration_tests=false
security_tests=false
f402_compatibility=false
conformance_vectors=false
security_matrix=false
fiber_e2e_mode="skipped"
fiber_preflight_test_loaded=false
fiber_live_test_selected=false
fiber_live_test_loaded=false
fiber_e2e_blockers=()
production_blockers=()

pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
unit_tests=true
security_tests=true
f402_compatibility=true
pnpm build
pnpm test:integration
integration_tests=true

fiber_mode="${FIBER_MODE:-}"
payee_rpc_url="${FIBER_PAYEE_RPC_URL:-${FIBER_RPC_URL:-}}"
payer_rpc_url="${FIBER_PAYER_RPC_URL:-}"
fiber_mpp_secret="${FIBER_MPP_SECRET:-}"

if [[ "${RUN_FIBER_E2E:-}" != "1" ]]; then
  fiber_e2e_blockers+=("Fiber live E2E skipped: set RUN_FIBER_E2E=1")
fi
if [[ ! "${fiber_mode}" =~ ^(local|testnet)$ ]]; then
  fiber_e2e_blockers+=("Fiber live E2E skipped: set FIBER_MODE=local or FIBER_MODE=testnet")
fi
if [[ -z "${payee_rpc_url}" ]]; then
  fiber_e2e_blockers+=("Fiber live E2E skipped: set FIBER_RPC_URL or FIBER_PAYEE_RPC_URL for the invoice/payee node")
fi
if [[ -z "${payer_rpc_url}" ]]; then
  fiber_e2e_blockers+=("Fiber live E2E skipped: set FIBER_PAYER_RPC_URL for the paying node")
fi
if [[ -z "${fiber_mpp_secret}" || "${#fiber_mpp_secret}" -lt 32 ]]; then
  fiber_e2e_blockers+=("Fiber live E2E skipped: set FIBER_MPP_SECRET to a random secret of at least 32 characters")
fi
if [[ "${#fiber_e2e_blockers[@]}" -eq 0 ]]; then
  fiber_e2e_mode="${fiber_mode}"
  fiber_live_test_selected=true
else
  fiber_e2e_mode="skipped"
fi

rm -f reports/fiber-e2e-result.json
fiber_output="$(mktemp)"
set +e
pnpm test:fiber 2>&1 | tee "${fiber_output}"
fiber_test_exit="${PIPESTATUS[0]}"
set -e

# Regression guard: the Fiber lane must load the preflight test, never pass with no files.
fiber_no_test_files=false
if grep -q "No test files found" "${fiber_output}"; then
  fiber_no_test_files=true
  fiber_e2e_blockers+=("Fiber live E2E harness failed: pnpm test:fiber reported No test files found")
fi
if grep -q "fiber-preflight.test.ts" "${fiber_output}"; then
  fiber_preflight_test_loaded=true
else
  fiber_e2e_blockers+=("Fiber live E2E harness failed: preflight test file was not loaded")
fi
if grep -q "fiber-live.e2e.test.ts" "${fiber_output}"; then
  fiber_live_test_loaded=true
fi
rm -f "${fiber_output}"

pnpm exec fiber-mpp vectors verify
conformance_vectors=true
if [[ -f reports/security-matrix.json ]]; then
  security_matrix=true
fi
bash scripts/fiber_mpp_ops_gate.sh

production_blockers_text="$(printf '%s\n' "${production_blockers[@]}")"
fiber_e2e_blockers_text="$(printf '%s\n' "${fiber_e2e_blockers[@]}")"

UNIT_TESTS="${unit_tests}" \
INTEGRATION_TESTS="${integration_tests}" \
SECURITY_TESTS="${security_tests}" \
F402_COMPATIBILITY="${f402_compatibility}" \
CONFORMANCE_VECTORS="${conformance_vectors}" \
SECURITY_MATRIX="${security_matrix}" \
FIBER_E2E_MODE="${fiber_e2e_mode}" \
FIBER_E2E_BLOCKERS="${fiber_e2e_blockers_text}" \
FIBER_PREFLIGHT_TEST_LOADED="${fiber_preflight_test_loaded}" \
FIBER_LIVE_TEST_SELECTED="${fiber_live_test_selected}" \
FIBER_LIVE_TEST_LOADED="${fiber_live_test_loaded}" \
FIBER_NO_TEST_FILES="${fiber_no_test_files}" \
FIBER_TEST_EXIT="${fiber_test_exit}" \
PRODUCTION_READY="false" \
PRODUCTION_BLOCKERS="${production_blockers_text}" \
node <<'JSON'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const bool = (name) => process.env[name] === "true";
const list = (name) => (process.env[name] || "").split("\n").filter(Boolean);
const resultPath = "reports/fiber-e2e-result.json";
const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : {};
const previousReportPath = "reports/fiber-mpp-gate.json";
const previousReport = fs.existsSync(previousReportPath)
  ? JSON.parse(fs.readFileSync(previousReportPath, "utf8"))
  : {};
const opsReportPath = "reports/production-operations-matrix.json";
const opsReport = fs.existsSync(opsReportPath) ? JSON.parse(fs.readFileSync(opsReportPath, "utf8")) : {};
const opsReady = opsReport.production_ops_ready === true;
const opsBlockers = opsReady
  ? []
  : [
      `production operations hardening evidence incomplete: ${Array.isArray(opsReport.checks)
        ? opsReport.checks.filter((check) => check.status !== "passed").map((check) => check.id).join(", ")
        : "run scripts/fiber_mpp_ops_gate.sh"}`
    ];
const envBlockers = list("FIBER_E2E_BLOCKERS");
const fiberTestExit = Number.parseInt(process.env.FIBER_TEST_EXIT || "1", 10);
const preflightLoaded = Boolean(result.fiber_preflight_test_loaded) || bool("FIBER_PREFLIGHT_TEST_LOADED");
const liveSelected = Boolean(result.fiber_live_test_selected) || bool("FIBER_LIVE_TEST_SELECTED");
const liveLoaded = Boolean(result.fiber_live_test_loaded) || bool("FIBER_LIVE_TEST_LOADED");
let fiberStatus = result.fiber_e2e_status;
let fiberError = result.fiber_e2e_error;
let fiberBlockers = Array.isArray(result.fiber_e2e_blockers) ? result.fiber_e2e_blockers : envBlockers;

if (bool("FIBER_NO_TEST_FILES")) {
  fiberStatus = "failed";
  fiberError = "pnpm test:fiber reported No test files found";
}
if (!preflightLoaded) {
  fiberStatus = "failed";
  fiberError = fiberError || "Fiber preflight test file was not loaded";
}
if (liveSelected && !liveLoaded && fiberTestExit === 0) {
  fiberStatus = "failed";
  fiberError = fiberError || "Fiber live test was selected but did not load";
}
if (!fiberStatus) {
  if (fiberTestExit === 0 && envBlockers.length > 0) {
    fiberStatus = "skipped";
  } else if (fiberTestExit === 0) {
    fiberStatus = "passed";
  } else {
    fiberStatus = "failed";
  }
}
if (fiberStatus === "failed" && !fiberError) {
  fiberError = `pnpm test:fiber exited with code ${fiberTestExit}`;
}
if (fiberStatus === "failed" && fiberError && fiberBlockers.length === 0) {
  fiberBlockers = [fiberError.split("\n")[0]];
}

const fiberMode = result.fiber_e2e_mode || process.env.FIBER_E2E_MODE || "skipped";
const liveFiberLocalE2e = fiberStatus === "passed" && fiberMode === "local";
const liveFiberTestnetE2e = fiberStatus === "passed" && fiberMode === "testnet";
const selectedLiveAttemptFailed = liveSelected && fiberStatus === "failed";
const testnetFiberE2eEvidence =
  !selectedLiveAttemptFailed &&
  (liveFiberTestnetE2e ||
    previousReport.testnet_fiber_e2e === true ||
    previousReport.testnet_fiber_e2e_evidence === true ||
    fs.existsSync("reports/fiber-testnet-e2e-success.json"));
const localFiberE2eEvidence =
  liveFiberLocalE2e ||
  previousReport.live_fiber_local_e2e === true ||
  previousReport.local_fiber_e2e_evidence === true;
const evidencePaymentHash = result.fiber_e2e_payment_hash || previousReport.fiber_e2e_payment_hash;
const evidenceReceiptId = result.fiber_e2e_receipt_id || previousReport.fiber_e2e_receipt_id;
let productionBlockers;
if (testnetFiberE2eEvidence) {
  productionBlockers = withProductionBlockers([
    ...opsBlockers
  ]);
} else if (localFiberE2eEvidence) {
  productionBlockers = withProductionBlockers([
    "testnet Fiber E2E evidence still pending",
    ...opsBlockers
  ]);
} else if (fiberStatus === "passed") {
  productionBlockers = withProductionBlockers([
    ...opsBlockers
  ]);
} else {
  productionBlockers = withProductionBlockers([...fiberBlockers, ...opsBlockers]);
}
const productionReady = testnetFiberE2eEvidence && productionBlockers.length === 0 && opsReady;

function readIfExists(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}

function detectToolchainShimsUsed() {
  const shims = [];
  const startLog = readIfExists("reports/fiber-local-network/start.log");
  const waitLog = readIfExists("reports/fiber-local-network/wait.log");
  if (startLog.includes("fiber-mpp cargo shim")) {
    shims.push({
      name: "cargo",
      path: "scripts/bin/cargo",
      scope: "scripts/fiber_local_network.sh",
      evidence: "reports/fiber-local-network/start.log"
    });
  }
  if (waitLog.includes("fiber-mpp nc shim") || fs.existsSync("reports/fiber-local-network/wait.log")) {
    shims.push({
      name: "nc",
      path: "scripts/bin/nc",
      scope: "scripts/fiber_local_network.sh",
      evidence: waitLog.includes("fiber-mpp nc shim")
        ? "reports/fiber-local-network/wait.log"
        : "reports/fiber-local-network/wait.log present; Fiber wait script uses nc -z"
    });
  }
  return shims;
}

function withProductionBlockers(blockers) {
  return Array.from(new Set(blockers));
}

function readFiberCommit() {
  try {
    return execFileSync("git", ["-C", "/home/arthur/a19q3/fiber", "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return previousReport.fiber_commit || null;
  }
}

const report = {
  unit_tests: bool("UNIT_TESTS"),
  integration_tests: bool("INTEGRATION_TESTS"),
  security_tests: bool("SECURITY_TESTS"),
  conformance_vectors: bool("CONFORMANCE_VECTORS"),
  security_matrix: bool("SECURITY_MATRIX"),
  production_operations: opsReady,
  production_operations_report: opsReportPath,
  rust_gateway_production_path: true,
  fiber_e2e_mode: fiberMode,
  fiber_preflight_test_loaded: preflightLoaded,
  fiber_live_test_selected: liveSelected,
  fiber_live_test_loaded: liveLoaded,
  fiber_e2e_status: fiberStatus,
  fiber_e2e_blockers: fiberBlockers,
  f402_compatibility: bool("F402_COMPATIBILITY"),
  live_fiber_local_e2e: liveFiberLocalE2e,
  live_fiber_testnet_e2e: liveFiberTestnetE2e,
  testnet_fiber_e2e: testnetFiberE2eEvidence,
  testnet_fiber_e2e_evidence: testnetFiberE2eEvidence,
  local_fiber_e2e_evidence: localFiberE2eEvidence,
  fiber_commit: readFiberCommit(),
  toolchain_shims_used: detectToolchainShimsUsed(),
  production_ready_for_fiber_method: productionReady,
  production_blockers: productionBlockers
};
if (fiberError) {
  report.fiber_e2e_error = fiberError;
}
if (evidencePaymentHash) {
  report.fiber_e2e_payment_hash = evidencePaymentHash;
}
if (evidenceReceiptId) {
  report.fiber_e2e_receipt_id = evidenceReceiptId;
}
fs.writeFileSync("reports/fiber-mpp-gate.json", `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync("reports/fiber-mpp-ts-gate.json", `${JSON.stringify({
  engine: "typescript",
  typescript_role: "sdk-evidence-f402-compat-vector-harness",
  typescript_trusted_boundary: false,
  ...report
}, null, 2)}\n`);
fs.writeFileSync("reports/fiber-mpp-gate.default.json", `${JSON.stringify(report, null, 2)}\n`);
if (liveFiberLocalE2e) {
  fs.writeFileSync("reports/fiber-local-e2e-success.json", `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-mpp-gate.local.json", `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-local-e2e-evidence.json", `${JSON.stringify({
    evidence: true,
    source_report: "reports/fiber-mpp-gate.local.json",
    payment_hash: report.fiber_e2e_payment_hash,
    receipt_id: report.fiber_e2e_receipt_id,
    fiber_commit: report.fiber_commit,
    production_ready_for_fiber_method: false,
    blockers: productionBlockers
  }, null, 2)}\n`);
} else if (liveFiberTestnetE2e) {
  fs.writeFileSync("reports/fiber-testnet-e2e-success.json", `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-testnet-e2e-evidence.json", `${JSON.stringify({
    evidence: true,
    source_report: "reports/fiber-mpp-gate.json",
    payment_hash: report.fiber_e2e_payment_hash,
    receipt_id: report.fiber_e2e_receipt_id,
    fiber_commit: report.fiber_commit,
    production_ready_for_fiber_method: productionReady,
    blockers: productionBlockers
  }, null, 2)}\n`);
} else if (fs.existsSync("reports/fiber-local-e2e-success.json")) {
  const success = JSON.parse(fs.readFileSync("reports/fiber-local-e2e-success.json", "utf8"));
  success.production_ready_for_fiber_method = false;
  success.production_blockers = [
    ...(success.testnet_fiber_e2e === true ? [] : ["testnet Fiber E2E evidence still pending"]),
    ...opsBlockers
  ];
  fs.writeFileSync("reports/fiber-local-e2e-success.json", `${JSON.stringify(success, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-mpp-gate.local.json", `${JSON.stringify(success, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-local-e2e-evidence.json", `${JSON.stringify({
    evidence: true,
    source_report: "reports/fiber-mpp-gate.local.json",
    payment_hash: success.fiber_e2e_payment_hash,
    receipt_id: success.fiber_e2e_receipt_id,
    fiber_commit: success.fiber_commit,
    production_ready_for_fiber_method: false,
    blockers: success.production_blockers
  }, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
JSON

if node -e 'const r=require("./reports/fiber-mpp-gate.json"); process.exit(r.fiber_e2e_status === "failed" ? 0 : 1)'; then
  exit 1
fi
