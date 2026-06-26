function productionBootstrapReadiness(report) {
  const checks = [
    ["status", report?.status === "passed"],
    ["payer_bootstrap.status", report?.payer_bootstrap?.status === "ready"],
    ["payer_bootstrap.ready_channels", Number(report?.payer_bootstrap?.ready_channels ?? 0) > 0],
    ["payee_bootstrap.status", report?.payee_bootstrap?.status === "ready"],
    ["payee_bootstrap.ready_channels", Number(report?.payee_bootstrap?.ready_channels ?? 0) > 0],
    ["gateway_bootstrap.status", report?.gateway_bootstrap?.status === "ready"],
    ["gateway_bootstrap.rpc_auth_from_env", report?.gateway_bootstrap?.rpc_auth_from_env === true],
    ["gateway_bootstrap.log_redaction_enabled", report?.gateway_bootstrap?.log_redaction_enabled === true],
    ["gateway_bootstrap.rate_limit_enabled", report?.gateway_bootstrap?.rate_limit_enabled === true],
    ["unpaid_request_status", report?.unpaid_request_status === 402],
    ["paid_request.status", report?.paid_request?.status === 200],
    ["paid_request.receipt_id", typeof report?.paid_request?.receipt_id === "string" && report.paid_request.receipt_id.length > 0],
    ["paid_request.payment_hash", typeof report?.paid_request?.payment_hash === "string" && /^0x[0-9a-f]+$/i.test(report.paid_request.payment_hash)],
    ["paid_request.receipt_signature_valid", report?.paid_request?.receipt_signature_valid === true],
    ["paid_request.settlement_status", report?.paid_request?.settlement_status === "settled"],
    ["paid_request.delivery_status", report?.paid_request?.delivery_status === "delivered"],
    ["paid_request.delivery_response_status", report?.paid_request?.delivery_response_status === 200],
    ["storage.schema_version", Number(report?.storage?.schema_version ?? 0) >= 1],
    ["storage.journal_mode", String(report?.storage?.journal_mode ?? "").toLowerCase() === "wal"],
    ["storage.foreign_keys", report?.storage?.foreign_keys === true],
    ["storage.integrity_check", report?.storage?.integrity_check === "ok"],
    ["storage.receipts", Number(report?.storage?.receipts ?? 0) >= 1],
    ["storage.valid_receipts", Number(report?.storage?.valid_receipts ?? 0) >= 1],
    ["storage.invalid_receipts", Number(report?.storage?.invalid_receipts ?? 0) === 0],
    ["storage.failed_deliveries", Number(report?.storage?.failed_deliveries ?? 0) === 0]
  ];
  const missing = checks.filter(([, passed]) => !passed).map(([id]) => id);
  return {
    ready: missing.length === 0,
    missing
  };
}

module.exports = { productionBootstrapReadiness };
