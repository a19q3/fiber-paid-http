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
evidence_console_layout=false
evidence_console_layout_blockers=()
evidence_console_action_coverage=false
evidence_console_action_coverage_blockers=()
evidence_console_server_hardening=false
evidence_console_server_hardening_blockers=()
evidence_console_cli_start=false
evidence_console_cli_start_blockers=()
evidence_console_browser_smoke=false
evidence_console_browser_smoke_blockers=()
fiber_e2e_mode="skipped"
fiber_preflight_test_loaded=false
fiber_live_test_selected=false
fiber_live_test_loaded=false
fiber_e2e_blockers=()
production_blockers=()

without_live_fiber_env() {
  env \
    -u RUN_FIBER_E2E \
    -u FIBER_MODE \
    -u FIBER_RPC_URL \
    -u FIBER_PAYEE_RPC_URL \
    -u FIBER_PAYER_RPC_URL \
    -u FIBER_ROUTER_RPC_URL \
    -u FIBER_RPC_AUTH \
    -u FIBER_PAYEE_RPC_AUTH \
    -u FIBER_PAYER_RPC_AUTH \
    -u FIBER_PAID_HTTP_SECRET \
    -u FIBER_PAID_HTTP_EVIDENCE_API_BASE \
    "$@"
}

pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
unit_tests=true
security_tests=true
f402_compatibility=true
pnpm build
layout_output="reports/evidence-console-layout.log"
set +e
pnpm --filter @fiber-paid-http/evidence-web check-layout 2>&1 | tee "${layout_output}"
layout_exit="${PIPESTATUS[0]}"
set -e
if [[ "${layout_exit}" -eq 0 ]]; then
  evidence_console_layout=true
else
  evidence_console_layout_blockers+=("Evidence console layout check failed: see ${layout_output}")
fi
action_coverage_output="reports/evidence-console-action-coverage.log"
set +e
pnpm --filter @fiber-paid-http/evidence-web check-action-coverage 2>&1 | tee "${action_coverage_output}"
action_coverage_exit="${PIPESTATUS[0]}"
set -e
if [[ "${action_coverage_exit}" -eq 0 ]]; then
  evidence_console_action_coverage=true
else
  evidence_console_action_coverage_blockers+=("Evidence console action coverage check failed: see ${action_coverage_output}")
fi
server_hardening_output="reports/evidence-console-server-hardening.log"
set +e
pnpm --filter @fiber-paid-http/evidence-web check-server 2>&1 | tee "${server_hardening_output}"
server_hardening_exit="${PIPESTATUS[0]}"
set -e
if [[ "${server_hardening_exit}" -eq 0 ]]; then
  evidence_console_server_hardening=true
else
  evidence_console_server_hardening_blockers+=("Evidence console server hardening check failed: see ${server_hardening_output}")
fi
cli_start_output="reports/evidence-console-cli-start.log"
cli_start_report="reports/evidence-console-cli-start.json"
set +e
without_live_fiber_env pnpm --filter @fiber-paid-http/evidence-web check-cli-start 2>&1 | tee "${cli_start_output}"
cli_start_exit="${PIPESTATUS[0]}"
set -e
if [[ "${cli_start_exit}" -eq 0 ]]; then
  evidence_console_cli_start=true
else
  evidence_console_cli_start_blockers+=("Evidence console CLI start check failed: see ${cli_start_output}")
fi
browser_smoke_output="reports/evidence-console-browser-smoke.log"
browser_smoke_report="reports/evidence-console-browser-smoke.json"
set +e
pnpm --filter @fiber-paid-http/evidence-web check-browser-smoke 2>&1 | tee "${browser_smoke_output}"
browser_smoke_exit="${PIPESTATUS[0]}"
set -e
if [[ "${browser_smoke_exit}" -eq 0 ]]; then
  set +e
  node <<'JSON'
const fs = require("node:fs");
const reportPath = "reports/evidence-console-browser-smoke.json";
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const evidence = report.completed_flow_evidence || {};
const missing = [];
for (const field of ["challenge_id", "resource_hash", "payment_hash", "receipt_reference"]) {
  if (!evidence[field]) missing.push(`completed_flow_evidence.${field}`);
}
if (!/^[A-Za-z0-9_-]{43}$/.test(evidence.challenge_id || "")) missing.push("completed_flow_evidence.challenge_id_format");
if (!/^[0-9a-f]{64}$/i.test(evidence.resource_hash || "")) missing.push("completed_flow_evidence.resource_hash_format");
if (!/^0x[0-9a-f]{64}$/i.test(evidence.payment_hash || "")) missing.push("completed_flow_evidence.payment_hash_format");
if (!/^0x[0-9a-f]{64}$/i.test(evidence.receipt_reference || "")) missing.push("completed_flow_evidence.receipt_reference_format");
if ((evidence.payment_hash || "").toLowerCase() !== (evidence.receipt_reference || "").toLowerCase()) missing.push("completed_flow_evidence.payment_receipt_reference_match");
if (evidence.service_executed !== "executed after receipt") missing.push("completed_flow_evidence.service_executed");
if (evidence.replay_status !== "blocked") missing.push("completed_flow_evidence.replay_status");
if (evidence.receipt_reissued !== "false") missing.push("completed_flow_evidence.receipt_reissued");
if (report.reset_evidence_after_clear !== true) missing.push("reset_evidence_after_clear");
if (report.api_base !== "temporary-local-api") missing.push("api_base");
if (report.web_origin !== "served-local-web-server") missing.push("web_origin");
if (report.api_base_source !== "served HTML injected by evidence web server") missing.push("api_base_source");
if (missing.length > 0) {
  console.error(`Evidence console browser smoke report missing semantic proof: ${missing.join(", ")}`);
  process.exit(1);
}
JSON
  browser_smoke_report_exit="${PIPESTATUS[0]}"
  set -e
  if [[ "${browser_smoke_report_exit}" -eq 0 ]]; then
    evidence_console_browser_smoke=true
  else
    evidence_console_browser_smoke_blockers+=("Evidence console browser smoke report is incomplete: see ${browser_smoke_report}")
  fi
else
  evidence_console_browser_smoke_blockers+=("Evidence console browser smoke check failed: see ${browser_smoke_output}")
fi
without_live_fiber_env pnpm test:integration
integration_tests=true

fiber_mode="${FIBER_MODE:-}"
payee_rpc_url="${FIBER_PAYEE_RPC_URL:-${FIBER_RPC_URL:-}}"
payer_rpc_url="${FIBER_PAYER_RPC_URL:-}"
fiber_paid_http_secret="${FIBER_PAID_HTTP_SECRET:-}"

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
if [[ -z "${fiber_paid_http_secret}" || "${#fiber_paid_http_secret}" -lt 32 ]]; then
  fiber_e2e_blockers+=("Fiber live E2E skipped: set FIBER_PAID_HTTP_SECRET to a random secret of at least 32 characters")
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

pnpm exec fiber-paid-http vectors verify
conformance_vectors=true
if [[ -f reports/security-matrix.json ]]; then
  security_matrix=true
fi
bash scripts/fiber_paid_http_ops_gate.sh

set +u
production_blockers_text="$(printf '%s\n' "${production_blockers[@]}")"
fiber_e2e_blockers_text="$(printf '%s\n' "${fiber_e2e_blockers[@]}")"
evidence_console_layout_blockers_text="$(printf '%s\n' "${evidence_console_layout_blockers[@]}")"
evidence_console_action_coverage_blockers_text="$(printf '%s\n' "${evidence_console_action_coverage_blockers[@]}")"
evidence_console_server_hardening_blockers_text="$(printf '%s\n' "${evidence_console_server_hardening_blockers[@]}")"
evidence_console_cli_start_blockers_text="$(printf '%s\n' "${evidence_console_cli_start_blockers[@]}")"
evidence_console_browser_smoke_blockers_text="$(printf '%s\n' "${evidence_console_browser_smoke_blockers[@]}")"
set -u

UNIT_TESTS="${unit_tests}" \
INTEGRATION_TESTS="${integration_tests}" \
SECURITY_TESTS="${security_tests}" \
F402_COMPATIBILITY="${f402_compatibility}" \
CONFORMANCE_VECTORS="${conformance_vectors}" \
SECURITY_MATRIX="${security_matrix}" \
EVIDENCE_CONSOLE_LAYOUT="${evidence_console_layout}" \
EVIDENCE_CONSOLE_LAYOUT_BLOCKERS="${evidence_console_layout_blockers_text}" \
EVIDENCE_CONSOLE_LAYOUT_REPORT="${layout_output}" \
EVIDENCE_CONSOLE_ACTION_COVERAGE="${evidence_console_action_coverage}" \
EVIDENCE_CONSOLE_ACTION_COVERAGE_BLOCKERS="${evidence_console_action_coverage_blockers_text}" \
EVIDENCE_CONSOLE_ACTION_COVERAGE_REPORT="reports/evidence-console-action-coverage.json" \
EVIDENCE_CONSOLE_SERVER_HARDENING="${evidence_console_server_hardening}" \
EVIDENCE_CONSOLE_SERVER_HARDENING_BLOCKERS="${evidence_console_server_hardening_blockers_text}" \
EVIDENCE_CONSOLE_SERVER_HARDENING_REPORT="${server_hardening_output}" \
EVIDENCE_CONSOLE_CLI_START="${evidence_console_cli_start}" \
EVIDENCE_CONSOLE_CLI_START_BLOCKERS="${evidence_console_cli_start_blockers_text}" \
EVIDENCE_CONSOLE_CLI_START_REPORT="${cli_start_report}" \
EVIDENCE_CONSOLE_BROWSER_SMOKE="${evidence_console_browser_smoke}" \
EVIDENCE_CONSOLE_BROWSER_SMOKE_BLOCKERS="${evidence_console_browser_smoke_blockers_text}" \
EVIDENCE_CONSOLE_BROWSER_SMOKE_REPORT="${browser_smoke_report}" \
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
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { productionBootstrapReadiness } = require("./scripts/lib/production-bootstrap-readiness.cjs");
const {
  TESTNET_EVIDENCE_SCHEMA,
  computeTestnetEvidenceDigest,
  verifyPreservedTestnetEvidence
} = require("./scripts/lib/testnet-fiber-evidence-readiness.cjs");
const bool = (name) => process.env[name] === "true";
const list = (name) => (process.env[name] || "").split("\n").filter(Boolean);
const resultPath = "reports/fiber-e2e-result.json";
const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : {};
const previousReportPath = "reports/fiber-paid-http-gate.json";
const previousReport = fs.existsSync(previousReportPath)
  ? JSON.parse(fs.readFileSync(previousReportPath, "utf8"))
  : {};
const opsReportPath = "reports/production-operations-matrix.json";
const opsReport = fs.existsSync(opsReportPath) ? JSON.parse(fs.readFileSync(opsReportPath, "utf8")) : {};
const opsReady = opsReport.production_ops_ready === true;
const productionBootstrapPath = "reports/production-bootstrap-e2e.json";
const productionBootstrapReport = fs.existsSync(productionBootstrapPath)
  ? JSON.parse(fs.readFileSync(productionBootstrapPath, "utf8"))
  : {};
const testnetEvidencePath = "reports/fiber-testnet-e2e-success.json";
const testnetEvidenceReport = readJsonIfExists(testnetEvidencePath);
const currentFiberCommit = readFiberCommit();
const productionBootstrapCheck = productionBootstrapReadiness(productionBootstrapReport, {
  expectedFiberCommit: currentFiberCommit
});
const productionBootstrapReady = productionBootstrapCheck.ready;
const testnetEvidenceCheck = verifyPreservedTestnetEvidence(testnetEvidenceReport, {
  path: testnetEvidencePath,
  expectedFiberCommit: currentFiberCommit
});
const opsBlockers = opsReady
  ? []
  : [
      `production operations hardening evidence incomplete: ${Array.isArray(opsReport.checks)
        ? opsReport.checks.filter((check) => check.status !== "passed").map((check) => check.id).join(", ")
        : "run scripts/fiber_paid_http_ops_gate.sh"}`
    ];
const envBlockers = list("FIBER_E2E_BLOCKERS");
const layoutBlockers = list("EVIDENCE_CONSOLE_LAYOUT_BLOCKERS");
const actionCoverageBlockers = list("EVIDENCE_CONSOLE_ACTION_COVERAGE_BLOCKERS");
const serverHardeningBlockers = list("EVIDENCE_CONSOLE_SERVER_HARDENING_BLOCKERS");
const cliStartBlockers = list("EVIDENCE_CONSOLE_CLI_START_BLOCKERS");
const cliStartReportPath = process.env.EVIDENCE_CONSOLE_CLI_START_REPORT || "reports/evidence-console-cli-start.json";
const cliStartReport = fs.existsSync(cliStartReportPath)
  ? JSON.parse(fs.readFileSync(cliStartReportPath, "utf8"))
  : {};
const cliStartVerified = cliStartReport.ok === true &&
  cliStartReport.api_and_web_started_by_single_cli_command === true &&
  cliStartReport.web_served_console === true &&
  typeof cliStartReport.injected_api_base === "string" &&
  /^http:\/\/(localhost|127\.0\.0\.1):[0-9]+$/.test(cliStartReport.injected_api_base);
const browserSmokeBlockers = list("EVIDENCE_CONSOLE_BROWSER_SMOKE_BLOCKERS");
const browserSmokeReportPath = process.env.EVIDENCE_CONSOLE_BROWSER_SMOKE_REPORT || "reports/evidence-console-browser-smoke.json";
const browserSmokeReport = fs.existsSync(browserSmokeReportPath)
  ? JSON.parse(fs.readFileSync(browserSmokeReportPath, "utf8"))
  : {};
const browserSmokeCompletedFlow = completedBrowserSmokeEvidence(browserSmokeReport.completed_flow_evidence);
const browserSmokeResetAfterClear = browserSmokeReport.reset_evidence_after_clear === true;
const browserSmokeServedWebOrigin = browserSmokeReport.web_origin === "served-local-web-server";
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
  (liveFiberTestnetE2e || testnetEvidenceCheck.verified);
const testnetFiberEvidenceVerified = liveFiberTestnetE2e || testnetEvidenceCheck.verified;
const testnetFiberEvidenceSource = liveFiberTestnetE2e ? "current-live-testnet-run" : testnetEvidencePath;
const localFiberE2eEvidence =
  liveFiberLocalE2e ||
  previousReport.live_fiber_local_e2e === true ||
  previousReport.local_fiber_e2e_evidence === true;
const evidencePaymentHash =
  result.fiber_e2e_payment_hash ||
  testnetEvidenceCheck.paymentHash ||
  previousReport.fiber_e2e_payment_hash;
const evidenceReceiptReference =
  result.fiber_e2e_receipt_reference ||
  testnetEvidenceCheck.receiptReference ||
  previousReport.fiber_e2e_receipt_reference;
const evidenceChallengeId =
  result.fiber_e2e_challenge_id ||
  testnetEvidenceCheck.challengeId ||
  previousReport.fiber_e2e_challenge_id;
let productionBlockers;
if (testnetFiberE2eEvidence) {
  productionBlockers = withProductionBlockers([
    ...(productionBootstrapReady ? [] : ["production bootstrap E2E readiness evidence still pending"]),
    ...opsBlockers
  ]);
} else if (localFiberE2eEvidence) {
  productionBlockers = withProductionBlockers([
    "testnet Fiber E2E evidence still pending",
    ...(productionBootstrapReady ? [] : ["production bootstrap E2E readiness evidence still pending"]),
    ...opsBlockers
  ]);
} else if (fiberStatus === "passed") {
  productionBlockers = withProductionBlockers([
    ...(fiberMode === "testnet" ? testnetEvidenceCheck.blockers : ["testnet Fiber E2E evidence still pending"]),
    ...(productionBootstrapReady ? [] : ["production bootstrap E2E readiness evidence still pending"]),
    ...opsBlockers
  ]);
} else {
  productionBlockers = withProductionBlockers([
    ...testnetEvidenceCheck.blockers,
    ...fiberBlockers,
    ...(productionBootstrapReady ? [] : ["production bootstrap E2E readiness evidence still pending"]),
    ...opsBlockers
  ]);
}
const productionReady = testnetFiberE2eEvidence && productionBootstrapReady && productionBlockers.length === 0 && opsReady;
const fiberPaidHttpGateBlockers = [
  ...productionBlockers,
  ...layoutBlockers,
  ...actionCoverageBlockers,
  ...serverHardeningBlockers,
  ...cliStartBlockers,
  ...(bool("EVIDENCE_CONSOLE_CLI_START") && !cliStartVerified ? ["Evidence console CLI start report is incomplete"] : []),
  ...browserSmokeBlockers,
  ...(fiberStatus === "failed" ? fiberBlockers : [])
];
const fiberPaidHttpGateReady =
  productionReady &&
  bool("EVIDENCE_CONSOLE_LAYOUT") &&
  bool("EVIDENCE_CONSOLE_ACTION_COVERAGE") &&
  bool("EVIDENCE_CONSOLE_SERVER_HARDENING") &&
  bool("EVIDENCE_CONSOLE_CLI_START") &&
  cliStartVerified &&
  bool("EVIDENCE_CONSOLE_BROWSER_SMOKE") &&
  fiberStatus !== "failed" &&
  fiberPaidHttpGateBlockers.length === 0;

function readIfExists(path, maxBytes = 1024 * 1024) {
  if (!fs.existsSync(path)) {
    return "";
  }
  const stat = fs.statSync(path);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(path, "utf8");
  }
  const fd = fs.openSync(path, "r");
  try {
    const start = stat.size - maxBytes;
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonIfExists(path) {
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
}

function detectToolchainShimsUsed() {
  const shims = [];
  const startLog = readIfExists("reports/fiber-local-network/start.log");
  const waitLog = readIfExists("reports/fiber-local-network/wait.log");
  if (startLog.includes("fiber-paid-http cargo shim")) {
    shims.push({
      name: "cargo",
      path: "scripts/bin/cargo",
      scope: "scripts/fiber_local_network.sh",
      evidence: "reports/fiber-local-network/start.log"
    });
  }
  if (waitLog.includes("fiber-paid-http nc shim") || fs.existsSync("reports/fiber-local-network/wait.log")) {
    shims.push({
      name: "nc",
      path: "scripts/bin/nc",
      scope: "scripts/fiber_local_network.sh",
      evidence: waitLog.includes("fiber-paid-http nc shim")
        ? "reports/fiber-local-network/wait.log"
        : "reports/fiber-local-network/wait.log present; Fiber wait script uses nc -z"
    });
  }
  return shims;
}

function withProductionBlockers(blockers) {
  return Array.from(new Set(blockers));
}

function completedBrowserSmokeEvidence(evidence) {
  return Boolean(
    evidence &&
    /^[A-Za-z0-9_-]{43}$/.test(evidence.challenge_id || "") &&
    /^[0-9a-f]{64}$/i.test(evidence.resource_hash || "") &&
    /^0x[0-9a-f]{64}$/i.test(evidence.payment_hash || "") &&
    /^0x[0-9a-f]{64}$/i.test(evidence.receipt_reference || "") &&
    evidence.payment_hash.toLowerCase() === evidence.receipt_reference.toLowerCase() &&
    evidence.service_executed === "executed after receipt" &&
    evidence.replay_status === "blocked" &&
    evidence.receipt_reissued === "false"
  );
}

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
    path.resolve(process.cwd(), "../fiber")
  ].filter(Boolean)));
}

const report = {
  unit_tests: bool("UNIT_TESTS"),
  integration_tests: bool("INTEGRATION_TESTS"),
  security_tests: bool("SECURITY_TESTS"),
  conformance_vectors: bool("CONFORMANCE_VECTORS"),
  security_matrix: bool("SECURITY_MATRIX"),
  evidence_console_layout: bool("EVIDENCE_CONSOLE_LAYOUT"),
  evidence_console_layout_report: process.env.EVIDENCE_CONSOLE_LAYOUT_REPORT || "reports/evidence-console-layout.log",
  evidence_console_layout_blockers: layoutBlockers,
  evidence_console_action_coverage: bool("EVIDENCE_CONSOLE_ACTION_COVERAGE"),
  evidence_console_action_coverage_report: process.env.EVIDENCE_CONSOLE_ACTION_COVERAGE_REPORT || "reports/evidence-console-action-coverage.json",
  evidence_console_action_coverage_blockers: actionCoverageBlockers,
  evidence_console_server_hardening: bool("EVIDENCE_CONSOLE_SERVER_HARDENING"),
  evidence_console_server_hardening_report: process.env.EVIDENCE_CONSOLE_SERVER_HARDENING_REPORT || "reports/evidence-console-server-hardening.log",
  evidence_console_server_hardening_blockers: serverHardeningBlockers,
  evidence_console_cli_start: bool("EVIDENCE_CONSOLE_CLI_START") && cliStartVerified,
  evidence_console_cli_start_report: cliStartReportPath,
  evidence_console_cli_start_api_base: cliStartReport.injected_api_base,
  evidence_console_cli_start_blockers: cliStartBlockers,
  evidence_console_browser_smoke: bool("EVIDENCE_CONSOLE_BROWSER_SMOKE"),
  evidence_console_browser_smoke_report: browserSmokeReportPath,
  evidence_console_browser_smoke_completed_flow: browserSmokeCompletedFlow,
  evidence_console_browser_smoke_reset_after_clear: browserSmokeResetAfterClear,
  evidence_console_browser_smoke_served_web_origin: browserSmokeServedWebOrigin,
  evidence_console_browser_smoke_api_base_source: browserSmokeReport.api_base_source,
  evidence_console_browser_smoke_blockers: browserSmokeBlockers,
  production_operations: opsReady,
  production_operations_report: opsReportPath,
  production_bootstrap_e2e: productionBootstrapReady,
  production_bootstrap_report: productionBootstrapPath,
  production_bootstrap_e2e_blockers: productionBootstrapCheck.missing,
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
  testnet_fiber_e2e_evidence_report: testnetEvidencePath,
  testnet_fiber_e2e_evidence_source: testnetFiberEvidenceSource,
  testnet_evidence_recorded_at: liveFiberTestnetE2e ? new Date().toISOString() : testnetEvidenceCheck.recordedAt,
  testnet_evidence_digest: testnetEvidenceCheck.evidenceDigest,
  testnet_fiber_e2e_evidence_verified: testnetFiberEvidenceVerified,
  testnet_fiber_e2e_evidence_blockers: testnetFiberEvidenceVerified ? [] : testnetEvidenceCheck.blockers,
  local_fiber_e2e_evidence: localFiberE2eEvidence,
  fiber_commit: currentFiberCommit,
  toolchain_shims_used: detectToolchainShimsUsed(),
  production_ready_for_fiber_method: productionReady,
  production_blockers: productionBlockers,
  fiber_paid_http_gate_ready: fiberPaidHttpGateReady,
  fiber_paid_http_gate_blockers: fiberPaidHttpGateBlockers
};
if (fiberError) {
  report.fiber_e2e_error = fiberError;
}
if (evidencePaymentHash) {
  report.fiber_e2e_payment_hash = evidencePaymentHash;
}
if (evidenceReceiptReference) {
  report.fiber_e2e_receipt_reference = evidenceReceiptReference;
}
if (evidenceChallengeId) {
  report.fiber_e2e_challenge_id = evidenceChallengeId;
}
let currentTestnetSuccessEvidence = null;
if (liveFiberTestnetE2e) {
  currentTestnetSuccessEvidence = createTestnetSuccessEvidence(report);
  currentTestnetSuccessEvidence.testnet_evidence_digest = computeTestnetEvidenceDigest(
    currentTestnetSuccessEvidence
  ).digest;
  report.testnet_evidence_digest = currentTestnetSuccessEvidence.testnet_evidence_digest;
}
fs.writeFileSync("reports/fiber-paid-http-gate.json", `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync("reports/fiber-paid-http-ts-gate.json", `${JSON.stringify({
  engine: "typescript",
  typescript_role: "sdk-evidence-f402-compat-vector-harness",
  typescript_trusted_boundary: false,
  ...report
}, null, 2)}\n`);
fs.writeFileSync("reports/fiber-paid-http-gate.default.json", `${JSON.stringify(report, null, 2)}\n`);
if (liveFiberLocalE2e) {
  fs.writeFileSync("reports/fiber-local-e2e-success.json", `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-paid-http-gate.local.json", `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-local-e2e-evidence.json", `${JSON.stringify({
    evidence: true,
    source_report: "reports/fiber-paid-http-gate.local.json",
    payment_hash: report.fiber_e2e_payment_hash,
    receipt_reference: report.fiber_e2e_receipt_reference,
    challenge_id: report.fiber_e2e_challenge_id,
    fiber_commit: report.fiber_commit,
    production_ready_for_fiber_method: false,
    blockers: productionBlockers
  }, null, 2)}\n`);
	} else if (liveFiberTestnetE2e) {
	  const success = currentTestnetSuccessEvidence;
	  fs.writeFileSync("reports/fiber-testnet-e2e-success.json", `${JSON.stringify(success, null, 2)}\n`);
	  fs.writeFileSync("reports/fiber-testnet-e2e-evidence.json", `${JSON.stringify({
	    evidence: true,
	    source_report: "reports/fiber-testnet-e2e-success.json",
	    testnet_evidence_recorded_at: success.testnet_evidence_recorded_at,
	    testnet_evidence_digest: success.testnet_evidence_digest,
	    payment_hash: success.fiber_e2e_payment_hash,
	    receipt_reference: success.fiber_e2e_receipt_reference,
	    challenge_id: success.fiber_e2e_challenge_id,
	    fiber_commit: success.fiber_commit,
    production_ready_for_fiber_method: productionReady,
    blockers: productionBlockers
  }, null, 2)}\n`);
} else if (fs.existsSync("reports/fiber-testnet-e2e-success.json")) {
	  fs.writeFileSync("reports/fiber-testnet-e2e-evidence.json", `${JSON.stringify({
	    evidence: testnetEvidenceCheck.verified,
	    source_report: "reports/fiber-testnet-e2e-success.json",
	    testnet_evidence_recorded_at: testnetEvidenceCheck.recordedAt,
	    testnet_evidence_digest: testnetEvidenceCheck.evidenceDigest,
	    payment_hash: testnetEvidenceCheck.paymentHash,
	    receipt_reference: testnetEvidenceCheck.receiptReference,
	    challenge_id: testnetEvidenceCheck.challengeId,
    fiber_commit: testnetEvidenceCheck.fiberCommit,
    production_bootstrap_e2e: productionBootstrapReady,
    production_ready_for_fiber_method: productionReady,
    blockers: [...testnetEvidenceCheck.blockers, ...productionBlockers]
  }, null, 2)}\n`);
} else if (fs.existsSync("reports/fiber-local-e2e-success.json")) {
  const success = JSON.parse(fs.readFileSync("reports/fiber-local-e2e-success.json", "utf8"));
  success.production_ready_for_fiber_method = false;
  success.production_blockers = [
    ...(success.testnet_fiber_e2e === true ? [] : ["testnet Fiber E2E evidence still pending"]),
    ...opsBlockers
  ];
  fs.writeFileSync("reports/fiber-local-e2e-success.json", `${JSON.stringify(success, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-paid-http-gate.local.json", `${JSON.stringify(success, null, 2)}\n`);
  fs.writeFileSync("reports/fiber-local-e2e-evidence.json", `${JSON.stringify({
    evidence: true,
    source_report: "reports/fiber-paid-http-gate.local.json",
    payment_hash: success.fiber_e2e_payment_hash,
    receipt_reference: success.fiber_e2e_receipt_reference,
    challenge_id: success.fiber_e2e_challenge_id,
    fiber_commit: success.fiber_commit,
    production_ready_for_fiber_method: false,
    blockers: success.production_blockers
  }, null, 2)}\n`);
}

function createTestnetSuccessEvidence(gateReport) {
  return {
    schema: TESTNET_EVIDENCE_SCHEMA,
    testnet_evidence_recorded_at: gateReport.testnet_evidence_recorded_at,
    fiber_commit: gateReport.fiber_commit,
    fiber_preflight_test_loaded: gateReport.fiber_preflight_test_loaded,
    fiber_live_test_selected: gateReport.fiber_live_test_selected,
    fiber_live_test_loaded: gateReport.fiber_live_test_loaded,
    fiber_e2e_mode: gateReport.fiber_e2e_mode,
    fiber_e2e_status: gateReport.fiber_e2e_status,
    fiber_e2e_blockers: gateReport.fiber_e2e_blockers,
    live_fiber_testnet_e2e: gateReport.live_fiber_testnet_e2e,
    testnet_fiber_e2e: gateReport.testnet_fiber_e2e,
    testnet_fiber_e2e_evidence: gateReport.testnet_fiber_e2e_evidence,
    fiber_e2e_payment_hash: gateReport.fiber_e2e_payment_hash,
    fiber_e2e_receipt_reference: gateReport.fiber_e2e_receipt_reference,
    fiber_e2e_challenge_id: gateReport.fiber_e2e_challenge_id,
    testnet_evidence_digest: null
  };
}

console.log(JSON.stringify(report, null, 2));
JSON

if node -e 'const r=require("./reports/fiber-paid-http-gate.json"); process.exit(r.fiber_e2e_status === "failed" ? 0 : 1)'; then
  exit 1
fi
if node -e 'const r=require("./reports/fiber-paid-http-gate.json"); process.exit(r.evidence_console_layout === false ? 0 : 1)'; then
  exit 1
fi
if node -e 'const r=require("./reports/fiber-paid-http-gate.json"); process.exit(r.evidence_console_action_coverage === false ? 0 : 1)'; then
  exit 1
fi
if node -e 'const r=require("./reports/fiber-paid-http-gate.json"); process.exit(r.evidence_console_server_hardening === false ? 0 : 1)'; then
  exit 1
fi
if node -e 'const r=require("./reports/fiber-paid-http-gate.json"); process.exit(r.evidence_console_browser_smoke === false ? 0 : 1)'; then
  exit 1
fi
