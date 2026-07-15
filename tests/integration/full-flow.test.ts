import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationPaymentHeader,
  decodeFiberChargeRequest,
  FiberPaidHttpError,
  parseWwwAuthenticatePaymentHeader,
  resourceHashFromRequest,
  type PaymentChallenge
} from "@fiber-paid-http/core";
import { paidFetch } from "@fiber-paid-http/client";
import { f402ChallengeToMpp, f402ProofToCredential } from "@fiber-paid-http/f402-compat";
import { createFiberPaidHttpMiddleware, createReverseProxyHandler } from "@fiber-paid-http/server-middleware";
import { createEvidenceApi } from "@fiber-paid-http/evidence-api";
import {
  createFiberFixtureAdapters,
  createSqliteTestStore,
  FIXTURE_INVOICE,
  FIXTURE_PAYMENT_HASH
} from "../helpers/fiber-fixture.js";

describe("Fiber Paid HTTP integration flows", () => {
  const evidenceSecret = "evidence-integration-secret-at-least-32-chars";
  afterEach(() => vi.useRealTimers());

  it("evidence paid endpoint completes full flow", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });
    const result = await paidFetch("http://localhost/paid/weather", {}, {
      fetchImpl: appFetch(app),
      fiber: payerFiber,
      authorizePayment: ({ charge }) => charge.amount === "10" && charge.currency.toLowerCase() === "ckb"
    });
    expect(result.response.status).toBe(200);
    expect(result.receipt).toMatchObject({ status: "success", method: "fiber", reference: FIXTURE_PAYMENT_HASH });
  });

  it("never pays without explicit client authorization", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });
    const payCharge = vi.spyOn(payerFiber, "payCharge");

    await expect(paidFetch("http://localhost/paid/weather", {}, {
      fetchImpl: appFetch(app),
      fiber: payerFiber
    })).rejects.toMatchObject({ code: "payment-authorization-required", status: 403 });
    expect(payCharge).not.toHaveBeenCalled();
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
        amountShannons: "100",
        payerProfileId: "env-payer",
        payeeProfileId: "env-payee",
        gatewayProfileId: "env-gateway"
      })
    });
    expect(unpaid.status).toBe(200);
    const unpaidBody = await unpaid.json() as {
      fiberChallenge: { request: { amount: string; currency: string } };
      body: { status: number; title: string };
      flow: {
        resourceHash: string;
        resource: { charge: { amount: string; currency: string; display: string } };
        profileSelection: { payer: string; payee: string; gateway: string };
        events: Array<{ detail?: string }>;
      };
    };
    expect(unpaidBody.body).toMatchObject({ status: 402, title: "Payment Required" });
    expect(unpaidBody.fiberChallenge.request.amount).toBe("100");
    expect(unpaidBody.flow.resourceHash).toBe(await resourceHashFromRequest(new Request("http://localhost/paid/weather")));
    expect(unpaidBody.flow.resource.charge).toEqual({ amount: "100", currency: "ckb", display: "0.000001 CKB" });
    expect(unpaidBody.flow.profileSelection).toEqual({ payer: "env-payer", payee: "env-payee", gateway: "env-gateway" });
    expect(JSON.stringify(unpaidBody.flow.events)).toContain("charge=100 shannons (0.000001 CKB)");

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
        amountShannons: "100",
        payerProfileId: "env-payer",
        payeeProfileId: "env-payee",
        gatewayProfileId: "env-gateway"
      })
    });
    expect(unpaidAgain.status).toBe(200);

    const pay = await app.request("http://localhost/api/evidence/pay", { method: "POST" });
    expect(pay.status).toBe(200);
    const continuation = await app.request("http://localhost/api/evidence/continue", { method: "POST" });
    expect(continuation.status).toBe(200);
    const replay = await app.request("http://localhost/api/evidence/replay", { method: "POST" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ rejected: true, receiptReissued: false });

    const exported = await app.request("http://localhost/api/evidence/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", amountShannons: "100" })
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
        receiptReference?: string;
        challengeId?: string;
      };
      endpoints: Array<{ path: string; charge: { amount: string; currency: string; display: string } }>;
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
    expect(statusBody.endpoints.map((endpoint) => endpoint.charge.currency)).toEqual(["ckb", "ckb", "ckb", "ckb"]);
    expect(statusBody.endpoints.map((endpoint) => endpoint.charge.amount)).toEqual(["100", "10", "50", "25"]);
    expect(statusBody.endpoints.map((endpoint) => endpoint.charge.display)).toEqual([
      "0.000001 CKB",
      "0.0000001 CKB",
      "0.0000005 CKB",
      "0.00000025 CKB"
    ]);
    expect(statusBody.badges.productionReady).toBe(statusBody.productionEvidence.productionReady);
    expect(statusBody.badges.gateReady).toBe(statusBody.productionEvidence.gateReady);
    if (statusBody.productionEvidence.productionReady) {
      expect(statusBody.productionEvidence.paymentHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(statusBody.productionEvidence.receiptReference).toBe(statusBody.productionEvidence.paymentHash);
      expect(statusBody.productionEvidence.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
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
      body: JSON.stringify({ endpoint: "/paid/protocol-service", amountShannons: "100" })
    });
    expect(unpaid.status).toBe(503);
    const unpaidBody = (await unpaid.clone().json()) as { status: number; flow: { events: Array<{ detail?: string }> } };
    expect(unpaidBody).toMatchObject({ status: 503 });
    expect(JSON.stringify(unpaidBody.flow.events)).toContain("charge=100 shannons (0.000001 CKB)");
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

    const prematureContinuation = await app.request("http://localhost/api/evidence/continue", { method: "POST" });
    expect(prematureContinuation.status).toBe(409);
    expect(await prematureContinuation.json()).toMatchObject({
      error: "invalid-evidence-state",
      message: "Pay with Fiber before continuing with or replaying the credential"
    });

    const compatibilityRetry = await app.request("http://localhost/api/evidence/retry", { method: "POST" });
    expect(compatibilityRetry.status).toBe(409);
    expect(await compatibilityRetry.json()).toMatchObject({ error: "invalid-evidence-state" });

    const prematureReplay = await app.request("http://localhost/api/evidence/replay", { method: "POST" });
    expect(prematureReplay.status).toBe(409);
    expect(await prematureReplay.json()).toMatchObject({
      error: "invalid-evidence-state",
      message: "Pay with Fiber before continuing with or replaying the credential"
    });

    const unpaid = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", amountShannons: "10" })
    });
    expect(unpaid.status).toBe(200);

    const continueBeforePayment = await app.request("http://localhost/api/evidence/continue", { method: "POST" });
    expect(continueBeforePayment.status).toBe(409);
    const continueBody = await continueBeforePayment.json() as { flow: { events: Array<{ message: string; detail?: string }> } };
    expect(continueBody.flow.events.at(-1)).toMatchObject({
      message: "credential continuation blocked",
      detail: "Pay with Fiber before continuing with or replaying the credential"
    });

    const pay = await app.request("http://localhost/api/evidence/pay", { method: "POST" });
    expect(pay.status).toBe(200);

    const replayBeforeReceipt = await app.request("http://localhost/api/evidence/replay", { method: "POST" });
    expect(replayBeforeReceipt.status).toBe(409);
    expect(await replayBeforeReceipt.json()).toMatchObject({
      error: "invalid-evidence-state",
      message: "Complete the authenticated request and receive Payment-Receipt before testing replay protection"
    });

    const continuation = await app.request("http://localhost/api/evidence/continue", { method: "POST" });
    expect(continuation.status).toBe(200);
    const continuationBodyAfterSuccess = await continuation.json() as { flow: { events: Array<{ actor: string; message: string }> } };
    expect(continuationBodyAfterSuccess.flow.events.slice(-4).map((event) => [event.actor, event.message])).toEqual([
      ["client", "continue with Authorization: Payment"],
      ["server", "payment verified"],
      ["protected-service", "service executed"],
      ["server", "Payment-Receipt returned"]
    ]);

    const replay = await app.request("http://localhost/api/evidence/replay", { method: "POST" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ rejected: true, receiptReissued: false });
  });

  it("evidence console API returns the payer Fiber failure and records it in the active flow", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    Object.defineProperty(payerFiber, "payCharge", {
      value: async () => {
        throw new FiberPaidHttpError(
          "fiber-rpc-error",
          "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient, required amount: 100",
          502
        );
      }
    });
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });

    const unpaid = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/protocol-service", amountShannons: "100" })
    });
    expect(unpaid.status).toBe(200);

    const pay = await app.request("http://localhost/api/evidence/pay", { method: "POST" });
    expect(pay.status).toBe(502);
    const body = await pay.json() as {
      error: string;
      message: string;
      flow: { events: Array<{ level: string; actor: string; message: string; detail?: string }> };
    };
    expect(body).toMatchObject({
      error: "fiber-rpc-error",
      message: expect.stringContaining("max outbound liquidity 0")
    });
    expect(body.flow.events.at(-1)).toMatchObject({
      level: "ERROR",
      actor: "node1 (payer)",
      message: "send_payment failed",
      detail: expect.stringContaining("Insufficient balance")
    });
  });

  it("rejects the removed display-unit charge input before invoice creation", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({ fiber: payeeFiber, payerFiber, store: createSqliteTestStore(), secret: evidenceSecret });

    const response = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/weather", amountCkb: "1" })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid-evidence-parameters",
      message: "amountCkb is derived output; send amountShannons only"
    });
  });

  it("evidence console API supports UI runtime bootstrap without exporting secrets", async () => {
    const app = withoutFiberLiveEnv(() => createEvidenceApi({ store: createSqliteTestStore() }));
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
      body: JSON.stringify({ endpoint: "/paid/weather", amountShannons: "10" })
    });
    expect(unpaidA.status).toBe(200);

    const unpaidB = await app.request("http://localhost/api/evidence/unpaid", {
      method: "POST",
      headers: sessionB,
      body: JSON.stringify({ endpoint: "/paid/file", amountShannons: "25" })
    });
    expect(unpaidB.status).toBe(200);

    const statusA = await app.request("http://localhost/api/status", { headers: { "x-fiber-paid-http-session": "session-a" } });
    const statusB = await app.request("http://localhost/api/status", { headers: { "x-fiber-paid-http-session": "session-b" } });
    expect((await statusA.json() as { flow: { endpoint: string } }).flow.endpoint).toBe("/paid/weather");
    expect((await statusB.json() as { flow: { endpoint: string } }).flow.endpoint).toBe("/paid/file");

    const payA = await app.request("http://localhost/api/evidence/pay", { method: "POST", headers: { "x-fiber-paid-http-session": "session-a" } });
    expect(payA.status).toBe(200);
    const continuationA = await app.request("http://localhost/api/evidence/continue", { method: "POST", headers: { "x-fiber-paid-http-session": "session-a" } });
    expect(continuationA.status).toBe(200);
    expect(await continuationA.text()).toContain("Shanghai");

    const payB = await app.request("http://localhost/api/evidence/pay", { method: "POST", headers: { "x-fiber-paid-http-session": "session-b" } });
    expect(payB.status).toBe(200);
    const continuationB = await app.request("http://localhost/api/evidence/continue", { method: "POST", headers: { "x-fiber-paid-http-session": "session-b" } });
    expect(continuationB.status).toBe(200);
    expect(await continuationB.text()).toContain("paid file contents");
  });

  it("reverse proxy completes full flow", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const middleware = createFiberPaidHttpMiddleware({
      secret: "reverse-proxy-secret-at-least-16",
      realm: "proxy.example.test",
      serverId: "reverse-proxy",
      publicBaseUrl: "https://proxy.example.test",
      store: createSqliteTestStore(),
      fiber: payeeFiber
    });
    const proxy = createReverseProxyHandler(middleware, {
      upstream: "http://upstream.local",
      charge: { amount: "1000", currency: "ckb" },
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return Response.json({
          upstream: new URL(request.url).pathname,
          authForwarded: request.headers.has("authorization"),
          nominatedForwarded: request.headers.has("x-remove")
        }, {
          headers: {
            connection: "x-response-remove",
            "x-response-remove": "must-not-reach-client"
          }
        });
      }
    });
    const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return proxy(request);
    }) as typeof fetch;
    const result = await paidFetch("http://proxy.local/paid/data", {
      headers: { connection: "x-remove", "x-remove": "must-not-reach-upstream" }
    }, {
      fetchImpl: proxyFetch,
      fiber: payerFiber,
      authorizePayment: ({ charge }) => charge.amount === "1000" && charge.currency === "ckb"
    });
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ upstream: "/paid/data", authForwarded: false, nominatedForwarded: false });
    expect(result.response.headers.has("x-response-remove")).toBe(false);
  });

  it("fails closed without a receipt when an upstream response exceeds its limit", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const middleware = createFiberPaidHttpMiddleware({
      secret: "response-limit-secret-at-least-32-chars",
      realm: "proxy.example.test",
      serverId: "response-limit-proxy",
      publicBaseUrl: "https://proxy.example.test",
      store: createSqliteTestStore(),
      fiber: payeeFiber
    });
    const proxy = createReverseProxyHandler(middleware, {
      upstream: "http://upstream.local",
      charge: { amount: "1000", currency: "ckb" },
      upstreamResponseLimitBytes: 1024,
      fetchImpl: async () => new Response("x".repeat(1025), {
        headers: { "content-length": "1025" }
      })
    });
    const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return proxy(request);
    }) as typeof fetch;

    const result = await paidFetch("http://proxy.local/paid/data", {}, {
      fetchImpl: proxyFetch,
      fiber: payerFiber,
      authorizePayment: () => true
    });
    expect(result.response.status).toBe(502);
    expect(result.response.headers.has("payment-receipt")).toBe(false);
    expect(result.receipt).toBeUndefined();
  });

  it("F402 compatibility credential can redeem an MPP route", async () => {
    const { payeeFiber } = createFiberFixtureAdapters();
    const store = createSqliteTestStore();
    const secret = "f402-flow-secret-at-least-32-characters";
    const middleware = createFiberPaidHttpMiddleware({
      secret,
      realm: "f402.example.test",
      serverId: "f402-flow",
      publicBaseUrl: "http://localhost",
      allowInsecureHttp: true,
      store,
      fiber: payeeFiber
    });
    const url = "http://localhost/paid/weather";
    const resource = { method: "GET", url };
    const challenge = f402ChallengeToMpp({
      f402: {
        token: "v1.aaa.bbb",
        invoice: FIXTURE_INVOICE,
        paymentHash: FIXTURE_PAYMENT_HASH,
        amount: "1000",
        currency: "CKB",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        network: "dev",
        hashAlgorithm: "ckb_hash"
      },
      resource,
      realm: "f402.example.test",
      secret
    });
    await store.saveChallenge({
      challenge,
      chargeRequest: decodeFiberChargeRequest(challenge.request),
      resourceBinding: resource,
      createdAt: new Date().toISOString(),
      expiresAt: challenge.expires!
    });
    const credential = f402ProofToCredential({
      challenge,
      proof: {
        token: "v1.aaa.bbb",
        paymentHash: FIXTURE_PAYMENT_HASH
      }
    });
    const handler = middleware.protect({
      charge: { amount: "1000", currency: "ckb" },
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
    const challenge = challengeFromResponse(first);
    const charge = decodeFiberChargeRequest(challenge.request);
    const payload = await payerFiber.payCharge(charge);
    const credential = {
      challenge,
      payload
    };
    const auth = buildAuthorizationPaymentHeader(credential);
    expect((await app.request("http://localhost/paid/file", { headers: { authorization: auth } })).status).toBe(402);
    expect((await app.request("http://localhost/paid/weather", { headers: { authorization: auth } })).status).toBe(200);
    expect((await app.request("http://localhost/paid/weather", { headers: { authorization: auth } })).status).toBe(402);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const expiredAdapters = createFiberFixtureAdapters();
    const expired = createEvidenceApi({
      fiber: expiredAdapters.payeeFiber,
      payerFiber: expiredAdapters.payerFiber,
      store: createSqliteTestStore(),
      secret: evidenceSecret,
      challengeTtlSeconds: 1,
      clockSkewSeconds: 0
    });
    const expiredFirst = await expired.request("http://localhost/paid/weather");
    const expiredChallenge = challengeFromResponse(expiredFirst);
    const expiredPayload = await expiredAdapters.payerFiber.payCharge(decodeFiberChargeRequest(expiredChallenge.request));
    const expiredAuth = buildAuthorizationPaymentHeader({
      challenge: expiredChallenge,
      payload: expiredPayload
    });
    vi.setSystemTime(new Date("2026-07-13T00:00:02.000Z"));
    expect((await expired.request("http://localhost/paid/weather", { headers: { authorization: expiredAuth } })).status).toBe(402);
  });
});

function challengeFromResponse(response: Response): PaymentChallenge {
  const challenge = parseWwwAuthenticatePaymentHeader(response.headers.get("www-authenticate"));
  if (!challenge) throw new Error("missing standard Payment challenge");
  return challenge;
}

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
