import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapReport,
  fiberEnvFromGatewayConfig,
  gatewayConfigTemplate,
  probeFiberRpcReadiness,
  previousSecretsFromGatewayConfig,
  resolveGatewayConfig,
  writeGatewayConfigTemplate
} from "../../packages/cli/src/bootstrap.js";

describe("Fiber Paid HTTP bootstrap helpers", () => {
  it("reports gateway blockers instead of a single adapter error", () => {
    const report = buildBootstrapReport("gateway", {
      env: {},
      storage: "sqlite://./fiber-paid-http.sqlite",
      methods: ["fiber"]
    });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("set FIBER_MODE=local or FIBER_MODE=testnet");
    expect(report.blockers).toContain("set FIBER_PAYEE_RPC_URL or FIBER_RPC_URL for the invoice/payee node");
    expect(report.blockers).toContain("set an upstream URL with --upstream or gateway config upstream");
    expect(report.blockers.join("\n")).toContain("FIBER_PAID_HTTP_SECRET");
  });

  it("reports payer-specific blockers", () => {
    const report = buildBootstrapReport("payer", { env: { FIBER_MODE: "local" } });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(["set FIBER_PAYER_RPC_URL or FIBER_RPC_URL for the payer node"]);
  });

  it("blocks non-CKB gateway price currency", () => {
    const report = buildBootstrapReport("gateway", {
      env: {
        FIBER_MODE: "local",
        FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716"
      },
      upstream: "http://localhost:8080",
      storage: "sqlite://./fiber-paid-http.sqlite",
      secret: "a".repeat(64),
      methods: ["fiber"],
      price: { value: "0.01", currency: "USD", display: "$0.01" }
    });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("gateway price currency must be CKB");
  });

  it("blocks wildcard gateway CORS origins", () => {
    const report = buildBootstrapReport("gateway", {
      env: {
        FIBER_MODE: "local",
        FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716"
      },
      upstream: "http://localhost:8080",
      storage: "sqlite://./fiber-paid-http.sqlite",
      secret: "a".repeat(64),
      methods: ["fiber"],
      price: { value: "1", currency: "CKB", display: "1 CKB" },
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["authorization", "content-type"],
        allowedMethods: ["GET", "POST", "OPTIONS"],
        exposeHeaders: ["payment-receipt", "www-authenticate"],
        allowCredentials: false
      }
    });
    expect(report.status).toBe("blocked");
    expect(report.checks.cors_wildcard_disabled).toBe(false);
    expect(report.blockers).toContain("gateway CORS allowed_origins must not include *");
  });

  it("blocks invalid gateway operation hardening values", () => {
    const report = buildBootstrapReport("gateway", {
      env: {
        FIBER_MODE: "local",
        FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716"
      },
      upstream: "http://localhost:8080",
      storage: "sqlite://./fiber-paid-http.sqlite",
      secret: "a".repeat(64),
      methods: ["fiber"],
      price: { value: "1", currency: "CKB", display: "1 CKB" },
      operations: {
        healthPath: "healthz",
        readinessPath: "/readyz",
        metricsPath: "/metrics",
        requestBodyLimitBytes: 512,
        shutdownGraceMs: 100,
        logRedaction: {
          enabled: false,
          extraKeys: []
        },
        rateLimit: {
          windowMs: 100,
          maxRequests: 0
        }
      }
    });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("gateway operation paths must start with /");
    expect(report.blockers).toContain("gateway request_body_limit_bytes must be at least 1024");
    expect(report.blockers).toContain("gateway shutdown_grace_ms must be at least 1000");
    expect(report.blockers).toContain("gateway log_redaction.enabled must not be false");
    expect(report.blockers).toContain("gateway rate_limit.window_ms must be at least 1000 and max_requests at least 1");
  });

  it("reports configured previous secret env blockers during rotation", () => {
    const report = buildBootstrapReport("gateway", {
      env: {
        FIBER_MODE: "local",
        FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716"
      },
      upstream: "http://localhost:8080",
      storage: "sqlite://./fiber-paid-http.sqlite",
      secret: "a".repeat(64),
      secretEnv: "FIBER_PAID_HTTP_SECRET",
      previousSecretEnvs: ["FIBER_PAID_HTTP_PREVIOUS_SECRET", "FIBER_PAID_HTTP_SHORT_PREVIOUS_SECRET"],
      previousSecrets: [],
      missingPreviousSecretEnvs: ["FIBER_PAID_HTTP_PREVIOUS_SECRET"],
      shortPreviousSecretEnvs: ["FIBER_PAID_HTTP_SHORT_PREVIOUS_SECRET"],
      methods: ["fiber"],
      price: { value: "1", currency: "CKB", display: "1 CKB" }
    });
    expect(report.status).toBe("blocked");
    expect(report.checks.secret_previous_env_count).toBe(2);
    expect(report.checks.secret_previous_present_count).toBe(0);
    expect(report.blockers).toContain("set previous secret env FIBER_PAID_HTTP_PREVIOUS_SECRET or remove it from previous_secret_envs");
    expect(report.blockers).toContain("previous secret env FIBER_PAID_HTTP_SHORT_PREVIOUS_SECRET must be at least 32 characters");
  });

  it("blocks literal Fiber RPC auth in gateway config", () => {
    const report = buildBootstrapReport("gateway", {
      env: {
        FIBER_MODE: "local",
        FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716"
      },
      upstream: "http://localhost:8080",
      storage: "sqlite://./fiber-paid-http.sqlite",
      secret: "a".repeat(64),
      literalRpcAuth: true,
      methods: ["fiber"],
      price: { value: "1", currency: "CKB", display: "1 CKB" }
    });
    expect(report.status).toBe("blocked");
    expect(report.checks.rpc_auth_from_env).toBe(false);
    expect(report.blockers).toContain("Fiber RPC auth must be provided through *_rpc_auth_env or process env, not literal config values");
  });

  it("resolves a gateway config into runtime settings without embedding secrets in the config", () => {
    const config = gatewayConfigTemplate();
    const resolved = resolveGatewayConfig({ config }, {
      FIBER_PAID_HTTP_SECRET: "a".repeat(64)
    });
    expect(resolved.upstream).toBe("http://localhost:8080");
    expect(resolved.price).toEqual({ value: "1", currency: "CKB", display: "1 CKB" });
    expect(resolved.port).toBe(8790);
    expect(resolved.secret).toBe("a".repeat(64));
    expect(resolved.fiberEnv.FIBER_MODE).toBe("local");
    expect(resolved.fiberEnv.FIBER_PAYEE_RPC_URL).toBe("http://127.0.0.1:21716");
    expect(resolved.fl402).toBeUndefined();
    expect(resolved.cors.allowedOrigins).toEqual([]);
    expect(resolved.cors.allowedHeaders).toEqual(["authorization", "content-type"]);
    expect(resolved.cors.allowedMethods).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
    expect(resolved.cors.exposeHeaders).toEqual(["payment-receipt", "www-authenticate"]);
    expect(resolved.cors.allowCredentials).toBe(false);
    expect(resolved.cors.maxAgeSeconds).toBe(600);
    expect(resolved.operations.healthPath).toBe("/healthz");
    expect(resolved.operations.readinessPath).toBe("/readyz");
    expect(resolved.operations.metricsPath).toBe("/metrics");
    expect(resolved.operations.requestBodyLimitBytes).toBe(1_048_576);
    expect(resolved.operations.shutdownGraceMs).toBe(10_000);
    expect(resolved.operations.logRedaction).toEqual({ enabled: true, extraKeys: [] });
    expect(resolved.operations.rateLimit).toEqual({ windowMs: 60_000, maxRequests: 300 });
  });

  it("resolves optional F-L402 gateway config from env", () => {
    const config = {
      ...gatewayConfigTemplate(),
      fl402: {
        root_key_env: "FIBER_PAID_HTTP_FL402_ROOT_KEY",
        hash_algorithm: "sha256" as const
      }
    };
    const resolved = resolveGatewayConfig({ config }, {
      FIBER_PAID_HTTP_SECRET: "a".repeat(64),
      FIBER_PAID_HTTP_FL402_ROOT_KEY: "fl402-root-key-at-least-16"
    });
    expect(resolved.fl402).toEqual({
      rootKey: "fl402-root-key-at-least-16",
      rootKeyEnv: "FIBER_PAID_HTTP_FL402_ROOT_KEY",
      hashAlgorithm: "sha256"
    });
  });

  it("blocks F-L402 gateway config without a root key", () => {
    const report = buildBootstrapReport("gateway", {
      env: {
        FIBER_MODE: "local",
        FIBER_PAYEE_RPC_URL: "http://127.0.0.1:21716"
      },
      upstream: "http://localhost:8080",
      storage: "sqlite://./fiber-paid-http.sqlite",
      secret: "a".repeat(64),
      methods: ["fiber"],
      price: { value: "1", currency: "CKB", display: "1 CKB" },
      fl402Configured: true,
      fl402RootKeyEnv: "FIBER_PAID_HTTP_FL402_ROOT_KEY",
      fl402HashAlgorithm: "sha256"
    });
    expect(report.status).toBe("blocked");
    expect(report.checks.fl402_enabled).toBe(true);
    expect(report.blockers).toContain("set FIBER_PAID_HTTP_FL402_ROOT_KEY to an F-L402 root key of at least 16 characters");
  });

  it("resolves Fiber RPC auth from configured env names", () => {
    const config = {
      ...gatewayConfigTemplate(),
      fiber: {
        ...gatewayConfigTemplate().fiber,
        payee_rpc_auth_env: "FIBER_PAYEE_RPC_AUTH_SECRET"
      }
    };

    expect(fiberEnvFromGatewayConfig(config, {
      FIBER_PAYEE_RPC_AUTH_SECRET: "Bearer payee-secret"
    }).FIBER_PAYEE_RPC_AUTH).toBe("Bearer payee-secret");
  });

  it("resolves previous gateway secrets from env names without embedding values in config", () => {
    const config = {
      ...gatewayConfigTemplate(),
      previous_secret_envs: ["FIBER_PAID_HTTP_PREVIOUS_SECRET"]
    };
    const previousSecret = "p".repeat(64);
    const resolved = resolveGatewayConfig({ config }, {
      FIBER_PAID_HTTP_SECRET: "a".repeat(64),
      FIBER_PAID_HTTP_PREVIOUS_SECRET: previousSecret
    });
    expect(previousSecretsFromGatewayConfig(config, {
      FIBER_PAID_HTTP_PREVIOUS_SECRET: previousSecret
    })).toEqual({
      secretEnvs: ["FIBER_PAID_HTTP_PREVIOUS_SECRET"],
      secrets: [previousSecret],
      missing: [],
      short: []
    });
    expect(resolved.previousSecretEnvs).toEqual(["FIBER_PAID_HTTP_PREVIOUS_SECRET"]);
    expect(resolved.previousSecrets).toEqual([previousSecret]);
  });

  it("accepts a plain SQLite path and normalizes it for gateway startup", () => {
    const config = gatewayConfigTemplate();
    const resolved = resolveGatewayConfig(
      {
        config,
        storage: "/tmp/fiber-paid-http.sqlite"
      },
      {
        FIBER_PAID_HTTP_SECRET: "a".repeat(64)
      }
    );
    expect(resolved.storage).toBe("sqlite:///tmp/fiber-paid-http.sqlite");
  });

  it("writes a gateway template without a literal secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fiber-paid-http-bootstrap-"));
    const path = join(dir, "gateway.json");
    await writeGatewayConfigTemplate(path);
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("\"secret_env\": \"FIBER_PAID_HTTP_SECRET\"");
    expect(contents).toContain("\"previous_secret_envs\": []");
    expect(contents).toContain("\"allowed_origins\": []");
    expect(contents).toContain("\"allowed_headers\": [");
    expect(contents).toContain("\"max_age_seconds\": 600");
    expect(contents).toContain("\"health_path\": \"/healthz\"");
    expect(contents).toContain("\"readiness_path\": \"/readyz\"");
    expect(contents).toContain("\"metrics_path\": \"/metrics\"");
    expect(contents).toContain("\"log_redaction\": {");
    expect(contents).toContain("\"enabled\": true");
    expect(contents).toContain("\"rate_limit\": {");
    expect(contents).toContain("\"max_requests\": 300");
    expect(contents).not.toContain("fiber-paid-http-proxy-secret");
    expect(contents).not.toContain("fiber-paid-http-live-e2e-secret");
  });

  it("probes Fiber peer and channel readiness for live bootstrap", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: string };
      calls.push(payload.method);
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: fiberProbeResult(payload.method)
      });
    }) as typeof fetch;
    const probe = await probeFiberRpcReadiness({
      url: "http://127.0.0.1:21714",
      role: "payer",
      fetchImpl
    });
    expect(probe.ok).toBe(true);
    expect(calls).toEqual(["node_info", "list_peers", "list_channels"]);
    expect(probe.checks.rpc_peer_count).toBe(1);
    expect(probe.checks.rpc_channel_count).toBe(1);
    expect(probe.checks.rpc_ready_channel_count).toBe(1);
    expect(probe.checks.rpc_channel_states).toBe("ChannelReady:1");
  });

  it("accepts v0.9 uppercase channel readiness from Fiber RPC", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: string };
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: payload.method === "list_channels"
          ? { channels: [{ channel_id: `0x${"cd".repeat(32)}`, state: { state_name: "CHANNEL_READY" } }] }
          : fiberProbeResult(payload.method)
      });
    }) as typeof fetch;
    const probe = await probeFiberRpcReadiness({
      url: "http://127.0.0.1:21714",
      role: "payer",
      fetchImpl
    });
    expect(probe.ok).toBe(true);
    expect(probe.checks.rpc_ready_channel_count).toBe(1);
    expect(probe.checks.rpc_channel_states).toBe("CHANNEL_READY:1");
  });

  it("reports Fiber peer and channel blockers instead of only node_info", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: string };
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: payload.method === "node_info"
          ? { pubkey: "02empty", peers_count: "0x0", channel_count: "0x0" }
          : payload.method === "list_peers"
            ? { peers: [] }
            : { channels: [] }
      });
    }) as typeof fetch;
    const probe = await probeFiberRpcReadiness({
      url: "http://127.0.0.1:21714",
      role: "payer",
      fetchImpl
    });
    expect(probe.ok).toBe(false);
    expect(probe.blockers).toContain("payer Fiber node has no connected peers; connect it to a local or testnet Fiber peer");
    expect(probe.blockers).toContain("payer Fiber node has no channels; open and fund a channel before live Fiber Paid HTTP payments");
  });
});

function fiberProbeResult(method: string): unknown {
  if (method === "node_info") {
    return {
      version: "0.9.0-rc4",
      commit_hash: "fiber-test",
      pubkey: "02ready",
      peers_count: "0x1",
      channel_count: "0x1"
    };
  }
  if (method === "list_peers") {
    return { peers: [{ pubkey: "03peer", address: "/ip4/127.0.0.1/tcp/8228" }] };
  }
  if (method === "list_channels") {
    return {
      channels: [
        {
          channel_id: `0x${"ab".repeat(32)}`,
          state: { state_name: "ChannelReady" },
          local_balance: "0x64",
          remote_balance: "0x0"
        }
      ]
    };
  }
  throw new Error(`Unexpected probe method ${method}`);
}
