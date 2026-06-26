import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  computeTestnetEvidenceDigest,
  normalizePreservedTestnetEvidence,
  verifyPreservedTestnetEvidence
} = require("../../scripts/lib/testnet-fiber-evidence-readiness.cjs") as {
  computeTestnetEvidenceDigest: (report: unknown, options?: { fallbackRecordedAt?: string }) => {
    digest: string;
    material: Record<string, unknown>;
  };
  normalizePreservedTestnetEvidence: (report: unknown, options?: { fallbackRecordedAt?: string }) => unknown;
  verifyPreservedTestnetEvidence: (report: unknown, options?: { path?: string; expectedFiberCommit?: string }) => {
    verified: boolean;
    blockers: string[];
    paymentHash: string | null;
    receiptId: string | null;
    fiberCommit: string | null;
    recordedAt: string | null;
    evidenceDigest: string | null;
  };
};

describe("preserved testnet Fiber evidence readiness", () => {
  it("accepts the flat preserved testnet success gate snapshot", () => {
    const result = verifyPreservedTestnetEvidence(validFlatReport());

    expect(result).toEqual({
      verified: true,
      blockers: [],
      paymentHash: "0x8adaeeb1c27b698d5a63447588f3de62568f94e23effeda973ff70281a545f9b",
      receiptId: "rcpt_9ff3edb34ee30f56d20c3c6bf01fb453",
      fiberCommit: validFiberCommit,
      recordedAt: validRecordedAt,
      evidenceDigest: validDigest()
    });
  });

  it("accepts preserved testnet evidence only when the expected Fiber commit matches", () => {
    const result = verifyPreservedTestnetEvidence(validFlatReport(), {
      expectedFiberCommit: validFiberCommit
    });

    expect(result.verified).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.fiberCommit).toBe(validFiberCommit);
  });

  it("accepts the wrapped testnet E2E report shape", () => {
    const result = verifyPreservedTestnetEvidence({
      status: "passed",
      gate_exit: 0,
      fiber_e2e_result: validFlatReport(),
      gate_report: validFlatReport()
    });

    expect(result.verified).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("rejects missing evidence with a concrete path", () => {
    expect(verifyPreservedTestnetEvidence(null, { path: "reports/missing.json" })).toEqual({
      verified: false,
      blockers: ["preserved testnet Fiber E2E evidence missing: reports/missing.json"],
      paymentHash: null,
      receiptId: null,
      fiberCommit: null,
      recordedAt: null,
      evidenceDigest: null
    });
  });

  it("rejects local-mode or skipped evidence even when a payment hash is present", () => {
    const report = validFlatReport();
    report.fiber_e2e_mode = "local";
    report.fiber_e2e_status = "skipped";
    report.fiber_e2e_blockers = ["set FIBER_MODE=testnet"];
    refreshDigest(report);

    const result = verifyPreservedTestnetEvidence(report);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual([
      "preserved testnet evidence mode is not testnet",
      "preserved testnet evidence status is not passed",
      "preserved testnet evidence still has Fiber E2E blockers"
    ]);
  });

  it("rejects malformed payment and receipt evidence", () => {
    const report = validFlatReport();
    report.fiber_e2e_payment_hash = "not-a-hash";
    report.fiber_e2e_receipt_id = "not-a-receipt";
    report.live_fiber_testnet_e2e = false;
    refreshDigest(report);

    const result = verifyPreservedTestnetEvidence(report);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual([
      "preserved testnet evidence payment hash is missing or invalid",
      "preserved testnet evidence receipt id is missing or invalid",
      "preserved gate report does not record live_fiber_testnet_e2e"
    ]);
  });

  it("rejects wrapped evidence when the preserved gate report still has blockers", () => {
    const gateReport = validFlatReport();
    gateReport.fiber_e2e_blockers = ["testnet Fiber E2E evidence still pending"];
    refreshDigest(gateReport);

    const wrapper = {
      status: "passed",
      gate_exit: 0,
      fiber_e2e_result: validFlatReport(),
      gate_report: gateReport
    };
    refreshDigest(wrapper);

    const result = verifyPreservedTestnetEvidence(wrapper);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual(["preserved testnet evidence still has Fiber E2E blockers"]);
  });

  it("rejects evidence with a missing digest", () => {
    const report = validFlatReport();
    delete report.testnet_evidence_digest;

    const result = verifyPreservedTestnetEvidence(report);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual(["preserved testnet evidence digest is missing or invalid"]);
  });

  it("rejects evidence whose digest no longer matches the evidence facts", () => {
    const report = validFlatReport();
    report.fiber_e2e_payment_hash = `0x${"12".repeat(32)}`;

    const result = verifyPreservedTestnetEvidence(report);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual([
      `preserved testnet evidence digest mismatch: expected ${computeTestnetEvidenceDigest(report).digest}, found ${validDigest()}`
    ]);
  });

  it("normalizes legacy evidence by adding recorded_at fallback and digest", () => {
    const legacy = validFlatReport();
    delete legacy.testnet_evidence_recorded_at;
    delete legacy.testnet_evidence_digest;

    const normalized = normalizePreservedTestnetEvidence(legacy, {
      fallbackRecordedAt: validRecordedAt
    }) as ReturnType<typeof validFlatReport>;

    expect(normalized.testnet_evidence_recorded_at).toBe(validRecordedAt);
    expect(normalized.testnet_evidence_digest).toBe(computeTestnetEvidenceDigest(normalized).digest);
    expect(verifyPreservedTestnetEvidence(normalized).verified).toBe(true);
  });

  it("rejects evidence from a different Fiber commit", () => {
    const result = verifyPreservedTestnetEvidence(validFlatReport(), {
      expectedFiberCommit: "1111111111111111111111111111111111111111"
    });

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual([
      `preserved testnet evidence Fiber commit mismatch: expected 1111111111111111111111111111111111111111, found ${validFiberCommit}`
    ]);
  });

  it("rejects evidence without a Fiber commit when a current Fiber commit is expected", () => {
    const report = validFlatReport();
    delete report.fiber_commit;
    refreshDigest(report);

    const result = verifyPreservedTestnetEvidence(report, {
      expectedFiberCommit: validFiberCommit
    });

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual([
      `preserved testnet evidence Fiber commit mismatch: expected ${validFiberCommit}, found missing`
    ]);
  });

  it("accepts a wrapper generated_at as the recorded evidence time", () => {
    const report = validFlatReport();
    delete report.testnet_evidence_recorded_at;
    delete report.testnet_evidence_digest;

    const result = verifyPreservedTestnetEvidence({
      status: "passed",
      gate_exit: 0,
      generated_at: validRecordedAt,
      fiber_e2e_result: normalizePreservedTestnetEvidence(report, { fallbackRecordedAt: validRecordedAt }),
      gate_report: normalizePreservedTestnetEvidence(report, { fallbackRecordedAt: validRecordedAt })
    });

    expect(result.verified).toBe(true);
    expect(result.recordedAt).toBe(validRecordedAt);
  });

  it("rejects evidence without a recorded evidence time", () => {
    const report = validFlatReport();
    delete report.testnet_evidence_recorded_at;
    refreshDigest(report);

    const result = verifyPreservedTestnetEvidence(report);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual(["preserved testnet evidence recorded_at is missing or invalid"]);
  });

  it("rejects evidence with a non-canonical recorded evidence time", () => {
    const report = validFlatReport();
    report.testnet_evidence_recorded_at = "2026-06-25 03:14:53";
    refreshDigest(report);

    const result = verifyPreservedTestnetEvidence(report);

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual(["preserved testnet evidence recorded_at is missing or invalid"]);
  });
});

const validFiberCommit = "3c25bcf16200e5d641dcd9b79f086f391e976172";
const validRecordedAt = "2026-06-25T03:14:53.023Z";

function validDigest(): string {
  return computeTestnetEvidenceDigest(validFlatReportWithoutDigest()).digest;
}

function refreshDigest(report: { testnet_evidence_digest?: string } & Record<string, unknown>): void {
  report.testnet_evidence_digest = computeTestnetEvidenceDigest(report).digest;
}

function validFlatReport(): {
  fiber_preflight_test_loaded: boolean;
  fiber_live_test_selected: boolean;
  fiber_live_test_loaded: boolean;
  fiber_e2e_mode: string;
  fiber_e2e_status: string;
  fiber_e2e_blockers: string[];
  fiber_commit?: string;
  testnet_evidence_recorded_at?: string;
  testnet_evidence_digest?: string;
  live_fiber_testnet_e2e: boolean;
  testnet_fiber_e2e: boolean;
  testnet_fiber_e2e_evidence: boolean;
  fiber_e2e_payment_hash: string;
  fiber_e2e_receipt_id: string;
} {
  const report = validFlatReportWithoutDigest();
  report.testnet_evidence_digest = computeTestnetEvidenceDigest(report).digest;
  return report;
}

function validFlatReportWithoutDigest(): ReturnType<typeof validFlatReport> {
  return {
    fiber_preflight_test_loaded: true,
    fiber_live_test_selected: true,
    fiber_live_test_loaded: true,
    fiber_e2e_mode: "testnet",
    fiber_e2e_status: "passed",
    fiber_e2e_blockers: [],
    fiber_commit: validFiberCommit,
    testnet_evidence_recorded_at: validRecordedAt,
    live_fiber_testnet_e2e: true,
    testnet_fiber_e2e: true,
    testnet_fiber_e2e_evidence: true,
    fiber_e2e_payment_hash: "0x8adaeeb1c27b698d5a63447588f3de62568f94e23effeda973ff70281a545f9b",
    fiber_e2e_receipt_id: "rcpt_9ff3edb34ee30f56d20c3c6bf01fb453"
  };
}
