function productionBootstrapReadiness(report, options = {}) {
  const checks = [
    ["schema", report?.schema === "fiber-paid-http-production-bootstrap-v1"],
    ["generated_at", isIsoTimestamp(report?.generated_at)],
    ["status", report?.status === "passed"],
    ["blockers", Array.isArray(report?.blockers) && report.blockers.length === 0],
    ["mode", report?.mode === "testnet"],
    ["engine", report?.engine === "rust"],
    ["fiber_commit", typeof report?.fiber_commit === "string" && /^[0-9a-f]{40}$/.test(report.fiber_commit)],
    ["fiber_commit_current", !options.expectedFiberCommit || report?.fiber_commit === options.expectedFiberCommit],
    ["transport.tls", report?.transport?.tls === true],
    ["transport.protocol", ["TLSv1.2", "TLSv1.3"].includes(report?.transport?.protocol)],
    ["transport.public_base_url", validHttpsOrigin(report?.transport?.public_base_url)],
    ["payer_bootstrap.status", report?.payer_bootstrap?.status === "ready"],
    ["payer_bootstrap.node_id", typeof report?.payer_bootstrap?.node_id === "string" && report.payer_bootstrap.node_id.length > 0],
    ["payer_bootstrap.rpc_auth_from_env", report?.payer_bootstrap?.rpc_auth_from_env === true],
    ["payer_bootstrap.rpc_auth_enforced", report?.payer_bootstrap?.rpc_auth_enforced === true],
    ["payer_bootstrap.missing_auth_rejected", report?.payer_bootstrap?.missing_auth_rejected === true],
    ["payer_bootstrap.invalid_auth_rejected", report?.payer_bootstrap?.invalid_auth_rejected === true],
    ["payer_bootstrap.peers", Number(report?.payer_bootstrap?.peers ?? 0) > 0],
    ["payer_bootstrap.ready_channels", Number(report?.payer_bootstrap?.ready_channels ?? 0) > 0],
    ["payee_bootstrap.status", report?.payee_bootstrap?.status === "ready"],
    ["payee_bootstrap.node_id", typeof report?.payee_bootstrap?.node_id === "string" && report.payee_bootstrap.node_id.length > 0],
    ["payee_bootstrap.rpc_auth_from_env", report?.payee_bootstrap?.rpc_auth_from_env === true],
    ["payee_bootstrap.rpc_auth_enforced", report?.payee_bootstrap?.rpc_auth_enforced === true],
    ["payee_bootstrap.missing_auth_rejected", report?.payee_bootstrap?.missing_auth_rejected === true],
    ["payee_bootstrap.invalid_auth_rejected", report?.payee_bootstrap?.invalid_auth_rejected === true],
    ["payee_bootstrap.peers", Number(report?.payee_bootstrap?.peers ?? 0) > 0],
    ["payee_bootstrap.ready_channels", Number(report?.payee_bootstrap?.ready_channels ?? 0) > 0],
    ["gateway_bootstrap.status", report?.gateway_bootstrap?.status === "ready"],
    ["gateway_bootstrap.server_id", report?.gateway_bootstrap?.server_id === "fiber-paid-http-production-bootstrap-e2e"],
    ["gateway_bootstrap.rust_gateway", report?.gateway_bootstrap?.rust_gateway === true],
    ["gateway_bootstrap.rpc_auth_from_env", report?.gateway_bootstrap?.rpc_auth_from_env === true],
    ["gateway_bootstrap.log_redaction_enabled", report?.gateway_bootstrap?.log_redaction_enabled === true],
    ["gateway_bootstrap.rate_limit_enforced", report?.gateway_bootstrap?.rate_limit_enforced === true],
    ["gateway_bootstrap.body_limit_enforced", report?.gateway_bootstrap?.body_limit_enforced === true],
    ["gateway_bootstrap.upstream_timeout_enforced", report?.gateway_bootstrap?.upstream_timeout_enforced === true],
    ["gateway_bootstrap.upstream_response_limit_enforced", report?.gateway_bootstrap?.upstream_response_limit_enforced === true],
    ["gateway_bootstrap.graceful_shutdown", report?.gateway_bootstrap?.graceful_shutdown === true],
    [
      "gateway_bootstrap.graceful_shutdown_duration_ms",
      Number.isInteger(report?.gateway_bootstrap?.graceful_shutdown_duration_ms) &&
        report.gateway_bootstrap.graceful_shutdown_duration_ms >= 0 &&
        report.gateway_bootstrap.graceful_shutdown_duration_ms < 10000
    ],
    ["unpaid_request_status", report?.unpaid_request_status === 402],
    ["paid_request.status", report?.paid_request?.status === 200],
    ["paid_request.receipt_reference", typeof report?.paid_request?.receipt_reference === "string" && /^0x[0-9a-f]{64}$/.test(report.paid_request.receipt_reference)],
    ["paid_request.challenge_id", typeof report?.paid_request?.challenge_id === "string" && /^[A-Za-z0-9_-]{43}$/.test(report.paid_request.challenge_id)],
    ["paid_request.payment_hash", typeof report?.paid_request?.payment_hash === "string" && /^0x[0-9a-f]{64}$/.test(report.paid_request.payment_hash)],
    ["paid_request.reference_matches_payment_hash", report?.paid_request?.receipt_reference === report?.paid_request?.payment_hash],
    ["paid_request.receipt_schema_valid", report?.paid_request?.receipt_schema_valid === true],
    ["paid_request.settlement_status", report?.paid_request?.settlement_status === "settled"],
    ["paid_request.delivery_status", report?.paid_request?.delivery_status === "delivered"],
    ["paid_request.delivery_response_status", report?.paid_request?.delivery_response_status === 200],
    ["replay.status", report?.replay?.status === 402],
    ["replay.receipt_reissued", report?.replay?.receipt_reissued === false],
    ["replay.service_executions", report?.replay?.service_executions === 1],
    ["operational_limits.body_limit_status", report?.operational_limits?.body_limit_status === 413],
    ["operational_limits.rate_limit_status", report?.operational_limits?.rate_limit_status === 429],
    ["operational_limits.retry_after_present", report?.operational_limits?.retry_after_present === true],
    ["operational_limits.upstream_response_limit_status", report?.operational_limits?.upstream_response_limit_status === 502],
    ["operational_limits.upstream_response_limit_receipt_reissued", report?.operational_limits?.upstream_response_limit_receipt_reissued === false],
    ["operational_limits.upstream_timeout_status", report?.operational_limits?.upstream_timeout_status === 502],
    ["operational_limits.upstream_timeout_receipt_reissued", report?.operational_limits?.upstream_timeout_receipt_reissued === false],
    ["storage.schema_version", report?.storage?.schema_version === 1],
    ["storage.journal_mode", String(report?.storage?.journal_mode ?? "").toLowerCase() === "wal"],
    ["storage.foreign_keys", report?.storage?.foreign_keys === true],
    ["storage.integrity_check", report?.storage?.integrity_check === "ok"],
    ["storage.receipts", Number(report?.storage?.receipts ?? 0) >= 1],
    ["storage.valid_receipts", Number(report?.storage?.valid_receipts ?? 0) >= 1],
    ["storage.invalid_receipts", Number(report?.storage?.invalid_receipts ?? 0) === 0],
    ["storage.failed_deliveries", Number(report?.storage?.failed_deliveries ?? 0) === 2],
    ["storage.expected_probe_failed_deliveries", Number(report?.storage?.expected_probe_failed_deliveries ?? 0) === 2],
    ["storage.unexpected_failed_deliveries", Number(report?.storage?.unexpected_failed_deliveries ?? 0) === 0]
  ];
  const missing = checks.filter(([, passed]) => !passed).map(([id]) => id);
  return {
    ready: missing.length === 0,
    missing
  };
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validHttpsOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

module.exports = { productionBootstrapReadiness };
