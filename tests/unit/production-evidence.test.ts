import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { deriveProductionEvidence, type ReportReadResult } from "@fiber-paid-http/evidence-api";

const require = createRequire(import.meta.url);
const { computeTestnetEvidenceDigest } = require("../../scripts/lib/testnet-fiber-evidence-readiness.cjs") as {
  computeTestnetEvidenceDigest: (report: unknown) => { digest: string };
};

describe("evidence API production evidence derivation", () => {
  it("uses direct preserved testnet evidence even when aggregate gate claims are stale", () => {
    const reports = productionReports({
      fiberTestnet: validTestnetEvidence(),
      gate: {
        testnet_fiber_e2e: false,
        fiber_paid_http_gate_ready: false,
        production_bootstrap_e2e: true,
        fiber_paid_http_gate_blockers: []
      }
    });

    const evidence = deriveProductionEvidence(reports);

    expect(evidence.testnetFiberE2e).toBe(true);
    expect(evidence.productionReady).toBe(true);
    expect(evidence.gateReady).toBe(true);
    expect(evidence.paymentHash).toBe(validPaymentHash);
    expect(evidence.receiptReference).toBe(validPaymentHash);
    expect(evidence.challengeId).toBe(validChallengeId);
    expect(evidence.conflicts.join(" ")).toContain("conflicting testnet_fiber_e2e claims");
  });

  it("does not let aggregate testnet claims substitute for invalid preserved evidence", () => {
    const invalidPreservedEvidence = {
      ...validTestnetEvidence(),
      fiber_e2e_mode: "local",
      fiber_e2e_status: "skipped",
      fiber_e2e_blockers: ["set FIBER_MODE=testnet"]
    };
    const reports = productionReports({
      fiberTestnet: invalidPreservedEvidence,
      gate: aggregateReadyReport(),
      gateDefault: aggregateReadyReport(),
      rustGate: aggregateReadyReport(),
      tsGate: aggregateReadyReport(),
      canonical: aggregateReadyReport()
    });

    const evidence = deriveProductionEvidence(reports);

    expect(evidence.testnetFiberE2e).toBe(false);
    expect(evidence.productionReady).toBe(false);
    expect(evidence.paymentHash).toBeUndefined();
    expect(evidence.receiptReference).toBeUndefined();
    expect(evidence.challengeId).toBeUndefined();
  });

  it("does not expose stale aggregate payment identifiers without valid preserved evidence", () => {
    const invalidPreservedEvidence = {
      ...validTestnetEvidence(),
      fiber_e2e_payment_hash: "not-a-hash",
      fiber_e2e_receipt_reference: "not-a-reference",
      fiber_e2e_challenge_id: "not-a-challenge"
    };
    const reports = productionReports({
      fiberTestnet: invalidPreservedEvidence,
      gate: {
        ...aggregateReadyReport(),
        fiber_e2e_payment_hash: validPaymentHash,
        fiber_e2e_receipt_reference: validPaymentHash,
        fiber_e2e_challenge_id: validChallengeId
      }
    });

    const evidence = deriveProductionEvidence(reports);

    expect(evidence.testnetFiberE2e).toBe(false);
    expect(evidence.productionReady).toBe(false);
    expect(evidence.paymentHash).toBeUndefined();
    expect(evidence.receiptReference).toBeUndefined();
    expect(evidence.challengeId).toBeUndefined();
  });

  it("does not let aggregate bootstrap claims substitute for invalid direct bootstrap evidence", () => {
    const reports = productionReports({
      productionBootstrap: {
        ...validProductionBootstrapEvidence(),
        operational_limits: {
          ...(validProductionBootstrapEvidence().operational_limits as Record<string, unknown>),
          upstream_timeout_status: 200
        }
      }
    });

    const evidence = deriveProductionEvidence(reports);

    expect(evidence.testnetFiberE2e).toBe(true);
    expect(evidence.productionBootstrapReady).toBe(false);
    expect(evidence.productionReady).toBe(false);
  });
});

const validPaymentHash = "0x8adaeeb1c27b698d5a63447588f3de62568f94e23effeda973ff70281a545f9b";
const validChallengeId = "A".repeat(43);

function productionReports(overrides: Partial<Record<keyof ProductionReports, Record<string, unknown>>> = {}): ProductionReports {
  return {
    canonical: report("canonical", "reports/canonical-core-parity.json", {
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.canonical
    }),
    fiberTestnet: report("fiberTestnet", "reports/fiber-testnet-e2e-success.json", {
      ...validTestnetEvidence(),
      ...overrides.fiberTestnet
    }),
    gate: report("gate", "reports/fiber-paid-http-gate.json", {
      fiber_paid_http_gate_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      fiber_paid_http_gate_blockers: [],
      ...overrides.gate
    }),
    gateDefault: report("gateDefault", "reports/fiber-paid-http-gate.default.json", {
      fiber_paid_http_gate_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.gateDefault
    }),
    gateLocal: report("gateLocal", "reports/fiber-paid-http-gate.local.json", {
      live_fiber_local_e2e: true
    }),
    rustGate: report("rustGate", "reports/fiber-paid-http-rust-gate.json", {
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.rustGate
    }),
    tsGate: report("tsGate", "reports/fiber-paid-http-ts-gate.json", {
      fiber_paid_http_gate_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.tsGate
    }),
    productionBootstrap: report("productionBootstrap", "reports/production-bootstrap-e2e.json", {
      ...validProductionBootstrapEvidence(),
      ...overrides.productionBootstrap
    }),
    productionOps: report("productionOps", "reports/production-operations-matrix.json", {
      production_ops_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.productionOps
    })
  };
}

function report(name: string, path: string, data: Record<string, unknown>): ReportReadResult {
  return {
    name,
    path,
    exists: true,
    data
  };
}

function validTestnetEvidence(): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    schema: "fiber-paid-http-testnet-e2e-evidence-v1",
    testnet_evidence_recorded_at: "2026-07-13T00:00:00.000Z",
    fiber_commit: "a".repeat(40),
    fiber_preflight_test_loaded: true,
    fiber_live_test_selected: true,
    fiber_live_test_loaded: true,
    fiber_e2e_mode: "testnet",
    fiber_e2e_status: "passed",
    fiber_e2e_blockers: [],
    live_fiber_testnet_e2e: true,
    testnet_fiber_e2e: true,
    testnet_fiber_e2e_evidence: true,
    fiber_e2e_payment_hash: validPaymentHash,
    fiber_e2e_receipt_reference: validPaymentHash,
    fiber_e2e_challenge_id: validChallengeId,
    testnet_evidence_digest: null
  };
  evidence.testnet_evidence_digest = computeTestnetEvidenceDigest(evidence).digest;
  return evidence;
}

function aggregateReadyReport(): Record<string, unknown> {
  return {
    testnet_fiber_e2e: true,
    fiber_paid_http_gate_ready: true,
    production_bootstrap_e2e: true,
    production_ready_for_fiber_method: true,
    fiber_paid_http_gate_blockers: []
  };
}

function validProductionBootstrapEvidence(): Record<string, unknown> {
  return {
    schema: "fiber-paid-http-production-bootstrap-v1",
    generated_at: "2026-07-13T00:00:00.000Z",
    status: "passed",
    blockers: [],
    mode: "testnet",
    engine: "rust",
    fiber_commit: "a".repeat(40),
    transport: {
      tls: true,
      protocol: "TLSv1.3",
      public_base_url: "https://127.0.0.1"
    },
    payer_bootstrap: {
      status: "ready",
      node_id: "payer",
      rpc_auth_from_env: true,
      peers: 1,
      ready_channels: 1
    },
    payee_bootstrap: {
      status: "ready",
      node_id: "payee",
      rpc_auth_from_env: true,
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
      receipt_reference: validPaymentHash,
      challenge_id: validChallengeId,
      payment_hash: validPaymentHash,
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

type ProductionReports = Parameters<typeof deriveProductionEvidence>[0];
