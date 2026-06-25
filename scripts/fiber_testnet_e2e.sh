#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${FIBER_TESTNET_REPORT_DIR:-reports/fiber-testnet-e2e}"
PREFLIGHT_JSON="${REPORT_DIR}/preflight.json"
PAYER_DOCTOR_JSON="${REPORT_DIR}/doctor-payer.json"
PAYEE_DOCTOR_JSON="${REPORT_DIR}/doctor-payee.json"
CANONICAL_LOG="${REPORT_DIR}/canonical-gate.log"
SUMMARY_JSON="${REPORT_DIR}/testnet-e2e-report.json"

usage() {
  cat <<'USAGE'
usage: scripts/fiber_testnet_e2e.sh

Runs the real FiberMPP testnet evidence lane against already-provisioned Fiber
testnet nodes. This script does not create wallets, request faucet funds, or
open channels. Prepare funded payer/payee FNN nodes first, then set:

  FIBER_PAYER_RPC_URL=http://127.0.0.1:8227
  FIBER_PAYEE_RPC_URL=http://127.0.0.1:8237

Optional:

  FIBER_PAYER_RPC_AUTH='Bearer ...'
  FIBER_PAYEE_RPC_AUTH='Bearer ...'
  FIBER_MPP_SECRET='<32+ char random secret>'
  FIBER_E2E_AMOUNT_SHANNONS=100
  FIBER_SETTLEMENT_TIMEOUT_MS=60000
  FIBER_SETTLEMENT_POLL_MS=500
  FIBER_TESTNET_REPORT_DIR=reports/fiber-testnet-e2e
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  exit 0
fi

mkdir -p "${REPORT_DIR}"
export PREFLIGHT_JSON PAYER_DOCTOR_JSON PAYEE_DOCTOR_JSON CANONICAL_LOG SUMMARY_JSON

export RUN_FIBER_E2E=1
export FIBER_MODE="${FIBER_MODE:-testnet}"
export FIBER_CURRENCY="${FIBER_CURRENCY:-Fibt}"
export FIBER_E2E_AMOUNT_SHANNONS="${FIBER_E2E_AMOUNT_SHANNONS:-100}"
export FIBER_SETTLEMENT_TIMEOUT_MS="${FIBER_SETTLEMENT_TIMEOUT_MS:-60000}"
export FIBER_SETTLEMENT_POLL_MS="${FIBER_SETTLEMENT_POLL_MS:-500}"

if [[ -z "${FIBER_PAYEE_RPC_URL:-}" && -n "${FIBER_RPC_URL:-}" ]]; then
  export FIBER_PAYEE_RPC_URL="${FIBER_RPC_URL}"
fi

secret_generated=false
if [[ -z "${FIBER_MPP_SECRET:-}" ]]; then
  export FIBER_MPP_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  secret_generated=true
fi

write_preflight() {
  SECRET_GENERATED="${secret_generated}" node <<'NODE'
const fs = require("node:fs");
const report = {
  generated_at: new Date().toISOString(),
  mode: process.env.FIBER_MODE,
  currency: process.env.FIBER_CURRENCY,
  run_fiber_e2e: process.env.RUN_FIBER_E2E,
  payer_rpc_url: process.env.FIBER_PAYER_RPC_URL || null,
  payee_rpc_url: process.env.FIBER_PAYEE_RPC_URL || process.env.FIBER_RPC_URL || null,
  payer_rpc_auth_present: Boolean(process.env.FIBER_PAYER_RPC_AUTH || process.env.FIBER_RPC_AUTH),
  payee_rpc_auth_present: Boolean(process.env.FIBER_PAYEE_RPC_AUTH || process.env.FIBER_RPC_AUTH),
  secret_present: Boolean(process.env.FIBER_MPP_SECRET),
  secret_generated: process.env.SECRET_GENERATED === "true",
  amount_shannons: process.env.FIBER_E2E_AMOUNT_SHANNONS,
  settlement_timeout_ms: process.env.FIBER_SETTLEMENT_TIMEOUT_MS,
  settlement_poll_ms: process.env.FIBER_SETTLEMENT_POLL_MS
};
fs.writeFileSync(process.env.PREFLIGHT_JSON, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
NODE
}

write_preflight

if [[ "${FIBER_MODE}" != "testnet" ]]; then
  node <<'NODE'
const fs = require("node:fs");
const summary = {
  status: "blocked",
  blockers: ["set FIBER_MODE=testnet; this script is only for separate testnet evidence"],
  preflight: process.env.PREFLIGHT_JSON
};
fs.writeFileSync(process.env.SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
console.error(summary.blockers[0]);
NODE
  exit 1
fi

run_doctor() {
  local role="$1"
  local out="$2"
  set +e
  pnpm exec fiber-mpp doctor --role "${role}" 2>&1 | tee "${out}"
  local status="${PIPESTATUS[0]}"
  set -e
  if [[ "${status}" -ne 0 ]]; then
    return "${status}"
  fi
  node - "${out}" "${role}" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const role = process.argv[3];
const report = JSON.parse(fs.readFileSync(path, "utf8"));
if (report.status !== "ready") {
  console.error(`${role} doctor blocked: ${(report.blockers || []).join("; ")}`);
  process.exit(1);
}
NODE
}

run_doctor payer "${PAYER_DOCTOR_JSON}"
run_doctor payee "${PAYEE_DOCTOR_JSON}"

rm -f reports/fiber-e2e-result.json
set +e
bash scripts/fiber_mpp_canonical_gate.sh 2>&1 | tee "${CANONICAL_LOG}"
gate_exit="${PIPESTATUS[0]}"
set -e

SUMMARY_JSON="${SUMMARY_JSON}" GATE_EXIT="${gate_exit}" node <<'NODE'
const fs = require("node:fs");

function readJson(path) {
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null;
}

const gate = readJson("reports/fiber-mpp-gate.json");
const canonical = readJson("reports/canonical-core-parity.json");
const fiber = readJson("reports/fiber-e2e-result.json");
const gateExit = Number.parseInt(process.env.GATE_EXIT || "1", 10);
const passed =
  gateExit === 0 &&
  gate?.fiber_e2e_mode === "testnet" &&
  gate?.fiber_e2e_status === "passed" &&
  gate?.testnet_fiber_e2e === true &&
  gate?.production_ready_for_fiber_method === true &&
  canonical?.testnet_fiber_e2e === true &&
  canonical?.production_ready_for_fiber_method === true;

const summary = {
  generated_at: new Date().toISOString(),
  status: passed ? "passed" : "failed",
  gate_exit: gateExit,
  fiber_e2e_result: fiber,
  gate_report: gate,
  canonical_report: canonical,
  artifacts: {
    preflight: process.env.PREFLIGHT_JSON,
    payer_doctor: process.env.PAYER_DOCTOR_JSON,
    payee_doctor: process.env.PAYEE_DOCTOR_JSON,
    canonical_gate_log: process.env.CANONICAL_LOG,
    fiber_mpp_gate: "reports/fiber-mpp-gate.json",
    canonical_core_parity: "reports/canonical-core-parity.json",
    testnet_success: "reports/fiber-testnet-e2e-success.json",
    testnet_evidence: "reports/fiber-testnet-e2e-evidence.json"
  }
};

fs.writeFileSync(process.env.SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (!passed) {
  process.exit(1);
}
NODE

cp reports/fiber-mpp-gate.json "${REPORT_DIR}/fiber-mpp-gate.testnet.json"
cp reports/canonical-core-parity.json "${REPORT_DIR}/canonical-core-parity.testnet.json"

echo "FiberMPP testnet E2E evidence passed. Summary: ${SUMMARY_JSON}"
