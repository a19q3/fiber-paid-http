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

      expect(source, script).toContain("normalizePreservedTestnetEvidence");
      expect(source, script).toContain("verifyPreservedTestnetEvidence");
      expect(source, script).toContain("reports/fiber-testnet-e2e-success.json");
      expect(source, script).toContain("expectedFiberCommit");
      expect(source, script).toContain("readFiberCommit");
      expect(source, script).toContain("fallbackRecordedAt");
      expect(source, script).toContain("readTestnetEvidenceRecordedAt");
      expect(source, script).toContain("testnet_fiber_e2e_evidence_verified");
      expect(source, script).toContain("testnet_evidence_recorded_at");
      expect(source, script).toContain("testnet_evidence_digest");
      expect(source, script).toContain("fiber_commit");
      expect(source, script).not.toContain("gate.testnet_fiber_e2e === true");
      expect(source, script).not.toContain("gate.testnet_fiber_e2e_evidence === true");
    }
  });

  it("requires the testnet wrapper success report to come from the current live testnet run", () => {
    const source = readFileSync("scripts/fiber_testnet_e2e.sh", "utf8");

    expect(source).toContain('gate?.live_fiber_testnet_e2e === true');
    expect(source).toContain('gate?.testnet_fiber_e2e_evidence_verified === true');
    expect(source).toContain('gate?.testnet_fiber_e2e_evidence_source === "current-live-testnet-run"');
    expect(source).not.toContain("canonical?.testnet_fiber_e2e === true");
  });

  it("keeps evidence web server hardening in the main gate", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain("check-server");
    expect(source).toContain("evidence-console-server-hardening.log");
    expect(source).toContain("EVIDENCE_CONSOLE_SERVER_HARDENING");
    expect(source).toContain("evidence_console_server_hardening");
    expect(source).toContain("serverHardeningBlockers");
  });

  it("keeps one-command Evidence Console startup in the main gate", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain("check-cli-start");
    expect(source).toContain("evidence-console-cli-start.log");
    expect(source).toContain("evidence-console-cli-start.json");
    expect(source).toContain("EVIDENCE_CONSOLE_CLI_START");
    expect(source).toContain("evidence_console_cli_start");
    expect(source).toContain("cliStartVerified");
    expect(source).toContain("api_and_web_started_by_single_cli_command");
  });

  it("requires the browser smoke to use the served Evidence Console", () => {
    const source = readFileSync("scripts/fiber_paid_http_gate.sh", "utf8");

    expect(source).toContain('report.web_origin !== "served-local-web-server"');
    expect(source).toContain('report.api_base_source !== "served HTML injected by evidence web server"');
    expect(source).toContain("evidence_console_browser_smoke_served_web_origin");
  });
});
