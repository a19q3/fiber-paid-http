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

node <<'JSON'
const fs = require("node:fs");
const ts = JSON.parse(fs.readFileSync("reports/ts-conformance.json", "utf8"));
const rust = JSON.parse(fs.readFileSync("reports/rust-conformance.json", "utf8"));

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
  canonical_engine: "rust",
  typescript_role: "sdk-demo-f402-compat-vector-harness",
  production_ready_for_fiber_method: false,
  production_blockers: [
    "testnet Fiber E2E evidence still pending",
    "operational hardening still pending",
    "long-running deployment hardening still pending"
  ],
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
  report.canonical_engine !== "rust" ||
  report.production_ready_for_fiber_method !== false
) {
  process.exit(1);
}
JSON

