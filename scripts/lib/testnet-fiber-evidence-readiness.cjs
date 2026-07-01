const { createHash } = require("node:crypto");

function verifyPreservedTestnetEvidence(report, options = {}) {
  const evidencePath = options.path || "reports/fiber-testnet-e2e-success.json";
  const blockers = [];
  if (!report) {
    return {
      verified: false,
      blockers: [`preserved testnet Fiber E2E evidence missing: ${evidencePath}`],
      paymentHash: null,
      receiptId: null,
      fiberCommit: null,
      recordedAt: null,
      evidenceDigest: null
    };
  }

  const facts = extractTestnetEvidenceFacts(report, options);
  const {
    result,
    gate,
    paymentHash,
    receiptId,
    fiberCommit,
    recordedAt,
    resultBlockers,
    gateBlockers
  } = facts;
  const declaredDigest = testnetEvidenceDigestValue(report);
  const computedDigest = computeTestnetEvidenceDigest(report, options).digest;

  if (Object.hasOwn(report, "status") && report.status !== "passed") {
    blockers.push("preserved testnet evidence status is not passed");
  }
  if (Object.hasOwn(report, "gate_exit") && report.gate_exit !== 0) {
    blockers.push("preserved testnet evidence gate_exit is not 0");
  }
  if (result.fiber_preflight_test_loaded !== true) blockers.push("preserved testnet evidence preflight did not load");
  if (result.fiber_live_test_selected !== true) blockers.push("preserved testnet evidence live test was not selected");
  if (result.fiber_live_test_loaded !== true) blockers.push("preserved testnet evidence live test did not load");
  if (result.fiber_e2e_mode !== "testnet") blockers.push("preserved testnet evidence mode is not testnet");
  if (result.fiber_e2e_status !== "passed") blockers.push("preserved testnet evidence status is not passed");
  if (resultBlockers.length > 0 || gateBlockers.length > 0) {
    blockers.push("preserved testnet evidence still has Fiber E2E blockers");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(paymentHash || ""))) {
    blockers.push("preserved testnet evidence payment hash is missing or invalid");
  }
  if (!/^rcpt_[a-z0-9]+$/i.test(String(receiptId || ""))) {
    blockers.push("preserved testnet evidence receipt id is missing or invalid");
  }
  if (options.expectedFiberCommit && fiberCommit !== options.expectedFiberCommit) {
    blockers.push(`preserved testnet evidence Fiber commit mismatch: expected ${options.expectedFiberCommit}, found ${fiberCommit || "missing"}`);
  }
  if (!isIsoTimestamp(recordedAt)) {
    blockers.push("preserved testnet evidence recorded_at is missing or invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(declaredDigest || ""))) {
    blockers.push("preserved testnet evidence digest is missing or invalid");
  } else if (declaredDigest !== computedDigest) {
    blockers.push(`preserved testnet evidence digest mismatch: expected ${computedDigest}, found ${declaredDigest}`);
  }
  if (gate.live_fiber_testnet_e2e !== true) blockers.push("preserved gate report does not record live_fiber_testnet_e2e");
  if (gate.testnet_fiber_e2e !== true) blockers.push("preserved gate report does not record testnet_fiber_e2e");
  if (gate.testnet_fiber_e2e_evidence !== true) blockers.push("preserved gate report does not record testnet_fiber_e2e_evidence");

  return {
    verified: blockers.length === 0,
    blockers,
    paymentHash: paymentHash || null,
    receiptId: receiptId || null,
    fiberCommit: fiberCommit || null,
    recordedAt: recordedAt || null,
    evidenceDigest: declaredDigest || null
  };
}

function normalizePreservedTestnetEvidence(report, options = {}) {
  if (!report || typeof report !== "object") return report;
  const next = { ...report };
  if (!testnetEvidenceRecordedAtValue(next) && options.fallbackRecordedAt) {
    next.testnet_evidence_recorded_at = options.fallbackRecordedAt;
  }
  if (!testnetEvidenceDigestValue(next)) {
    next.testnet_evidence_digest = computeTestnetEvidenceDigest(next, options).digest;
  }
  return next;
}

function computeTestnetEvidenceDigest(report, options = {}) {
  return {
    digest: `sha256:${sha256Hex(canonicalJson(testnetEvidenceDigestMaterial(report, options)))}`,
    material: testnetEvidenceDigestMaterial(report, options)
  };
}

function testnetEvidenceDigestMaterial(report, options = {}) {
  const facts = extractTestnetEvidenceFacts(report || {}, options);
  return {
    schema: "fiber-paid-http-testnet-evidence-digest-v1",
    fiber_commit: facts.fiberCommit || null,
    testnet_evidence_recorded_at: facts.recordedAt || null,
    fiber_preflight_test_loaded: facts.result.fiber_preflight_test_loaded === true || facts.gate.fiber_preflight_test_loaded === true,
    fiber_live_test_selected: facts.result.fiber_live_test_selected === true || facts.gate.fiber_live_test_selected === true,
    fiber_live_test_loaded: facts.result.fiber_live_test_loaded === true || facts.gate.fiber_live_test_loaded === true,
    fiber_e2e_mode: facts.result.fiber_e2e_mode || facts.gate.fiber_e2e_mode || null,
    fiber_e2e_status: facts.result.fiber_e2e_status || facts.gate.fiber_e2e_status || null,
    live_fiber_testnet_e2e: facts.result.live_fiber_testnet_e2e === true || facts.gate.live_fiber_testnet_e2e === true,
    testnet_fiber_e2e: facts.result.testnet_fiber_e2e === true || facts.gate.testnet_fiber_e2e === true,
    testnet_fiber_e2e_evidence: facts.result.testnet_fiber_e2e_evidence === true || facts.gate.testnet_fiber_e2e_evidence === true,
    fiber_e2e_payment_hash: facts.paymentHash || null,
    fiber_e2e_receipt_id: facts.receiptId || null,
    fiber_e2e_blockers: [...facts.resultBlockers, ...facts.gateBlockers]
  };
}

function extractTestnetEvidenceFacts(report, options = {}) {
  const result = report.fiber_e2e_result || report;
  const gate = report.gate_report || report;
  return {
    result,
    gate,
    paymentHash: result.fiber_e2e_payment_hash || gate.fiber_e2e_payment_hash || report.fiber_e2e_payment_hash,
    receiptId: result.fiber_e2e_receipt_id || gate.fiber_e2e_receipt_id || report.fiber_e2e_receipt_id,
    fiberCommit: result.fiber_commit || gate.fiber_commit || report.fiber_commit,
    recordedAt: testnetEvidenceRecordedAtValue(report, options),
    resultBlockers: Array.isArray(result.fiber_e2e_blockers) ? result.fiber_e2e_blockers : [],
    gateBlockers: Array.isArray(gate.fiber_e2e_blockers) ? gate.fiber_e2e_blockers : []
  };
}

function testnetEvidenceRecordedAtValue(report, options = {}) {
  const result = report.fiber_e2e_result || report;
  const gate = report.gate_report || report;
  return (
    result.testnet_evidence_recorded_at ||
    gate.testnet_evidence_recorded_at ||
    report.testnet_evidence_recorded_at ||
    result.generated_at ||
    gate.generated_at ||
    report.generated_at ||
    options.fallbackRecordedAt
  );
}

function testnetEvidenceDigestValue(report) {
  const result = report.fiber_e2e_result || report;
  const gate = report.gate_report || report;
  return report.testnet_evidence_digest || result.testnet_evidence_digest || gate.testnet_evidence_digest;
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
  computeTestnetEvidenceDigest,
  normalizePreservedTestnetEvidence,
  verifyPreservedTestnetEvidence
};
