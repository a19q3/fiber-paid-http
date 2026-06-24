import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapReport,
  gatewayConfigTemplate,
  resolveGatewayConfig,
  writeGatewayConfigTemplate
} from "../../packages/cli/src/bootstrap.js";

describe("FiberMPP bootstrap helpers", () => {
  it("reports gateway blockers instead of a single adapter error", () => {
    const report = buildBootstrapReport("gateway", {
      env: {},
      storage: "sqlite://./fiber-mpp.sqlite",
      methods: ["fiber"]
    });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("set FIBER_MODE=local or FIBER_MODE=testnet");
    expect(report.blockers).toContain("set FIBER_PAYEE_RPC_URL or FIBER_RPC_URL for the invoice/payee node");
    expect(report.blockers).toContain("set an upstream URL with --upstream or gateway config upstream");
    expect(report.blockers.join("\n")).toContain("FIBER_MPP_SECRET");
  });

  it("reports payer-specific blockers", () => {
    const report = buildBootstrapReport("payer", { env: { FIBER_MODE: "local" } });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(["set FIBER_PAYER_RPC_URL or FIBER_RPC_URL for the payer node"]);
  });

  it("resolves a gateway config into runtime settings without embedding secrets in the config", () => {
    const config = gatewayConfigTemplate();
    const resolved = resolveGatewayConfig({ config }, {
      FIBER_MPP_SECRET: "a".repeat(64)
    });
    expect(resolved.upstream).toBe("http://localhost:8080");
    expect(resolved.port).toBe(8790);
    expect(resolved.secret).toBe("a".repeat(64));
    expect(resolved.fiberEnv.FIBER_MODE).toBe("local");
    expect(resolved.fiberEnv.FIBER_PAYEE_RPC_URL).toBe("http://127.0.0.1:21716");
  });

  it("accepts a plain SQLite path and normalizes it for gateway startup", () => {
    const config = gatewayConfigTemplate();
    const resolved = resolveGatewayConfig(
      {
        config,
        storage: "/tmp/fiber-mpp.sqlite"
      },
      {
        FIBER_MPP_SECRET: "a".repeat(64)
      }
    );
    expect(resolved.storage).toBe("sqlite:///tmp/fiber-mpp.sqlite");
  });

  it("writes a gateway template without a literal secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-mpp-bootstrap-"));
    const path = join(dir, "gateway.json");
    await writeGatewayConfigTemplate(path);
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("\"secret_env\": \"FIBER_MPP_SECRET\"");
    expect(contents).not.toContain("fiber-mpp-proxy-secret");
    expect(contents).not.toContain("fiber-mpp-live-e2e-secret");
  });
});
