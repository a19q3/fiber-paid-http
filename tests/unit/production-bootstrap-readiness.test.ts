import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { productionBootstrapReadiness } = require("../../scripts/lib/production-bootstrap-readiness.cjs") as {
  productionBootstrapReadiness: (report: unknown) => { ready: boolean; missing: string[] };
};

describe("production bootstrap readiness", () => {
  it("accepts a complete production bootstrap E2E report", () => {
    expect(productionBootstrapReadiness(validReport())).toEqual({
      ready: true,
      missing: []
    });
  });

  it("rejects incomplete role bootstrap and gateway hardening evidence", () => {
    const report = validReport();
    report.payer_bootstrap.ready_channels = 0;
    report.payer_bootstrap.rpc_auth_enforced = false;
    report.payer_bootstrap.missing_auth_rejected = false;
    report.payee_bootstrap.status = "blocked";
    report.payee_bootstrap.invalid_auth_rejected = false;
    report.gateway_bootstrap.rpc_auth_from_env = false;
    report.gateway_bootstrap.log_redaction_enabled = false;
    report.gateway_bootstrap.rate_limit_enforced = false;

    expect(productionBootstrapReadiness(report)).toEqual({
      ready: false,
      missing: [
        "payer_bootstrap.rpc_auth_enforced",
        "payer_bootstrap.missing_auth_rejected",
        "payer_bootstrap.ready_channels",
        "payee_bootstrap.status",
        "payee_bootstrap.invalid_auth_rejected",
        "gateway_bootstrap.rpc_auth_from_env",
        "gateway_bootstrap.log_redaction_enabled",
        "gateway_bootstrap.rate_limit_enforced"
      ]
    });
  });

  it("rejects evidence without current Rust, testnet, and TLS provenance", () => {
    const report = validReport();
    report.schema = "wrong";
    report.generated_at = "not-a-time";
    report.blockers = ["still blocked"];
    report.mode = "local";
    report.engine = "typescript";
    report.fiber_commit = "missing";
    report.transport.tls = false;
    report.transport.protocol = null;
    report.transport.public_base_url = "http://127.0.0.1";
    report.gateway_bootstrap.rust_gateway = false;

    expect(productionBootstrapReadiness(report)).toEqual({
      ready: false,
      missing: [
        "schema",
        "generated_at",
        "blockers",
        "mode",
        "engine",
        "fiber_commit",
        "transport.tls",
        "transport.protocol",
        "transport.public_base_url",
        "gateway_bootstrap.rust_gateway"
      ]
    });
  });

  it("rejects payment evidence without 402, settlement, delivery, or standard receipt proof", () => {
    const report = validReport();
    report.unpaid_request_status = 200;
    report.paid_request.status = 202;
    report.paid_request.receipt_reference = "";
    report.paid_request.challenge_id = "";
    report.paid_request.payment_hash = "not-a-hash";
    report.paid_request.receipt_schema_valid = false;
    report.paid_request.settlement_status = "pending";
    report.paid_request.delivery_status = "failed";
    report.paid_request.delivery_response_status = 502;

    expect(productionBootstrapReadiness(report)).toEqual({
      ready: false,
      missing: [
        "unpaid_request_status",
        "paid_request.status",
        "paid_request.receipt_reference",
        "paid_request.challenge_id",
        "paid_request.payment_hash",
        "paid_request.reference_matches_payment_hash",
        "paid_request.receipt_schema_valid",
        "paid_request.settlement_status",
        "paid_request.delivery_status",
        "paid_request.delivery_response_status"
      ]
    });
  });

  it("rejects storage evidence without integrity or the exact isolated probe failures", () => {
    const report = validReport();
    report.storage.schema_version = 0;
    report.storage.journal_mode = "delete";
    report.storage.foreign_keys = false;
    report.storage.integrity_check = "corrupt";
    report.storage.receipts = 0;
    report.storage.valid_receipts = 0;
    report.storage.invalid_receipts = 1;
    report.storage.failed_deliveries = 1;
    report.storage.expected_probe_failed_deliveries = 0;
    report.storage.unexpected_failed_deliveries = 1;

    expect(productionBootstrapReadiness(report)).toEqual({
      ready: false,
      missing: [
        "storage.schema_version",
        "storage.journal_mode",
        "storage.foreign_keys",
        "storage.integrity_check",
        "storage.receipts",
        "storage.valid_receipts",
        "storage.invalid_receipts",
        "storage.failed_deliveries",
        "storage.expected_probe_failed_deliveries",
        "storage.unexpected_failed_deliveries"
      ]
    });
  });

  it("rejects declared limits that were not behaviorally exercised", () => {
    const report = validReport();
    report.gateway_bootstrap.body_limit_enforced = false;
    report.gateway_bootstrap.upstream_timeout_enforced = false;
    report.gateway_bootstrap.upstream_response_limit_enforced = false;
    report.gateway_bootstrap.graceful_shutdown = false;
    report.operational_limits.body_limit_status = 200;
    report.operational_limits.upstream_response_limit_receipt_reissued = true;
    report.operational_limits.upstream_timeout_receipt_reissued = true;

    expect(productionBootstrapReadiness(report).missing).toEqual([
      "gateway_bootstrap.body_limit_enforced",
      "gateway_bootstrap.upstream_timeout_enforced",
      "gateway_bootstrap.upstream_response_limit_enforced",
      "gateway_bootstrap.graceful_shutdown",
      "operational_limits.body_limit_status",
      "operational_limits.upstream_response_limit_receipt_reissued",
      "operational_limits.upstream_timeout_receipt_reissued"
    ]);
  });
});

function validReport() {
  return {
    schema: "fiber-paid-http-production-bootstrap-v1",
    generated_at: "2026-07-13T00:00:00.000Z",
    status: "passed",
    blockers: [] as string[],
    mode: "testnet",
    engine: "rust",
    fiber_commit: "a".repeat(40),
    transport: {
      tls: true,
      protocol: "TLSv1.3" as string | null,
      public_base_url: "https://127.0.0.1"
    },
    payer_bootstrap: {
      status: "ready",
      node_id: "02a64b8993f33b2ebd37a4de1c9441f491291a4e779da8e519bcfb7c1f3f56c9c0",
      rpc_auth_from_env: true,
      rpc_auth_enforced: true,
      missing_auth_rejected: true,
      invalid_auth_rejected: true,
      peers: 1,
      ready_channels: 1
    },
    payee_bootstrap: {
      status: "ready",
      node_id: "03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187",
      rpc_auth_from_env: true,
      rpc_auth_enforced: true,
      missing_auth_rejected: true,
      invalid_auth_rejected: true,
      peers: 1,
      ready_channels: 1
    },
    gateway_bootstrap: {
      status: "ready",
      server_id: "fiber-paid-http-production-bootstrap-e2e",
      rust_gateway: true,
      rpc_auth_from_env: true,
      log_redaction_enabled: true,
      rate_limit_enforced: true,
      body_limit_enforced: true,
      upstream_timeout_enforced: true,
      upstream_response_limit_enforced: true,
      graceful_shutdown: true,
      graceful_shutdown_duration_ms: 25
    },
    unpaid_request_status: 402,
    paid_request: {
      status: 200,
      receipt_reference: "0xc1fd3399013dc0f1885bf0e82f7771d3ab1ca551d5f061d17708554cb2a18a03",
      challenge_id: "A".repeat(43),
      payment_hash: "0xc1fd3399013dc0f1885bf0e82f7771d3ab1ca551d5f061d17708554cb2a18a03",
      receipt_schema_valid: true,
      settlement_status: "settled",
      delivery_status: "delivered",
      delivery_response_status: 200
    },
    replay: {
      status: 402,
      receipt_reissued: false,
      service_executions: 1
    },
    operational_limits: {
      body_limit_status: 413,
      rate_limit_status: 429,
      retry_after_present: true,
      upstream_response_limit_status: 502,
      upstream_response_limit_receipt_reissued: false,
      upstream_timeout_status: 502,
      upstream_timeout_receipt_reissued: false
    },
    storage: {
      schema_version: 1,
      journal_mode: "wal",
      foreign_keys: true,
      integrity_check: "ok",
      receipts: 1,
      valid_receipts: 1,
      invalid_receipts: 0,
      failed_deliveries: 2,
      expected_probe_failed_deliveries: 2,
      unexpected_failed_deliveries: 0
    }
  };
}
