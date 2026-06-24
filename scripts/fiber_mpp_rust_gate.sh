#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p fiber-mpp-cli -- vectors verify

node <<'JSON'
const fs = require("node:fs");
const conformance = JSON.parse(fs.readFileSync("reports/rust-conformance.json", "utf8"));
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
  production_ready_for_fiber_method: false,
  production_blockers: [
    "testnet Fiber E2E evidence still pending",
    "operational hardening still pending",
    "long-running deployment hardening still pending"
  ]
};
fs.writeFileSync("reports/fiber-mpp-rust-gate.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
JSON
