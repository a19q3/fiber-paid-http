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
    report.payee_bootstrap.status = "blocked";
    report.gateway_bootstrap.rpc_auth_from_env = false;
    report.gateway_bootstrap.log_redaction_enabled = false;
    report.gateway_bootstrap.rate_limit_enabled = false;

    expect(productionBootstrapReadiness(report)).toEqual({
      ready: false,
      missing: [
        "payer_bootstrap.ready_channels",
        "payee_bootstrap.status",
        "gateway_bootstrap.rpc_auth_from_env",
        "gateway_bootstrap.log_redaction_enabled",
        "gateway_bootstrap.rate_limit_enabled"
      ]
    });
  });

  it("rejects payment evidence without 402, settlement, delivery, or signed receipt proof", () => {
    const report = validReport();
    report.unpaid_request_status = 200;
    report.paid_request.status = 202;
    report.paid_request.receipt_id = "";
    report.paid_request.payment_hash = "not-a-hash";
    report.paid_request.receipt_signature_valid = false;
    report.paid_request.settlement_status = "pending";
    report.paid_request.delivery_status = "failed";
    report.paid_request.delivery_response_status = 502;

    expect(productionBootstrapReadiness(report)).toEqual({
      ready: false,
      missing: [
        "unpaid_request_status",
        "paid_request.status",
        "paid_request.receipt_id",
        "paid_request.payment_hash",
        "paid_request.receipt_signature_valid",
        "paid_request.settlement_status",
        "paid_request.delivery_status",
        "paid_request.delivery_response_status"
      ]
    });
  });

  it("rejects storage evidence without WAL, integrity, valid receipts, and zero failures", () => {
    const report = validReport();
    report.storage.schema_version = 0;
    report.storage.journal_mode = "delete";
    report.storage.foreign_keys = false;
    report.storage.integrity_check = "corrupt";
    report.storage.receipts = 0;
    report.storage.valid_receipts = 0;
    report.storage.invalid_receipts = 1;
    report.storage.failed_deliveries = 1;

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
        "storage.failed_deliveries"
      ]
    });
  });
});

function validReport() {
  return {
    status: "passed",
    payer_bootstrap: {
      status: "ready",
      node_pubkey: "02a64b8993f33b2ebd37a4de1c9441f491291a4e779da8e519bcfb7c1f3f56c9c0",
      ready_channels: 1
    },
    payee_bootstrap: {
      status: "ready",
      node_pubkey: "03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187",
      ready_channels: 1
    },
    gateway_bootstrap: {
      status: "ready",
      server_id: "fiber-paid-http-production-bootstrap-e2e",
      rpc_auth_from_env: true,
      log_redaction_enabled: true,
      rate_limit_enabled: true
    },
    unpaid_request_status: 402,
    paid_request: {
      status: 200,
      receipt_id: "rcpt_95902895f1d3a3ea58d21e64303d0d69",
      payment_hash: "0xc1fd3399013dc0f1885bf0e82f7771d3ab1ca551d5f061d17708554cb2a18a03",
      receipt_signature_valid: true,
      settlement_status: "settled",
      delivery_status: "delivered",
      delivery_response_status: 200
    },
    storage: {
      schema_version: 1,
      journal_mode: "wal",
      foreign_keys: true,
      integrity_check: "ok",
      receipts: 1,
      valid_receipts: 1,
      invalid_receipts: 0,
      failed_deliveries: 0
    }
  };
}
