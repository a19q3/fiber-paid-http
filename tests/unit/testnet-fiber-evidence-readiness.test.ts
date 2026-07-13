import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const evidenceModule = require("../../scripts/lib/testnet-fiber-evidence-readiness.cjs") as {
  TESTNET_EVIDENCE_SCHEMA: string;
  computeTestnetEvidenceDigest: (report: unknown) => {
    digest: string;
    material: Record<string, unknown>;
  };
  normalizePreservedTestnetEvidence?: unknown;
  verifyPreservedTestnetEvidence: (report: unknown, options?: { path?: string; expectedFiberCommit?: string }) => {
    verified: boolean;
    blockers: string[];
    paymentHash: string | null;
    receiptReference: string | null;
    challengeId: string | null;
    fiberCommit: string | null;
    recordedAt: string | null;
    evidenceDigest: string | null;
  };
};
const {
  TESTNET_EVIDENCE_SCHEMA,
  computeTestnetEvidenceDigest,
  verifyPreservedTestnetEvidence
} = evidenceModule;

describe("preserved testnet Fiber evidence readiness", () => {
  it("accepts only the sealed v1 evidence artifact", () => {
    const result = verifyPreservedTestnetEvidence(validReport());

    expect(result).toEqual({
      verified: true,
      blockers: [],
      paymentHash,
      receiptReference: paymentHash,
      challengeId: validChallengeId,
      fiberCommit: validFiberCommit,
      recordedAt: validRecordedAt,
      evidenceDigest: validDigest()
    });
    expect(computeTestnetEvidenceDigest(validReport()).material.schema).toBe(
      "fiber-paid-http-testnet-evidence-digest-v1"
    );
  });

  it("accepts evidence only when the expected Fiber commit matches", () => {
    const result = verifyPreservedTestnetEvidence(validReport(), {
      expectedFiberCommit: validFiberCommit
    });

    expect(result.verified).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("rejects missing evidence with a concrete path", () => {
    expect(verifyPreservedTestnetEvidence(null, { path: "reports/missing.json" })).toEqual({
      verified: false,
      blockers: ["preserved testnet Fiber E2E evidence missing: reports/missing.json"],
      paymentHash: null,
      receiptReference: null,
      challengeId: null,
      fiberCommit: null,
      recordedAt: null,
      evidenceDigest: null
    });
  });

  it("rejects wrapper and extra-field shapes", () => {
    expect(verifyPreservedTestnetEvidence({ gate_report: validReport() }).blockers).toContain(
      "preserved testnet evidence does not match the exact v1 field set"
    );
    expect(verifyPreservedTestnetEvidence({ ...validReport(), generated_at: validRecordedAt }).blockers).toEqual([
      "preserved testnet evidence does not match the exact v1 field set"
    ]);
  });

  it("does not expose an evidence normalization or upgrade path", () => {
    expect(evidenceModule.normalizePreservedTestnetEvidence).toBeUndefined();
    const report = validReport();
    delete report.testnet_evidence_digest;

    expect(verifyPreservedTestnetEvidence(report).blockers).toEqual([
      "preserved testnet evidence does not match the exact v1 field set",
      "preserved testnet evidence digest is missing or invalid"
    ]);
  });

  it("rejects local-mode or skipped evidence even when a payment hash is present", () => {
    const report = validReport();
    report.fiber_e2e_mode = "local";
    report.fiber_e2e_status = "skipped";
    report.fiber_e2e_blockers = ["set FIBER_MODE=testnet"];
    refreshDigest(report);

    expect(verifyPreservedTestnetEvidence(report).blockers).toEqual([
      "preserved testnet evidence mode is not testnet",
      "preserved testnet evidence status is not passed",
      "preserved testnet evidence still has Fiber E2E blockers"
    ]);
  });

  it("rejects malformed or noncanonical payment and receipt evidence", () => {
    const report = validReport();
    report.fiber_e2e_payment_hash = `0x${"AB".repeat(32)}`;
    report.fiber_e2e_receipt_reference = report.fiber_e2e_payment_hash;
    report.fiber_e2e_challenge_id = "not-a-challenge";
    refreshDigest(report);

    expect(verifyPreservedTestnetEvidence(report).blockers).toEqual([
      "preserved testnet evidence payment hash is missing, invalid, or noncanonical",
      "preserved testnet evidence receipt reference is missing, invalid, noncanonical, or does not match payment hash",
      "preserved testnet evidence challenge id is missing or invalid"
    ]);
  });

  it("rejects evidence whose digest no longer matches the evidence facts", () => {
    const report = validReport();
    report.fiber_e2e_payment_hash = `0x${"12".repeat(32)}`;
    report.fiber_e2e_receipt_reference = report.fiber_e2e_payment_hash;

    expect(verifyPreservedTestnetEvidence(report).blockers).toEqual([
      `preserved testnet evidence digest mismatch: expected ${computeTestnetEvidenceDigest(report).digest}, found ${validDigest()}`
    ]);
  });

  it("rejects evidence from a different or missing Fiber commit", () => {
    expect(
      verifyPreservedTestnetEvidence(validReport(), {
        expectedFiberCommit: "1111111111111111111111111111111111111111"
      }).blockers
    ).toEqual([
      `preserved testnet evidence Fiber commit mismatch: expected 1111111111111111111111111111111111111111, found ${validFiberCommit}`
    ]);

    const report = validReport();
    report.fiber_commit = "";
    refreshDigest(report);
    expect(verifyPreservedTestnetEvidence(report).blockers).toEqual([
      "preserved testnet evidence Fiber commit is missing, invalid, or noncanonical"
    ]);
  });

  it("rejects missing or noncanonical recorded evidence time", () => {
    const missing = validReport();
    missing.testnet_evidence_recorded_at = "";
    refreshDigest(missing);
    expect(verifyPreservedTestnetEvidence(missing).blockers).toEqual([
      "preserved testnet evidence recorded_at is missing or invalid"
    ]);

    const noncanonical = validReport();
    noncanonical.testnet_evidence_recorded_at = "2026-06-25 03:14:53";
    refreshDigest(noncanonical);
    expect(verifyPreservedTestnetEvidence(noncanonical).blockers).toEqual([
      "preserved testnet evidence recorded_at is missing or invalid"
    ]);
  });
});

type TestnetEvidence = {
  schema: string;
  testnet_evidence_recorded_at: string;
  fiber_commit: string;
  fiber_preflight_test_loaded: boolean;
  fiber_live_test_selected: boolean;
  fiber_live_test_loaded: boolean;
  fiber_e2e_mode: string;
  fiber_e2e_status: string;
  fiber_e2e_blockers: string[];
  live_fiber_testnet_e2e: boolean;
  testnet_fiber_e2e: boolean;
  testnet_fiber_e2e_evidence: boolean;
  fiber_e2e_payment_hash: string;
  fiber_e2e_receipt_reference: string;
  fiber_e2e_challenge_id: string;
  testnet_evidence_digest?: string;
};

const validFiberCommit = "3c25bcf16200e5d641dcd9b79f086f391e976172";
const validRecordedAt = "2026-06-25T03:14:53.023Z";
const validChallengeId = "A".repeat(43);
const paymentHash = "0x8adaeeb1c27b698d5a63447588f3de62568f94e23effeda973ff70281a545f9b";

function validDigest(): string {
  return computeTestnetEvidenceDigest(validReportWithoutDigest()).digest;
}

function refreshDigest(report: TestnetEvidence): void {
  report.testnet_evidence_digest = computeTestnetEvidenceDigest(report).digest;
}

function validReport(): TestnetEvidence {
  const report = validReportWithoutDigest();
  refreshDigest(report);
  return report;
}

function validReportWithoutDigest(): TestnetEvidence {
  return {
    schema: TESTNET_EVIDENCE_SCHEMA,
    testnet_evidence_recorded_at: validRecordedAt,
    fiber_commit: validFiberCommit,
    fiber_preflight_test_loaded: true,
    fiber_live_test_selected: true,
    fiber_live_test_loaded: true,
    fiber_e2e_mode: "testnet",
    fiber_e2e_status: "passed",
    fiber_e2e_blockers: [],
    live_fiber_testnet_e2e: true,
    testnet_fiber_e2e: true,
    testnet_fiber_e2e_evidence: true,
    fiber_e2e_payment_hash: paymentHash,
    fiber_e2e_receipt_reference: paymentHash,
    fiber_e2e_challenge_id: validChallengeId
  };
}
