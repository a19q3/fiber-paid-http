import { describe, expect, it } from "vitest";
import { deriveProductionEvidence, type ReportReadResult } from "@fiber-mpp/evidence-api";

describe("evidence API production evidence derivation", () => {
  it("uses direct preserved testnet evidence even when aggregate gate claims are stale", () => {
    const reports = productionReports({
      fiberTestnet: validTestnetEvidence(),
      gate: {
        testnet_fiber_e2e: false,
        fiber_mpp_gate_ready: false,
        production_bootstrap_e2e: true,
        fiber_mpp_gate_blockers: []
      }
    });

    const evidence = deriveProductionEvidence(reports);

    expect(evidence.testnetFiberE2e).toBe(true);
    expect(evidence.productionReady).toBe(true);
    expect(evidence.gateReady).toBe(true);
    expect(evidence.paymentHash).toBe(validPaymentHash);
    expect(evidence.receiptId).toBe(validReceiptId);
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
    expect(evidence.receiptId).toBeUndefined();
  });

  it("does not expose stale aggregate payment identifiers without valid preserved evidence", () => {
    const invalidPreservedEvidence = {
      ...validTestnetEvidence(),
      fiber_e2e_payment_hash: "not-a-hash",
      fiber_e2e_receipt_id: "not-a-receipt"
    };
    const reports = productionReports({
      fiberTestnet: invalidPreservedEvidence,
      gate: {
        ...aggregateReadyReport(),
        fiber_e2e_payment_hash: validPaymentHash,
        fiber_e2e_receipt_id: validReceiptId
      }
    });

    const evidence = deriveProductionEvidence(reports);

    expect(evidence.testnetFiberE2e).toBe(false);
    expect(evidence.productionReady).toBe(false);
    expect(evidence.paymentHash).toBeUndefined();
    expect(evidence.receiptId).toBeUndefined();
  });
});

const validPaymentHash = "0x8adaeeb1c27b698d5a63447588f3de62568f94e23effeda973ff70281a545f9b";
const validReceiptId = "rcpt_9ff3edb34ee30f56d20c3c6bf01fb453";

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
    gate: report("gate", "reports/fiber-mpp-gate.json", {
      fiber_mpp_gate_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      fiber_mpp_gate_blockers: [],
      ...overrides.gate
    }),
    gateDefault: report("gateDefault", "reports/fiber-mpp-gate.default.json", {
      fiber_mpp_gate_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.gateDefault
    }),
    gateLocal: report("gateLocal", "reports/fiber-mpp-gate.local.json", {
      live_fiber_local_e2e: true
    }),
    rustGate: report("rustGate", "reports/fiber-mpp-rust-gate.json", {
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.rustGate
    }),
    tsGate: report("tsGate", "reports/fiber-mpp-ts-gate.json", {
      fiber_mpp_gate_ready: true,
      production_bootstrap_e2e: true,
      production_ready_for_fiber_method: true,
      ...overrides.tsGate
    }),
    productionBootstrap: report("productionBootstrap", "reports/production-bootstrap-e2e.json", {}),
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
  return {
    status: "passed",
    gate_exit: 0,
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
    fiber_e2e_receipt_id: validReceiptId
  };
}

function aggregateReadyReport(): Record<string, unknown> {
  return {
    testnet_fiber_e2e: true,
    fiber_mpp_gate_ready: true,
    production_bootstrap_e2e: true,
    production_ready_for_fiber_method: true,
    fiber_mpp_gate_blockers: []
  };
}

type ProductionReports = Parameters<typeof deriveProductionEvidence>[0];
