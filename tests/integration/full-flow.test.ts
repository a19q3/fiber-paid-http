import { describe, expect, it } from "vitest";
import {
  buildAuthorizationPaymentHeader,
  resourceHash,
  resourceHashFromRequest,
  signChallenge,
  type FiberMethodChallenge
} from "@fiber-paid-http/core";
import { paidFetch } from "@fiber-paid-http/client";
import { f402ChallengeToMpp, f402ProofToCredential } from "@fiber-paid-http/f402-compat";
import { createFiberPaidHttpMiddleware, createReverseProxyHandler } from "@fiber-paid-http/server-middleware";
import { createEvidenceApi } from "@fiber-paid-http/evidence-api";
import {
  createFiberFixtureAdapters,
  createSqliteTestStore,
  FIXTURE_PAYMENT_HASH
} from "../helpers/fiber-fixture.js";

describe("Fiber Paid HTTP integration flows", () => {
  const evidenceSecret = "evidence-integration-secret-at-least-32-chars";

  it("evidence paid endpoint completes full flow", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });
    const result = await paidFetch("http://localhost/paid/weather", {}, { fetchImpl: appFetch(app), fiber: payerFiber });
    expect(result.response.status).toBe(200);
    expect(result.receipt?.settlement.status).toBe("settled");
  });

  it("evidence console API exposes liveness and readiness probes", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi());

    const health = await app.request("http://localhost/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    const healthBody = await health.json() as {
      ok: boolean;
      service: string;
      status: string;
      generatedAt: string;
    };
    expect(healthBody).toMatchObject({
      ok: true,
      service: "fiber-paid-http-evidence-api",
      status: "healthy"
    });
    expect(Date.parse(healthBody.generatedAt)).not.toBeNaN();

    const readiness = await app.request("http://localhost/readyz");
    expect(readiness.status).toBe(503);
    expect(readiness.headers.get("cache-control")).toBe("no-store");
    const readinessBody = await readiness.json() as {
      ok: boolean;
      service: string;
      status: string;
      livePaymentEnabled: boolean;
      mode: string;
      source: string;
      roles: Array<{ role: string; status: string; source: string; blockers: string[] }>;
      blockers: string[];
      generatedAt: string;
    };
    expect(readinessBody).toMatchObject({
      ok: false,
      service: "fiber-paid-http-evidence-api",
      status: "blocked",
      livePaymentEnabled: false,
      mode: "unconfigured",
      source: "env"
    });
    expect(readinessBody.roles.map((role) => role.role)).toEqual(["payer", "payee", "gateway"]);
    expect(readinessBody.roles.every((role) => role.status !== "ready")).toBe(true);
    expect(readinessBody.blockers.join(" ")).toContain("RUN_FIBER_E2E=1");
    expect(readinessBody.blockers.join(" ")).toContain("FIBER_PAYEE_RPC_URL");
    expect(Date.parse(readinessBody.generatedAt)).not.toBeNaN();
  });

  it("evidence console API binds run parameters and profile selection", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });

    const configuration = await app.request("http://localhost/api/configuration");
    expect(configuration.status).toBe(200);
    const configurationBody = await configuration.json() as {
      currency: string;
      profiles: { payer: Array<{ id: string }>; payee: Array<{ id: string }>; gateway: Array<{ id: string }> };
      executionRoleCapabilities: {
        payer: { canSendPayment: boolean; canCreateInvoice: boolean; canProtectResource: boolean; liveExecution: boolean };
        payee: { canSendPayment: boolean; canCreateInvoice: boolean; canInspectSettlement: boolean; liveExecution: boolean };
        gateway: { canSendPayment: boolean; canCreateInvoice: boolean; canProtectResource: boolean; canIssueReceipt: boolean; liveExecution: boolean };
      };
      parameters: { amountLimits: { minShannons: string } };
      envTemplate: string;
    };
    expect(configurationBody.currency).toBe("CKB");
    expect(configurationBody.profiles.payer[0]?.id).toBe("env-payer");
    expect(configurationBody.profiles.payee[0]?.id).toBe("env-payee");
    expect(configurationBody.profiles.gateway[0]?.id).toBe("env-gateway");
    expect(configurationBody.executionRoleCapabilities.payer).toMatchObject({
      canSendPayment: true,
      canCreateInvoice: false,
      canProtectResource: false,
      liveExecution: true
    });
    expect(configurationBody.executionRoleCapabilities.payee).toMatchObject({
      canSendPayment: false,
      canCreateInvoice: true,
      canInspectSettlement: true,
      liveExecution: true
    });
    expect(configurationBody.executionRoleCapabilities.gateway).toMatchObject({
      canSendPayment: false,
      canCreateInvoice: false,
      canProtectResource: true,
      canIssueReceipt: true,
      liveExecution: true
    });
    expect(configurationBody.parameters.amountLimits.minShannons).toBe("1");
    expect(configurationBody.envTemplate).toContain("FIBER_E2E_AMOUNT_SHANNONS=");

    const canonicalReport = await app.request("http://localhost/api/reports/canonical");
    expect(canonicalReport.status).toBe(200);
    expect(await canonicalReport.json()).toMatchObject({
      exists: true,
      path: "reports/canonical-core-parity.json"
    });

    const unpaid = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "/paid/weather",
        amountCkb: "0.000001",
        amountShannons: "100",
        payerProfileId: "env-payer",
        payeeProfileId: "env-payee",
        gatewayProfileId: "env-gateway"
      })
    });
    expect(unpaid.status).toBe(200);
    const unpaidBody = await unpaid.json() as {
      fiberChallenge: { amountShannons?: string };
      body: { challenge: { amount: { value: string; currency: string; display?: string } } };
      flow: {
        resourceHash: string;
        resource: { price: { display?: string }; fiberAmountShannons: string };
        profileSelection: { payer: string; payee: string; gateway: string };
        events: Array<{ detail?: string }>;
      };
    };
    expect(unpaidBody.body.challenge.amount).toEqual({ value: "0.000001", currency: "CKB", display: "0.000001 CKB" });
    expect(unpaidBody.fiberChallenge.amountShannons).toBe("100");
    expect(unpaidBody.flow.resourceHash).toBe(await resourceHashFromRequest(new Request("http://localhost/paid/weather")));
    expect(unpaidBody.flow.resource.price.display).toBe("0.000001 CKB");
    expect(unpaidBody.flow.resource.fiberAmountShannons).toBe("100");
    expect(unpaidBody.flow.profileSelection).toEqual({ payer: "env-payer", payee: "env-payee", gateway: "env-gateway" });
    expect(JSON.stringify(unpaidBody.flow.events)).toContain("fiber_amount_shannons=100");

    const nonExecutableProfile = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", payerProfileId: "testnet-payer-evidence" })
    });
    expect(nonExecutableProfile.status).toBe(400);
    expect(await nonExecutableProfile.json()).toMatchObject({ error: "invalid-evidence-parameters" });

    const unknownEnvProfile = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", payerProfileId: "env-other-wallet" })
    });
    expect(unknownEnvProfile.status).toBe(400);
    expect(await unknownEnvProfile.json()).toMatchObject({ error: "invalid-evidence-parameters" });

    const unpaidAgain = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "/paid/weather",
        amountCkb: "0.000001",
        amountShannons: "100",
        payerProfileId: "env-payer",
        payeeProfileId: "env-payee",
        gatewayProfileId: "env-gateway"
      })
    });
    expect(unpaidAgain.status).toBe(200);

    const pay = await app.request("http://localhost/api/evidence/pay", { method: "POST" });
    expect(pay.status).toBe(200);
    const retry = await app.request("http://localhost/api/evidence/retry", { method: "POST" });
    expect(retry.status).toBe(200);
    const replay = await app.request("http://localhost/api/evidence/replay", { method: "POST" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ rejected: true, receiptReissued: false });

    const exported = await app.request("http://localhost/api/evidence/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", amountCkb: "0.000001", amountShannons: "100" })
    });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({
      requestedRun: {
        endpoint: "/paid/weather",
        parameters: { amountCkb: "0.000001", amountShannons: "100" }
      },
      safety: { secretsExposed: false }
    });
  });

  it("evidence console API blocks payment execution when live Fiber is not configured", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi());
    const status = await app.request("http://localhost/api/status");
    expect(status.status).toBe(200);
    const statusBody = await status.json() as {
      badges: { productionReady: boolean; gateReady: boolean };
      productionEvidence: {
        productionReady: boolean;
        gateReady: boolean;
        conflicts: string[];
        paymentHash?: string;
        receiptId?: string;
      };
      endpoints: Array<{ path: string; price: { currency: string; display?: string } }>;
      localFiberNetwork: {
        node1: { status: string };
        node2: { status: string };
        node3: { status: string };
        channelCount: number | null;
        channelCountSource: string;
        routeSource: string;
      };
    };
    expect(statusBody.endpoints[0]?.path).toBe("/paid/protocol-service");
    expect(statusBody.endpoints.map((endpoint) => endpoint.price.currency)).toEqual(["CKB", "CKB", "CKB", "CKB"]);
    expect(statusBody.endpoints.map((endpoint) => endpoint.price.display)).toEqual(["100 CKB", "10 CKB", "50 CKB", "25 CKB"]);
    expect(statusBody.badges.productionReady).toBe(true);
    expect(statusBody.badges.gateReady).toBe(true);
    expect(statusBody.productionEvidence.productionReady).toBe(true);
    expect(statusBody.productionEvidence.gateReady).toBe(true);
    expect(statusBody.productionEvidence.paymentHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(statusBody.productionEvidence.receiptId).toMatch(/^rcpt_[a-z0-9]+$/i);
    expect(statusBody.productionEvidence.conflicts.join(" ")).not.toContain("production-bootstrap-e2e.json=false");
    expect(JSON.stringify(statusBody)).not.toContain("robot");
    expect(new Set([
      statusBody.localFiberNetwork.node1.status,
      statusBody.localFiberNetwork.node2.status,
      statusBody.localFiberNetwork.node3.status
    ])).not.toContain("online");
    expect(statusBody.localFiberNetwork.channelCountSource).not.toBe("live");
    expect(statusBody.localFiberNetwork.routeSource).not.toBe("live");

    const bootstrap = await app.request("http://localhost/api/bootstrap");
    expect(bootstrap.status).toBe(200);
    const bootstrapBody = await bootstrap.json() as {
      liveReady: boolean;
      roles: Array<{ role: string; status: string; checks: Array<{ id: string; source: string }>; blockers: string[] }>;
    };
    expect(bootstrapBody.liveReady).toBe(false);
    expect(bootstrapBody.roles.map((role) => role.role)).toEqual(["payer", "payee", "gateway"]);
    expect(bootstrapBody.roles.every((role) => role.status !== "ready")).toBe(true);
    expect(bootstrapBody.roles.flatMap((role) => role.checks).some((check) => check.source === "env")).toBe(true);
    expect(bootstrapBody.roles.flatMap((role) => role.blockers).join(" ")).toContain("FIBER_MODE");

    const configuration = await app.request("http://localhost/api/configuration");
    expect(configuration.status).toBe(200);
    const configurationBody = await configuration.json() as {
      profiles: { payer: Array<{ status: string; custody: string }>; gateway: Array<{ status: string; custody: string }> };
      warnings: string[];
    };
    expect(configurationBody.profiles.payer[0]).toMatchObject({ custody: "fnn-built-in-wallet" });
    expect(configurationBody.profiles.gateway[0]).toMatchObject({ custody: "rust-gateway" });
    expect(configurationBody.warnings.join(" ")).toContain("Only env-payer, env-payee, and env-gateway are executable");

    const unpaid = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/protocol-service", amountCkb: "1", amountShannons: "100" })
    });
    expect(unpaid.status).toBe(503);
    const unpaidBody = (await unpaid.clone().json()) as { status: number; flow: { events: Array<{ detail?: string }> } };
    expect(unpaidBody).toMatchObject({ status: 503 });
    expect(JSON.stringify(unpaidBody.flow.events)).toContain("amount=1 CKB");
    expect(JSON.stringify(unpaidBody.flow.events)).toContain("fiber_amount_shannons=100");
    expect(JSON.stringify(unpaidBody.flow.events)).not.toContain("Fibd");

    const pay = await app.request("http://localhost/api/evidence/pay", { method: "POST" });
    expect(pay.status).toBe(503);
    const payBody = await pay.json() as { flow: { events: Array<{ actor: string; message: string; detail?: string }> } };
    const payEvents = JSON.stringify(payBody.flow.events);
    expect(payEvents).toContain("live Fiber not configured");
    expect(payEvents).not.toContain("node2 (router)");
    expect(payEvents).not.toContain("node3 (payee)");

    const reset = await app.request("http://localhost/api/evidence/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ ok: true, flow: { events: [] } });
  });

  it("evidence console API returns structured state errors for out-of-order actions", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });

    const prematurePay = await app.request("http://localhost/api/evidence/pay", { method: "POST" });
    expect(prematurePay.status).toBe(409);
    expect(await prematurePay.json()).toMatchObject({
      error: "invalid-evidence-state",
      message: "Send unpaid request before paying with Fiber"
    });

    const prematureRetry = await app.request("http://localhost/api/evidence/retry", { method: "POST" });
    expect(prematureRetry.status).toBe(409);
    expect(await prematureRetry.json()).toMatchObject({
      error: "invalid-evidence-state",
      message: "Pay with Fiber before retrying or replaying the credential"
    });

    const prematureReplay = await app.request("http://localhost/api/evidence/replay", { method: "POST" });
    expect(prematureReplay.status).toBe(409);
    expect(await prematureReplay.json()).toMatchObject({
      error: "invalid-evidence-state",
      message: "Pay with Fiber before retrying or replaying the credential"
    });

    const unpaid = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", amountCkb: "10", amountShannons: "10" })
    });
    expect(unpaid.status).toBe(200);

    const retryBeforePayment = await app.request("http://localhost/api/evidence/retry", { method: "POST" });
    expect(retryBeforePayment.status).toBe(409);
    const retryBody = await retryBeforePayment.json() as { flow: { events: Array<{ message: string; detail?: string }> } };
    expect(retryBody.flow.events.at(-1)).toMatchObject({
      message: "retry blocked",
      detail: "Pay with Fiber before retrying or replaying the credential"
    });
  });

  it("evidence console API supports UI runtime bootstrap without exporting secrets", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi());
    const configured = await app.request("http://localhost/api/bootstrap/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmRuntimeBootstrap: true,
        mode: "local",
        payerRpcUrl: "http://127.0.0.1:1",
        payeeRpcUrl: "http://127.0.0.1:2",
        routerRpcUrl: "http://127.0.0.1:3",
        payerRpcAuth: "payer-secret-token",
        payeeRpcAuth: "payee-secret-token",
        currency: "CKB",
        amountShannons: "100",
        generateRuntimeSecret: true
      })
    });
    expect(configured.status).toBe(200);
    const configuredBody = await configured.json() as {
      runtimeBootstrap: {
        configured: boolean;
        source: string;
        secret: string;
        auth: { payer: string; payee: string };
      };
      configuration: {
        profiles: {
          payer: Array<{ id: string; source: string; endpoint?: string }>;
          payee: Array<{ id: string; source: string; endpoint?: string }>;
          gateway: Array<{ id: string; source: string }>;
        };
        defaults: { payerProfileId: string; payeeProfileId: string; gatewayProfileId: string };
      };
    };
    expect(configuredBody.runtimeBootstrap).toMatchObject({
      configured: true,
      source: "runtime",
      secret: "runtime-generated",
      auth: { payer: "present", payee: "present" }
    });
    expect(configuredBody.configuration.defaults).toMatchObject({
      payerProfileId: "runtime-payer",
      payeeProfileId: "runtime-payee",
      gatewayProfileId: "runtime-gateway"
    });
    expect(configuredBody.configuration.profiles.payer[0]).toMatchObject({
      id: "runtime-payer",
      source: "runtime",
      endpoint: "http://127.0.0.1:1"
    });
    expect(configuredBody.configuration.profiles.payee[0]).toMatchObject({
      id: "runtime-payee",
      source: "runtime",
      endpoint: "http://127.0.0.1:2"
    });
    expect(JSON.stringify(configuredBody)).not.toContain("payer-secret-token");
    expect(JSON.stringify(configuredBody)).not.toContain("payee-secret-token");

    const readiness = await app.request("http://localhost/readyz");
    expect(readiness.status).toBe(503);
    const readinessBody = await readiness.json() as {
      ok: boolean;
      livePaymentEnabled: boolean;
      source: string;
      roles: Array<{ role: string; status: string; source: string; blockers: string[] }>;
      blockers: string[];
    };
    expect(readinessBody.ok).toBe(false);
    expect(readinessBody.livePaymentEnabled).toBe(false);
    expect(readinessBody.source).toBe("runtime");
    expect(readinessBody.roles.map((role) => [role.role, role.source])).toEqual([
      ["payer", "runtime"],
      ["payee", "runtime"],
      ["gateway", "runtime"]
    ]);
    expect(readinessBody.blockers.join(" ")).toContain("Fiber RPC node_info failed");
    expect(readinessBody.blockers.join(" ")).not.toContain("payer-secret-token");
    expect(readinessBody.blockers.join(" ")).not.toContain("payee-secret-token");

    const configuration = await app.request("http://localhost/api/configuration");
    expect(configuration.status).toBe(200);
    const configurationBody = await configuration.json() as { runtimeBootstrap: { source: string }; defaults: { payerProfileId: string } };
    expect(configurationBody.runtimeBootstrap.source).toBe("runtime");
    expect(configurationBody.defaults.payerProfileId).toBe("runtime-payer");

    const reset = await app.request("http://localhost/api/bootstrap/runtime/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json() as {
      runtimeBootstrap: { source: string; configured: boolean };
      configuration: { defaults: { payerProfileId: string } };
    };
    expect(resetBody.runtimeBootstrap.source).toBe("unconfigured");
    expect(resetBody.runtimeBootstrap.configured).toBe(false);
    expect(resetBody.configuration.defaults.payerProfileId).toBe("env-payer");
  });

  it("evidence console API requires explicit local confirmation for UI runtime bootstrap", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi());
    const missingConfirmation = await app.request("http://localhost/api/bootstrap/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "local",
        payerRpcUrl: "http://127.0.0.1:21714",
        payeeRpcUrl: "http://127.0.0.1:21716",
        generateRuntimeSecret: true
      })
    });
    expect(missingConfirmation.status).toBe(403);
    expect(await missingConfirmation.json()).toMatchObject({ error: "runtime-bootstrap-disabled" });

    const remoteOrigin = await app.request("http://localhost/api/bootstrap/runtime", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({
        confirmRuntimeBootstrap: true,
        mode: "local",
        payerRpcUrl: "http://127.0.0.1:21714",
        payeeRpcUrl: "http://127.0.0.1:21716",
        generateRuntimeSecret: true
      })
    });
    expect(remoteOrigin.status).toBe(403);
    expect(await remoteOrigin.json()).toMatchObject({ error: "runtime-bootstrap-disabled" });
  });

  it("evidence console API allows the browser session header from served local console origins", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi());

    const preflight = await app.request("http://localhost/api/status", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:8788",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-fiber-paid-http-session"
      }
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8788");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-fiber-paid-http-session");
  });

  it("evidence console API rejects file origins unless explicitly enabled", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi());

    await withTemporaryEnv({ FIBER_PAID_HTTP_ALLOW_FILE_ORIGIN: undefined }, async () => {
      const blocked = await app.request("http://localhost/api/status", {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-fiber-paid-http-session"
        }
      });
      expect(blocked.status).toBe(403);
      expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
    });

    await withTemporaryEnv({ FIBER_PAID_HTTP_ALLOW_FILE_ORIGIN: "1" }, async () => {
      const allowed = await app.request("http://localhost/api/status", {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-fiber-paid-http-session"
        }
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("null");
    });
  });

  it("evidence console API isolates flow state per browser session", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });
    const sessionA = { "content-type": "application/json", "x-fiber-paid-http-session": "session-a" };
    const sessionB = { "content-type": "application/json", "x-fiber-paid-http-session": "session-b" };

    const unpaidA = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: sessionA,
      body: JSON.stringify({ endpoint: "/paid/weather", amountCkb: "10", amountShannons: "10" })
    });
    expect(unpaidA.status).toBe(200);

    const unpaidB = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: sessionB,
      body: JSON.stringify({ endpoint: "/paid/file", amountCkb: "25", amountShannons: "25" })
    });
    expect(unpaidB.status).toBe(200);

    const statusA = await app.request("http://localhost/api/status", { headers: { "x-fiber-paid-http-session": "session-a" } });
    const statusB = await app.request("http://localhost/api/status", { headers: { "x-fiber-paid-http-session": "session-b" } });
    expect((await statusA.json() as { flow: { endpoint: string } }).flow.endpoint).toBe("/paid/weather");
    expect((await statusB.json() as { flow: { endpoint: string } }).flow.endpoint).toBe("/paid/file");

    const payA = await app.request("http://localhost/api/evidence/pay", { method: "POST", headers: { "x-fiber-paid-http-session": "session-a" } });
    expect(payA.status).toBe(200);
    const retryA = await app.request("http://localhost/api/evidence/retry", { method: "POST", headers: { "x-fiber-paid-http-session": "session-a" } });
    expect(retryA.status).toBe(200);
    expect(await retryA.text()).toContain("Shanghai");

    const payB = await app.request("http://localhost/api/evidence/pay", { method: "POST", headers: { "x-fiber-paid-http-session": "session-b" } });
    expect(payB.status).toBe(200);
    const retryB = await app.request("http://localhost/api/evidence/retry", { method: "POST", headers: { "x-fiber-paid-http-session": "session-b" } });
    expect(retryB.status).toBe(200);
    expect(await retryB.text()).toContain("paid file contents");
  });

  it("reverse proxy completes full flow", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const middleware = createFiberPaidHttpMiddleware({
      secret: "reverse-proxy-secret-at-least-16",
      serverId: "reverse-proxy",
      store: createSqliteTestStore(),
      fiber: payeeFiber
    });
    const proxy = createReverseProxyHandler(middleware, {
      upstream: "http://upstream.local",
      price: { value: "1", currency: "CKB" },
      methods: ["fiber"],
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return Response.json({
          upstream: new URL(request.url).pathname,
          authForwarded: request.headers.has("authorization")
        });
      }
    });
    const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return proxy(request);
    }) as typeof fetch;
    const result = await paidFetch("http://proxy.local/paid/data", {}, { fetchImpl: proxyFetch, fiber: payerFiber });
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ upstream: "/paid/data", authForwarded: false });
  });

  it("F402 compatibility credential can redeem an MPP route", async () => {
    const { payeeFiber } = createFiberFixtureAdapters();
    const store = createSqliteTestStore();
    const secret = "f402-flow-secret-at-least-16";
    const middleware = createFiberPaidHttpMiddleware({
      secret,
      serverId: "f402-flow",
      store,
      fiber: payeeFiber
    });
    const url = "http://localhost/paid/weather";
    const resource = { method: "GET", url };
    const challenge = f402ChallengeToMpp({
      f402: {
        token: "v1.aaa.bbb",
        invoice: "fibd1qfixture",
        paymentHash: FIXTURE_PAYMENT_HASH,
        amount: "1000",
        currency: "CKB",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      resource,
      serverId: "f402-flow"
    });
    await store.saveChallenge({
      challenge,
      signature: signChallenge(challenge, secret),
      resourceHash: resourceHash(resource),
      createdAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt
    });
    const credential = f402ProofToCredential({
      challengeId: challenge.challengeId,
      resourceHash: resourceHash(resource),
      proof: {
        token: "v1.aaa.bbb",
        invoice: "fibd1qfixture",
        paymentHash: FIXTURE_PAYMENT_HASH,
        amountShannons: "1000",
        mode: "local",
        status: "settled"
      }
    });
    const handler = middleware.protect({
      price: { value: "1000", currency: "CKB" },
      methods: ["fiber"],
      handler: () => Response.json({ f402: true })
    });
    const response = await handler(new Request(url, { headers: { authorization: buildAuthorizationPaymentHeader(credential) } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ f402: true });
  });

  it("replay, wrong-resource, and expired challenge attacks are rejected", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({
      fiber: payeeFiber,
      payerFiber,
      store: createSqliteTestStore(),
      secret: evidenceSecret,
      challengeTtlSeconds: 120
    });
    const first = await app.request("http://localhost/paid/weather");
    const body = (await first.clone().json()) as {
      challengeId: string;
      challenge: { methods: FiberMethodChallenge[] };
    };
    const fiber = body.challenge.methods.find((method) => method.method === "fiber")!;
    const proof = await payerFiber.payChallenge(fiber);
    const credential = {
      domain: "fiber-paid-http-credential-v1" as const,
      challengeId: body.challengeId,
      method: "fiber" as const,
      resourceHash: await resourceHashFromRequest(new Request("http://localhost/paid/weather")),
      paymentProof: proof,
      submittedAt: new Date().toISOString()
    };
    const auth = buildAuthorizationPaymentHeader(credential);
    expect((await app.request("http://localhost/paid/file", { headers: { authorization: auth } })).status).toBe(402);
    expect((await app.request("http://localhost/paid/weather", { headers: { authorization: auth } })).status).toBe(200);
    expect((await app.request("http://localhost/paid/weather", { headers: { authorization: auth } })).status).toBe(402);

    const expiredAdapters = createFiberFixtureAdapters();
    const expired = createEvidenceApi({
      fiber: expiredAdapters.payeeFiber,
      payerFiber: expiredAdapters.payerFiber,
      store: createSqliteTestStore(),
      secret: evidenceSecret,
      challengeTtlSeconds: -5,
      clockSkewSeconds: 0
    });
    const expiredFirst = await expired.request("http://localhost/paid/weather");
    const expiredBody = (await expiredFirst.json()) as typeof body;
    const expiredFiber = expiredBody.challenge.methods.find((method) => method.method === "fiber")!;
    const expiredProof = await expiredAdapters.payerFiber.payChallenge(expiredFiber);
    const expiredAuth = buildAuthorizationPaymentHeader({
      ...credential,
      challengeId: expiredBody.challengeId,
      paymentProof: expiredProof,
      submittedAt: new Date().toISOString()
    });
    expect((await expired.request("http://localhost/paid/weather", { headers: { authorization: expiredAuth } })).status).toBe(402);
  });
});

function withoutFiberLiveEnv<T>(fn: () => T): T {
  const keys = [
    "RUN_FIBER_E2E",
    "FIBER_MODE",
    "FIBER_RPC_URL",
    "FIBER_PAYEE_RPC_URL",
    "FIBER_PAYER_RPC_URL",
    "FIBER_PAID_HTTP_SECRET"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withTemporaryEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function appFetch(app: ReturnType<typeof createEvidenceApi>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return app.request(request);
  }) as typeof fetch;
}
