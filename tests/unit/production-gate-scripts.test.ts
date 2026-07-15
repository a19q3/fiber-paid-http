import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production gate scripts", () => {
  it("requires preserved testnet evidence verification in production gates", () => {
    for (const script of [
      "scripts/fiber_paid_http_gate.sh",
      "scripts/fiber_paid_http_ops_gate.sh",
      "scripts/fiber_paid_http_canonical_gate.sh",
      "scripts/fiber_paid_http_rust_gate.sh"
    ]) {
      const source = readFileSync(script, "utf8");

      expect(source, script).toContain("verifyPreservedTestnetEvidence");
      expect(source, script).toContain("reports/fiber-testnet-e2e-success.json");
      expect(source, script).toContain("expectedFiberCommit");
      expect(source, script).toContain("readFiberCommit");
      expect(source, script).not.toContain("normalizePreservedTestnetEvidence");
      expect(source, script).not.toContain("fallbackRecordedAt");
      expect(source, script).not.toContain("readTestnetEvidenceRecordedAt");
      expect(source, script).toContain("testnet_fiber_e2e_evidence_verified");
      expect(source, script).toContain("testnet_evidence_recorded_at");
      expect(source, script).toContain("testnet_evidence_digest");
      expect(source, script).toContain("fiber_commit");
      expect(source, script).not.toContain("gate.testnet_fiber_e2e === true");
      expect(source, script).not.toContain("gate.testnet_fiber_e2e_evidence === true");
    }
  });

  it("creates a dedicated immutable v1 artifact only from a current live testnet run", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain("TESTNET_EVIDENCE_SCHEMA");
    expect(source).toContain("computeTestnetEvidenceDigest(");
    expect(source).toContain("createTestnetSuccessEvidence(report)");
    expect(source).toContain("report.testnet_evidence_digest = currentTestnetSuccessEvidence.testnet_evidence_digest");
    expect(source.indexOf("report.testnet_evidence_digest =")).toBeLessThan(
      source.indexOf('fs.writeFileSync("reports/fiber-paid-http-gate.json"')
    );
    expect(source).not.toContain("syncProductionBootstrapReport");
    expect(source).not.toContain("syncArchivedTestnetEvidence");
    const preservedBranch = source.slice(
      source.indexOf("} else if (liveFiberTestnetE2e)"),
      source.indexOf("} else if (fs.existsSync(\"reports/fiber-local-e2e-success.json\"))")
    );
    expect(preservedBranch).not.toContain("success.production_ready_for_fiber_method =");
    expect(preservedBranch).not.toContain("success.production_bootstrap_e2e =");
  });

  it("requires the testnet wrapper success report to come from the current live testnet run", () => {
    const source = readFileSync("scripts/fiber_testnet_e2e.sh", "utf8");

    expect(source).toContain('gate?.live_fiber_testnet_e2e === true');
    expect(source).toContain('gate?.testnet_fiber_e2e_evidence_verified === true');
    expect(source).toContain('gate?.testnet_fiber_e2e_evidence_source === "current-live-testnet-run"');
    expect(source).not.toContain("canonical?.testnet_fiber_e2e === true");
  });

  it("declares every workspace package imported by the root production bootstrap", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };

    for (const dependency of [
      "@fiber-paid-http/core",
      "@fiber-paid-http/fiber-method",
      "@fiber-paid-http/storage"
    ]) {
      expect(packageJson.dependencies?.[dependency], dependency).toBe("workspace:*");
    }
  });

  it("captures the TLS protocol before the Node response socket can be released", () => {
    const source = readFileSync("scripts/fiber_production_bootstrap_e2e.mjs", "utf8");

    expect(source).toContain("const tlsProtocol = response.socket?.getProtocol?.() ?? null;");
    expect(source).not.toContain("response.socket.getProtocol?.()");
  });

  it("reads protocol response headers case-insensitively under Node", () => {
    const source = readFileSync("scripts/fiber_production_bootstrap_e2e.mjs", "utf8");

    expect(source).toContain("function responseHeader(headers, name)");
    expect(source).toContain("headers[name.toLowerCase()] ?? headers[name]");
    expect(source).not.toContain("headers[PAYMENT_RECEIPT_HEADER]");
  });

  it("keeps evidence web server hardening in the main gate", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain("check-server");
    expect(source).toContain("evidence-console-server-hardening.log");
    expect(source).toContain("EVIDENCE_CONSOLE_SERVER_HARDENING");
    expect(source).toContain("evidence_console_server_hardening");
    expect(source).toContain("serverHardeningBlockers");
  });

  it("keeps one-command Gateway Lab startup in the main gate", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain("check-cli-start");
    expect(source).toContain("evidence-console-cli-start.log");
    expect(source).toContain("evidence-console-cli-start.json");
    expect(source).toContain("EVIDENCE_CONSOLE_CLI_START");
    expect(source).toContain("evidence_console_cli_start");
    expect(source).toContain("cliStartVerified");
    expect(source).toContain("api_and_web_started_by_single_cli_command");
    expect(source).toContain("r.evidence_console_cli_start === false");
  });

  it("requires the browser smoke to use the served Gateway Lab", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain('report.web_origin !== "served-local-web-server"');
    expect(source).toContain('report.api_base_source !== "served HTML injected by evidence web server"');
    expect(source).toContain("evidence_console_browser_smoke_served_web_origin");
    expect(source).toContain('evidence.service_executed === "executed before receipt"');
    expect(source).not.toContain('evidence.service_executed === "executed after receipt"');
  });

  it("isolates non-live integration tests from the live Fiber gate environment", () => {
    const source = readFileSync("scripts/fiber_paid_http_canonical_gate.sh", "utf8");

    expect(source).toContain("without_live_fiber_env() {");
    expect(source).toContain("without_live_fiber_env pnpm test:integration");
    expect(source).toContain("-u FIBER_MODE");
    expect(source).toContain("-u FIBER_PAYEE_RPC_URL");
    expect(source).toContain("-u FIBER_PAYER_RPC_URL");
    expect(source).toContain("-u FIBER_PAID_HTTP_SECRET");
  });
});
