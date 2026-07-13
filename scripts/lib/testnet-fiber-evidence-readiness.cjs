const { createHash } = require("node:crypto");

const TESTNET_EVIDENCE_SCHEMA = "fiber-paid-http-testnet-e2e-evidence-v1";
const TESTNET_EVIDENCE_DIGEST_SCHEMA = "fiber-paid-http-testnet-evidence-digest-v1";
const TESTNET_EVIDENCE_KEYS = [
  "fiber_commit",
  "fiber_e2e_blockers",
  "fiber_e2e_challenge_id",
  "fiber_e2e_mode",
  "fiber_e2e_payment_hash",
  "fiber_e2e_receipt_reference",
  "fiber_e2e_status",
  "fiber_live_test_loaded",
  "fiber_live_test_selected",
  "fiber_preflight_test_loaded",
  "live_fiber_testnet_e2e",
  "schema",
  "testnet_evidence_digest",
  "testnet_evidence_recorded_at",
  "testnet_fiber_e2e",
  "testnet_fiber_e2e_evidence"
].sort();

function verifyPreservedTestnetEvidence(report, options = {}) {
  const evidencePath = options.path || "reports/fiber-testnet-e2e-success.json";
  const blockers = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return missingEvidenceResult(evidencePath);
  }

  const actualKeys = Object.keys(report).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(TESTNET_EVIDENCE_KEYS)) {
    blockers.push("preserved testnet evidence does not match the exact v1 field set");
  }
  if (report.schema !== TESTNET_EVIDENCE_SCHEMA) {
    blockers.push(`preserved testnet evidence schema is not ${TESTNET_EVIDENCE_SCHEMA}`);
  }
  if (report.fiber_preflight_test_loaded !== true) blockers.push("preserved testnet evidence preflight did not load");
  if (report.fiber_live_test_selected !== true) blockers.push("preserved testnet evidence live test was not selected");
  if (report.fiber_live_test_loaded !== true) blockers.push("preserved testnet evidence live test did not load");
  if (report.fiber_e2e_mode !== "testnet") blockers.push("preserved testnet evidence mode is not testnet");
  if (report.fiber_e2e_status !== "passed") blockers.push("preserved testnet evidence status is not passed");
  if (!Array.isArray(report.fiber_e2e_blockers) || report.fiber_e2e_blockers.length > 0) {
    blockers.push("preserved testnet evidence still has Fiber E2E blockers");
  }
  if (!/^0x[0-9a-f]{64}$/.test(String(report.fiber_e2e_payment_hash || ""))) {
    blockers.push("preserved testnet evidence payment hash is missing, invalid, or noncanonical");
  }
  if (
    !/^0x[0-9a-f]{64}$/.test(String(report.fiber_e2e_receipt_reference || "")) ||
    report.fiber_e2e_receipt_reference !== report.fiber_e2e_payment_hash
  ) {
    blockers.push("preserved testnet evidence receipt reference is missing, invalid, noncanonical, or does not match payment hash");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(report.fiber_e2e_challenge_id || ""))) {
    blockers.push("preserved testnet evidence challenge id is missing or invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(String(report.fiber_commit || ""))) {
    blockers.push("preserved testnet evidence Fiber commit is missing, invalid, or noncanonical");
  } else if (options.expectedFiberCommit && report.fiber_commit !== options.expectedFiberCommit) {
    blockers.push(
      `preserved testnet evidence Fiber commit mismatch: expected ${options.expectedFiberCommit}, found ${report.fiber_commit}`
    );
  }
  if (!isIsoTimestamp(report.testnet_evidence_recorded_at)) {
    blockers.push("preserved testnet evidence recorded_at is missing or invalid");
  }
  const declaredDigest = report.testnet_evidence_digest;
  const computedDigest = computeTestnetEvidenceDigest(report).digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(String(declaredDigest || ""))) {
    blockers.push("preserved testnet evidence digest is missing or invalid");
  } else if (declaredDigest !== computedDigest) {
    blockers.push(`preserved testnet evidence digest mismatch: expected ${computedDigest}, found ${declaredDigest}`);
  }
  if (report.live_fiber_testnet_e2e !== true) blockers.push("preserved evidence does not record live_fiber_testnet_e2e");
  if (report.testnet_fiber_e2e !== true) blockers.push("preserved evidence does not record testnet_fiber_e2e");
  if (report.testnet_fiber_e2e_evidence !== true) blockers.push("preserved evidence does not record testnet_fiber_e2e_evidence");

  return {
    verified: blockers.length === 0,
    blockers,
    paymentHash: report.fiber_e2e_payment_hash || null,
    receiptReference: report.fiber_e2e_receipt_reference || null,
    challengeId: report.fiber_e2e_challenge_id || null,
    fiberCommit: report.fiber_commit || null,
    recordedAt: report.testnet_evidence_recorded_at || null,
    evidenceDigest: declaredDigest || null
  };
}

function computeTestnetEvidenceDigest(report) {
  const material = {
    schema: TESTNET_EVIDENCE_DIGEST_SCHEMA,
    evidence_schema: report?.schema || null,
    fiber_commit: report?.fiber_commit || null,
    testnet_evidence_recorded_at: report?.testnet_evidence_recorded_at || null,
    fiber_preflight_test_loaded: report?.fiber_preflight_test_loaded === true,
    fiber_live_test_selected: report?.fiber_live_test_selected === true,
    fiber_live_test_loaded: report?.fiber_live_test_loaded === true,
    fiber_e2e_mode: report?.fiber_e2e_mode || null,
    fiber_e2e_status: report?.fiber_e2e_status || null,
    live_fiber_testnet_e2e: report?.live_fiber_testnet_e2e === true,
    testnet_fiber_e2e: report?.testnet_fiber_e2e === true,
    testnet_fiber_e2e_evidence: report?.testnet_fiber_e2e_evidence === true,
    fiber_e2e_payment_hash: report?.fiber_e2e_payment_hash || null,
    fiber_e2e_receipt_reference: report?.fiber_e2e_receipt_reference || null,
    fiber_e2e_challenge_id: report?.fiber_e2e_challenge_id || null,
    fiber_e2e_blockers: Array.isArray(report?.fiber_e2e_blockers) ? report.fiber_e2e_blockers : null
  };
  return {
    digest: `sha256:${sha256Hex(canonicalJson(material))}`,
    material
  };
}

function missingEvidenceResult(evidencePath) {
  return {
    verified: false,
    blockers: [`preserved testnet Fiber E2E evidence missing: ${evidencePath}`],
    paymentHash: null,
    receiptReference: null,
    challengeId: null,
    fiberCommit: null,
    recordedAt: null,
    evidenceDigest: null
  };
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

module.exports = {
  TESTNET_EVIDENCE_SCHEMA,
  computeTestnetEvidenceDigest,
  verifyPreservedTestnetEvidence
};
