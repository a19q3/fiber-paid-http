import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  PAYMENT_RECEIPT_HEADER,
  buildAuthorizationPaymentHeader,
  decodeReceipt,
  resourceHashFromRequest,
  type FiberMethodChallenge,
  type PaymentCredential,
  type PaymentReceipt
} from "@fiber-paid-http/core";
import { FiberMethodAdapter, FiberRpcClient, parseFiberMode } from "@fiber-paid-http/fiber-method";
import { createFiberPaidHttpMiddleware, type FiberPaidHttpMiddleware, type FiberPaidHttpMiddlewareConfig } from "@fiber-paid-http/server-middleware";
import { SqliteStore } from "@fiber-paid-http/storage";
import {
  appendBattlecodeTicket,
  assertBattlecodeFairnessCommitment,
  battlecodeEntryPrice,
  battlecodeStatus,
  battlecodeXudtTypeScript,
  buildBattlecodeFairnessManifest,
  createBattlecodeSubmission,
  findBattlecodeSubmission,
  issueBattlecodeTicket,
  normalizeBattlecodeRegistration,
  normalizeBattlecodeSubmission,
  runBattlecodeTournament,
  type BattlecodeRegistrationInput,
  type BattlecodeFairnessManifest,
  type BattlecodeSubmission,
  type BattlecodeTicket,
  type BattlecodeTournamentReport
} from "./battlecode.js";

const FLOW_SESSION_HEADER = "x-fiber-paid-http-session";
const CORS_ALLOWED_HEADERS = `authorization, content-type, ${FLOW_SESSION_HEADER}`;

export type EvidenceApiOptions = Partial<FiberPaidHttpMiddlewareConfig> & {
  price?: { value: string; currency: string; display?: string };
  fiberAmountShannons?: string;
  payerFiber?: FiberMethodAdapter;
};

type EvidenceResource = {
  path: string;
  label: string;
  price: { value: string; currency: string; display?: string };
  fiberAmountShannons: string;
  response: Record<string, unknown> | string;
  contentType?: string;
};

type EvidenceResourceSummary = Omit<EvidenceResource, "response">;

type FiberNodeContext = {
  role: string;
  rpc: string;
  status: "connected" | "evidence" | "unconfigured";
};

type FiberRouteContext = {
  node1: FiberNodeContext;
  node2: FiberNodeContext;
  node3: FiberNodeContext;
  route: string[];
  routeSource: "live-config" | "fiber-local-e2e-report" | "unavailable";
  channelCount: number | null;
  channelCountSource: "fiber-local-e2e-report" | "not-polled" | "unavailable";
  routeStatus: string;
};

type BootstrapCheck = {
  id: string;
  label: string;
  value: string | number | boolean | null;
  status: "pass" | "warn" | "fail";
  source: "env" | "rpc" | "report" | "runtime";
};

type BootstrapRoleStatus = {
  role: "payer" | "payee" | "gateway";
  title: string;
  status: "ready" | "evidence" | "blocked";
  source: "env" | "runtime";
  summary: string;
  rpcUrl?: string;
  checks: BootstrapCheck[];
  blockers: string[];
  nextSteps: string[];
};

type ProductionBootstrap = {
  generatedAt: string;
  mode: "local" | "testnet" | "unconfigured";
  liveReady: boolean;
  evidence: {
    localFiberE2e: boolean;
    testnetFiberE2e: boolean;
    productionOperationsReady: boolean;
    productionBootstrapReady: boolean;
    productionReady: boolean;
    gateReady: boolean;
    gateBlockers: string[];
    paymentHash?: string;
    receiptId?: string;
    sources: Record<string, unknown>;
    conflicts: string[];
  };
  roles: BootstrapRoleStatus[];
};

type EvidenceRole = "payer" | "payee" | "gateway";

type EvidenceProfile = {
  id: string;
  role: EvidenceRole;
  label: string;
  mode: "local" | "testnet" | "evidence" | "unconfigured";
  status: "ready" | "evidence" | "blocked";
  endpoint?: string;
  custody: "fnn-built-in-wallet" | "rust-gateway" | "recorded-evidence";
  auth: "present" | "private-rpc" | "missing" | "not-required";
  source: "env" | "runtime" | "report";
  notes: string[];
  blockers: string[];
};

type EvidenceRoleCapability = {
  role: EvidenceRole;
  label: string;
  boundary: "payer-client" | "payee-fnn" | "rust-gateway";
  selectedProfileId: string;
  liveExecution: boolean;
  canSendPayment: boolean;
  canCreateInvoice: boolean;
  canInspectSettlement: boolean;
  canProtectResource: boolean;
  canIssueReceipt: boolean;
  rpcEnv: string[];
  blockers: string[];
  notes: string[];
};

type EvidenceConfiguration = {
  generatedAt: string;
  currency: "CKB";
  profiles: Record<EvidenceRole, EvidenceProfile[]>;
  executionRoleCapabilities: Record<EvidenceRole, EvidenceRoleCapability>;
  runtimeBootstrap: RuntimeBootstrapSummary;
  defaults: {
    endpoint: string;
    amountCkb: string;
    amountShannons: string;
    payerProfileId: string;
    payeeProfileId: string;
    gatewayProfileId: string;
  };
  parameters: {
    resources: EvidenceResourceSummary[];
    challengeTtlSeconds: number;
    settlementTimeoutMs: number;
    amountLimits: {
      minCkb: string;
      maxCkb: string;
      minShannons: string;
      maxShannons: string;
    };
  };
  envTemplate: string;
  warnings: string[];
};

type RuntimeBootstrapInput = {
  mode?: unknown;
  payerRpcUrl?: unknown;
  payeeRpcUrl?: unknown;
  routerRpcUrl?: unknown;
  payerRpcAuth?: unknown;
  payeeRpcAuth?: unknown;
  rpcAuth?: unknown;
  currency?: unknown;
  amountShannons?: unknown;
  settlementTimeoutMs?: unknown;
  challengeTtlSeconds?: unknown;
  enableLive?: unknown;
  generateRuntimeSecret?: unknown;
  confirmRuntimeBootstrap?: unknown;
  confirmInsecureRuntimeBootstrap?: unknown;
};

type RuntimeBootstrapSession = {
  configuredAt: string;
  env: NodeJS.ProcessEnv;
  secretGenerated: boolean;
};

type RuntimeBootstrapSummary = {
  configured: boolean;
  source: "env" | "runtime" | "unconfigured";
  configuredAt?: string;
  mode: "local" | "testnet" | "unconfigured";
  payerRpcUrl?: string;
  payeeRpcUrl?: string;
  routerRpcUrl?: string;
  currency?: string;
  amountShannons?: string;
  secret: "env" | "runtime-generated" | "missing";
  auth: {
    payer: EvidenceProfile["auth"];
    payee: EvidenceProfile["auth"];
  };
  blockers: string[];
};

type EvidenceActionRequest = {
  endpoint?: unknown;
  amountCkb?: unknown;
  amountShannons?: unknown;
  payerProfileId?: unknown;
  payeeProfileId?: unknown;
  gatewayProfileId?: unknown;
};

type FlowEvent = {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  actor: string;
  message: string;
  detail?: string;
};

class RuntimeBootstrapPolicyError extends Error {}

type EvidenceFlowState = {
  endpoint?: string;
  resource?: EvidenceResourceSummary;
  resourceOverride?: EvidenceResource;
  resourceUrl?: string;
  resourceHash?: string;
  profileSelection?: Record<EvidenceRole, string>;
  parameters?: { amountCkb: string; amountShannons: string };
  challengeBody?: unknown;
  challengeId?: string;
  fiberChallenge?: FiberMethodChallenge;
  proof?: unknown;
  credential?: PaymentCredential;
  authorization?: string;
  receipt?: PaymentReceipt;
  paidBody?: unknown;
  replayBody?: unknown;
  replayStatus?: number;
  tournament?: {
    submission?: BattlecodeSubmission;
    registration?: BattlecodeRegistrationInput;
    fairnessManifest?: BattlecodeFairnessManifest;
    requestBody?: string;
    resourceUrl?: string;
    challengeBody?: unknown;
    challengeId?: string;
    fiberChallenge?: FiberMethodChallenge;
    proof?: unknown;
    credential?: PaymentCredential;
    authorization?: string;
    receipt?: PaymentReceipt;
    ticket?: BattlecodeTicket;
    report?: BattlecodeTournamentReport;
  };
  events: FlowEvent[];
};

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const evidenceDbPath = resolve(repoRoot, ".tmp/fiber-paid-http-evidence-api.sqlite");
const reportFiles = {
  canonical: "reports/canonical-core-parity.json",
  fiberLocal: "reports/fiber-local-e2e-evidence.json",
  gateLocal: "reports/fiber-paid-http-gate.local.json",
  gate: "reports/fiber-paid-http-gate.json",
  gateDefault: "reports/fiber-paid-http-gate.default.json",
  rustGate: "reports/fiber-paid-http-rust-gate.json",
  tsGate: "reports/fiber-paid-http-ts-gate.json",
  fiberTestnet: "reports/fiber-testnet-e2e-success.json",
  productionBootstrap: "reports/production-bootstrap-e2e.json",
  productionOps: "reports/production-operations-matrix.json",
  security: "reports/security-matrix.json"
} as const;

const defaultResources: EvidenceResource[] = [
  {
    path: "/paid/protocol-service",
    label: "GET /paid/protocol-service",
    price: { value: "100", currency: "CKB", display: "100 CKB" },
    fiberAmountShannons: "100",
    response: {
      service: "protected-api",
      executed: true,
      paid: true,
      message: "paid protocol service result"
    }
  },
  {
    path: "/paid/weather",
    label: "GET /paid/weather",
    price: { value: "10", currency: "CKB", display: "10 CKB" },
    fiberAmountShannons: "10",
    response: {
      city: "Shanghai",
      condition: "clear",
      paid: true
    }
  },
  {
    path: "/paid/mpp-tool",
    label: "GET /paid/mpp-tool",
    price: { value: "50", currency: "CKB", display: "50 CKB" },
    fiberAmountShannons: "50",
    response: {
      tool: "fiber_paid_http.echo",
      result: { text: "paid MCP tool result" }
    }
  },
  {
    path: "/paid/file",
    label: "GET /paid/file",
    price: { value: "25", currency: "CKB", display: "25 CKB" },
    fiberAmountShannons: "25",
    response: "paid file contents\n",
    contentType: "text/plain"
  }
];

export function createEvidenceApi(options: EvidenceApiOptions = {}): Hono {
  const app = new Hono();
  let runtimeSession: RuntimeBootstrapSession | null = null;
  let runtime = createFiberRuntime(options, effectiveEnv());
  let bootstrapCache:
    | { expiresAt: number; promise: Promise<ProductionBootstrap> }
    | null = null;

  const resources = defaultResources.map((resource) => ({
    ...resource,
    price: options.price ?? resource.price,
    fiberAmountShannons: options.fiberAmountShannons ?? resource.fiberAmountShannons
  }));
  const flows = new Map<string, EvidenceFlowState>();

  app.use("*", async (c, next) => {
    await next();
    const origin = allowedConsoleOrigin(c.req.header("origin"));
    if (origin) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "Origin");
    }
    c.header("access-control-allow-headers", CORS_ALLOWED_HEADERS);
    c.header("access-control-expose-headers", "payment-receipt, www-authenticate");
  });

  app.options("*", (c) => {
    const origin = allowedConsoleOrigin(c.req.header("origin"));
    if (c.req.header("origin") && !origin) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
        "access-control-allow-headers": CORS_ALLOWED_HEADERS,
        "access-control-allow-methods": "GET, POST, OPTIONS"
      }
    });
  });

  app.get("/healthz", (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      service: "fiber-paid-http-evidence-api",
      status: "healthy",
      generatedAt: new Date().toISOString()
    });
  });

  app.get("/readyz", async (c) => {
    const bootstrap = await cachedProductionBootstrap();
    const mode = getEvidenceMode(effectiveEnv());
    const roleBlockers = bootstrap.roles.flatMap((role) => role.blockers);
    const blockers = roleBlockers.length ? roleBlockers : mode.blockers;
    const ready = bootstrap.liveReady && bootstrap.roles.every((role) => role.status === "ready");
    c.header("cache-control", "no-store");
    return c.json({
      ok: ready,
      service: "fiber-paid-http-evidence-api",
      status: ready ? "ready" : "blocked",
      livePaymentEnabled: ready,
      mode: bootstrap.liveReady ? bootstrap.mode : "unconfigured",
      source: runtimeSession ? "runtime" : "env",
      roles: bootstrap.roles.map((role) => ({
        role: role.role,
        status: role.status,
        source: role.source,
        blockers: role.blockers
      })),
      blockers,
      generatedAt: new Date().toISOString()
    }, ready ? 200 : 503);
  });

  app.get("/free", (c) =>
    c.json({
      ok: true,
      message: "free Fiber Paid HTTP evidence route"
    })
  );

  for (const resource of resources) {
    app.get(resource.path, async (c) => protectResource(resource)(c.req.raw));
  }

  app.get("/api/status", async (c) => {
    const flow = currentFlow(c.req.raw);
    const [canonical, fiberLocal, gate, gateDefault, gateLocal, rustGate, tsGate, fiberTestnet, productionBootstrap, productionOps] = await Promise.all([
      readReport("canonical"),
      readReport("fiberLocal"),
      readReport("gate"),
      readReport("gateDefault"),
      readReport("gateLocal"),
      readReport("rustGate"),
      readReport("tsGate"),
      readReport("fiberTestnet"),
      readReport("productionBootstrap"),
      readReport("productionOps")
    ]);
    const env = effectiveEnv();
    const mode = getEvidenceMode(env);
    const productionEvidence = deriveProductionEvidence({
      canonical,
      fiberTestnet,
      gate,
      gateDefault,
      gateLocal,
      rustGate,
      tsGate,
      productionBootstrap,
      productionOps
    });
    const localEvidence = productionEvidence.localFiberE2e;
    const networkStatus = mode.liveReady ? "connected" : localEvidence ? "evidence" : "unconfigured";
    const routeContext = buildRouteContext(mode.liveReady, localEvidence, networkStatus, env);
    c.header("cache-control", "no-store");
    return c.json({
      name: "Fiber Paid HTTP Evidence Console",
      mode: mode.liveReady ? mode.mode : "unconfigured",
      livePaymentEnabled: mode.liveReady,
      blockers: mode.blockers,
      endpoints: resources.map(({ path, label, price, fiberAmountShannons }) => ({
        path,
        label,
        price,
        fiberAmountShannons
      })),
      localFiberNetwork: routeContext,
      badges: {
        rustCanonicalEngine: Boolean((canonical.data as { rust_canonical_verifier?: boolean } | undefined)?.rust_canonical_verifier),
        tsVectorHarness: Boolean((canonical.data as { typescript_vector_harness?: boolean } | undefined)?.typescript_vector_harness),
        localFiberE2e: productionEvidence.localFiberE2e,
        f402Compatibility: Boolean((canonical.data as { f402_parity?: boolean } | undefined)?.f402_parity),
        productionReady: productionEvidence.productionReady,
        gateReady: productionEvidence.gateReady
      },
      engine: {
        canonical: "rust",
        typescriptRole: "compatibility tooling",
        typescriptTrustedBoundary: false
      },
      reports: {
        canonical: summarizeReport(canonical.data),
        fiberLocal: summarizeReport(fiberLocal.data),
        gate: summarizeReport(gate.data),
        gateDefault: summarizeReport(gateDefault.data),
        gateLocal: summarizeReport(gateLocal.data),
        rustGate: summarizeReport(rustGate.data),
        tsGate: summarizeReport(tsGate.data),
        fiberTestnet: summarizeReport(fiberTestnet.data),
        productionBootstrap: summarizeReport(productionBootstrap.data),
        productionOps: summarizeReport(productionOps.data)
      },
      productionEvidence,
      flow
    });
  });

  app.get("/api/bootstrap", async (c) => {
    const bootstrap = await cachedProductionBootstrap();
    c.header("cache-control", "no-store");
    return c.json(bootstrap);
  });

  app.get("/api/configuration", async (c) => {
    const configuration = await buildEvidenceConfiguration(resources, options, await cachedProductionBootstrap(), effectiveEnv(), runtimeSession);
    c.header("cache-control", "no-store");
    return c.json(configuration);
  });

  app.post("/api/bootstrap/runtime", async (c) => {
    const flow = currentFlow(c.req.raw);
    let input: RuntimeBootstrapInput;
    try {
      input = await readRuntimeBootstrapInput(c.req.raw);
      assertRuntimeBootstrapAllowed(c.req.raw, input);
      const nextSession = buildRuntimeBootstrapSession(input);
      runtimeSession = nextSession;
      bootstrapCache = null;
      runtime = createFiberRuntime(options, effectiveEnv());
      resetAllFlows();
      const bootstrap = await cachedProductionBootstrap();
      const configuration = await buildEvidenceConfiguration(resources, options, bootstrap, effectiveEnv(), runtimeSession);
      appendEvent(flow, "INFO", "bootstrap", "runtime bootstrap applied", configuration.runtimeBootstrap.source);
      c.header("cache-control", "no-store");
      return c.json({
        ok: true,
        runtimeBootstrap: configuration.runtimeBootstrap,
        bootstrap,
        configuration,
        flow
      });
    } catch (error) {
      const message = errorMessage(error);
      appendEvent(flow, "ERROR", "bootstrap", "runtime bootstrap failed", message);
      c.header("cache-control", "no-store");
      const policyError = error instanceof RuntimeBootstrapPolicyError;
      return c.json({ error: policyError ? "runtime-bootstrap-disabled" : "invalid-runtime-bootstrap", message, flow }, policyError ? 403 : 400);
    }
  });

  app.post("/api/bootstrap/runtime/reset", async (c) => {
    const flow = currentFlow(c.req.raw);
    try {
      assertRuntimeBootstrapAllowed(c.req.raw, { confirmRuntimeBootstrap: true });
    } catch (error) {
      const message = errorMessage(error);
      appendEvent(flow, "ERROR", "bootstrap", "runtime bootstrap reset blocked", message);
      c.header("cache-control", "no-store");
      return c.json({ error: "runtime-bootstrap-disabled", message, flow }, 403);
    }
    runtimeSession = null;
    bootstrapCache = null;
    runtime = createFiberRuntime(options, effectiveEnv());
    resetAllFlows();
    const bootstrap = await cachedProductionBootstrap();
    const configuration = await buildEvidenceConfiguration(resources, options, bootstrap, effectiveEnv(), runtimeSession);
    appendEvent(flow, "INFO", "bootstrap", "runtime bootstrap cleared", configuration.runtimeBootstrap.source);
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      runtimeBootstrap: configuration.runtimeBootstrap,
      bootstrap,
      configuration,
      flow
    });
  });

  app.post("/api/evidence/unpaid", async (c) => {
    const flow = currentFlow(c.req.raw);
    resetFlow(flow);
    let resource: EvidenceResource;
    let request: EvidenceActionRequest;
    try {
      request = await readEvidenceActionRequest(c.req.raw);
      resource = resolveRequestedResource(resources, request);
      assertExecutableProfileSelection(normalizeProfileSelection(request, defaultProfileSelection()));
    } catch (error) {
      appendEvent(flow, "ERROR", "client", "invalid evidence parameters", errorMessage(error));
      return c.json({ error: "invalid-evidence-parameters", message: errorMessage(error), flow }, 400);
    }
    const resourceUrl = new URL(resource.path, c.req.url).toString();
    flow.endpoint = resource.path;
    flow.resource = summarizeResource(resource);
    flow.resourceOverride = resource;
    flow.resourceUrl = resourceUrl;
    flow.resourceHash = await resourceHashFromRequest(new Request(resourceUrl));
    flow.profileSelection = normalizeProfileSelection(request, defaultProfileSelection());
    flow.parameters = {
      amountCkb: resource.price.value,
      amountShannons: resource.fiberAmountShannons
    };
    appendEvent(flow, "INFO", "client", `GET ${resource.path}`, `amount=${resource.price.display ?? `${resource.price.value} CKB`}; fiber_amount_shannons=${resource.fiberAmountShannons}`);
    const response = await protectResource(resource)(new Request(resourceUrl));
    const body = await safeJson(response);
    const fiberChallenge = findFiberChallenge(body);
    flow.challengeBody = body;
    flow.challengeId = getChallengeId(body);
    flow.fiberChallenge = fiberChallenge;
    appendEvent(
      flow,
      response.status === 402 ? "INFO" : "ERROR",
      "server",
      response.status === 402 ? "402 issued" : "live Fiber not configured",
      response.status === 402 ? `challenge=${flow.challengeId ?? "unknown"}` : `HTTP ${response.status}`
    );
    return c.json({
      status: response.status,
      headers: exposeHeaders(response),
      body,
      fiberChallenge,
      flow
    }, response.status === 402 ? 200 : 503);
  });

  app.post("/paid/echo", async (c) =>
    protectWithRuntime({
      price: options.price ?? { value: "1", currency: "CKB", display: "1 CKB" },
      methods: ["fiber"],
      handler: async (request) =>
        Response.json({
          paid: true,
          echo: await request.json().catch(() => null)
        })
    })(c.req.raw)
  );

  app.post("/api/evidence/pay", async (c) => {
    const flow = currentFlow(c.req.raw);
    if (!runtime) {
      appendEvent(flow, "ERROR", "server", "live Fiber not configured", "payment step unavailable");
      return c.json({ error: "live-fiber-not-configured", flow }, 503);
    }
    const stateError = challengeReadyBlocker(flow);
    if (stateError) {
      appendEvent(flow, "WARN", "client", "payment step blocked", stateError);
      return c.json({ error: "invalid-evidence-state", message: stateError, flow }, 409);
    }
    const challenge = flow.fiberChallenge!;
    appendEvent(flow, "INFO", "node1 (payer)", "send_payment", `payment_hash=${challenge.paymentHash}`);
    const proof = await runtime.payerFiber.payChallenge(challenge);
    flow.proof = proof;
    flow.credential = {
      domain: "fiber-paid-http-credential-v1",
      challengeId: flow.challengeId!,
      method: "fiber",
      resourceHash: await resourceHashFromRequest(new Request(flow.resourceUrl!)),
      paymentProof: proof,
      submittedAt: new Date().toISOString()
    };
    flow.authorization = buildAuthorizationPaymentHeader(flow.credential);
    appendEvent(flow, "INFO", "fiber-method", "payment proof returned", `mode=${String((proof as { mode?: unknown }).mode ?? "unknown")}; status=${String((proof as { status?: unknown }).status ?? "settled")}`);
    return c.json({
      proof,
      credential: flow.credential,
      authorizationPreview: preview(flow.authorization!),
      flow
    });
  });

  app.post("/api/evidence/retry", async (c) => {
    const flow = currentFlow(c.req.raw);
    const stateError = authorizationReadyBlocker(flow);
    if (stateError) {
      appendEvent(flow, "WARN", "client", "retry blocked", stateError);
      return c.json({ error: "invalid-evidence-state", message: stateError, flow }, 409);
    }
    const resource = flow.resourceOverride ?? findResource(resources, flow.endpoint);
    appendEvent(flow, "INFO", "client", "retry with Authorization: Payment", preview(flow.authorization!));
    const response = await protectResource(resource)(new Request(flow.resourceUrl!, {
      headers: { authorization: flow.authorization! }
    }));
    const body = await safeBody(response);
    const encodedReceipt = response.headers.get(PAYMENT_RECEIPT_HEADER);
    const receipt = encodedReceipt ? decodeReceipt(encodedReceipt) : undefined;
    flow.receipt = receipt;
    flow.paidBody = body;
    if (receipt) {
      appendEvent(flow, "INFO", "server", "payment verified", `receipt_id=${receipt.receiptId}`);
      appendEvent(flow, "INFO", "protected-service", "service executed", `HTTP ${response.status}`);
    }
    return c.json({
      status: response.status,
      headers: exposeHeaders(response),
      body,
      receipt,
      flow
    });
  });

  app.post("/api/evidence/replay", async (c) => {
    const flow = currentFlow(c.req.raw);
    const stateError = authorizationReadyBlocker(flow);
    if (stateError) {
      appendEvent(flow, "WARN", "client", "replay blocked", stateError);
      return c.json({ error: "invalid-evidence-state", message: stateError, flow }, 409);
    }
    const resource = flow.resourceOverride ?? findResource(resources, flow.endpoint);
    appendEvent(flow, "WARN", "client", "replay same credential", preview(flow.authorization!));
    const response = await protectResource(resource)(new Request(flow.resourceUrl!, {
      headers: { authorization: flow.authorization! }
    }));
    const body = await safeBody(response);
    flow.replayStatus = response.status;
    flow.replayBody = body;
    appendEvent(flow, response.status === 402 ? "WARN" : "ERROR", "server", "replay rejected", `HTTP ${response.status}`);
    return c.json({
      status: response.status,
      headers: exposeHeaders(response),
      body,
      rejected: response.status === 402,
      receiptReissued: response.headers.has(PAYMENT_RECEIPT_HEADER),
      flow
    });
  });

  app.get("/api/evidence/export", async (c) => {
    const flow = currentFlow(c.req.raw);
    c.header("cache-control", "no-store");
    return c.json(await buildEvidenceExport({}, flow));
  });

  app.post("/api/evidence/export", async (c) => {
    const flow = currentFlow(c.req.raw);
    const request = await readEvidenceActionRequest(c.req.raw);
    c.header("cache-control", "no-store");
    return c.json(await buildEvidenceExport(request, flow));
  });

  app.post("/api/evidence/reset", (c) => {
    const flow = currentFlow(c.req.raw);
    resetFlow(flow);
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      flow
    });
  });

  app.get("/api/tournament/battlecode/status", async (c) => {
    const flow = currentFlow(c.req.raw);
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      tournament: await battlecodeStatus(repoRoot, effectiveEnv()),
      current: flow.tournament ?? null
    });
  });

  app.get("/api/tournament/battlecode/manifest", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      fairnessManifest: await buildBattlecodeFairnessManifest(repoRoot, effectiveEnv())
    });
  });

  app.post("/api/tournament/battlecode/submissions", async (c) => {
    const flow = currentFlow(c.req.raw);
    let submission: BattlecodeSubmission;
    let fairnessManifest: BattlecodeFairnessManifest;
    try {
      const input = normalizeBattlecodeSubmission(await c.req.json().catch(() => ({})));
      const created = await createBattlecodeSubmission(repoRoot, input, effectiveEnv());
      submission = created.submission;
      fairnessManifest = created.fairnessManifest;
    } catch (error) {
      appendEvent(flow, "ERROR", "tournament", "Battlecode submission rejected", errorMessage(error));
      return c.json({ error: "invalid-battlecode-submission", message: errorMessage(error), flow }, 400);
    }
    flow.tournament = {
      ...(flow.tournament ?? {}),
      submission,
      fairnessManifest
    };
    appendEvent(flow, "INFO", "tournament", "Battlecode bot submission locked", `${submission.submissionId} ${submission.botScriptHash}`);
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      submission,
      fairnessManifest,
      registrationDefaults: {
        playerId: submission.playerId,
        submissionId: submission.submissionId,
        botPackage: submission.botPackage,
        botScriptHash: submission.botScriptHash,
        clientHash: fairnessManifest.clientHash
      },
      flow
    });
  });

  app.post("/api/tournament/battlecode/register/unpaid", async (c) => {
    const flow = currentFlow(c.req.raw);
    const bodyText = await c.req.raw.text();
    let registration: BattlecodeRegistrationInput;
    let submission: BattlecodeSubmission;
    let fairnessManifest: BattlecodeFairnessManifest;
    try {
      registration = normalizeBattlecodeRegistration(parseJsonBody(bodyText));
      submission = await findBattlecodeSubmission(repoRoot, registration.submissionId, effectiveEnv());
      fairnessManifest = await buildBattlecodeFairnessManifest(repoRoot, effectiveEnv(), submission);
      assertBattlecodeFairnessCommitment(registration, fairnessManifest, submission);
    } catch (error) {
      appendEvent(flow, "ERROR", "tournament", "invalid Battlecode registration", errorMessage(error));
      return c.json({ error: "invalid-battlecode-registration", message: errorMessage(error), flow }, 400);
    }
    const resourceUrl = new URL("/api/tournament/battlecode/register", c.req.url).toString();
    flow.tournament = {
      submission,
      registration,
      fairnessManifest,
      requestBody: JSON.stringify(registration),
      resourceUrl
    };
    appendEvent(flow, "INFO", "tournament", "Battlecode xUDT entry requested", `${registration.entryAmount} ${registration.xudtAsset}`);
    const response = await protectBattlecodeRegistration(registration)(new Request(resourceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: flow.tournament.requestBody
    }));
    const body = await safeJson(response);
    const fiberChallenge = findFiberChallenge(body);
    flow.tournament.challengeBody = body;
    flow.tournament.challengeId = getChallengeId(body);
    flow.tournament.fiberChallenge = fiberChallenge;
    appendEvent(flow, response.status === 402 ? "INFO" : "ERROR", "gateway", response.status === 402 ? "Battlecode entry 402 issued" : "Battlecode entry challenge failed", `HTTP ${response.status}`);
    c.header("cache-control", "no-store");
    return c.json({
      status: response.status,
      registration,
      submission,
      headers: exposeHeaders(response),
      body,
      fiberChallenge,
      flow
    }, response.status === 402 ? 200 : 503);
  });

  app.post("/api/tournament/battlecode/register/pay", async (c) => {
    const flow = currentFlow(c.req.raw);
    if (!runtime) {
      appendEvent(flow, "ERROR", "payer", "Battlecode entry payment blocked", "live Fiber not configured");
      return c.json({ error: "live-fiber-not-configured", flow }, 503);
    }
    const tournament = flow.tournament;
    if (!tournament?.fiberChallenge || !tournament.challengeId || !tournament.resourceUrl) {
      appendEvent(flow, "WARN", "payer", "Battlecode payment blocked", "request an unpaid tournament entry first");
      return c.json({ error: "invalid-tournament-state", message: "request an unpaid tournament entry first", flow }, 409);
    }
    appendEvent(flow, "INFO", "payer", "pay Battlecode xUDT ticket over Fiber", `payment_hash=${tournament.fiberChallenge.paymentHash}`);
    const proof = await runtime.payerFiber.payChallenge(tournament.fiberChallenge);
    const credential: PaymentCredential = {
      domain: "fiber-paid-http-credential-v1",
      challengeId: tournament.challengeId,
      method: "fiber",
      resourceHash: await resourceHashFromRequest(new Request(tournament.resourceUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: tournament.requestBody ?? "{}"
      })),
      paymentProof: proof,
      submittedAt: new Date().toISOString()
    };
    tournament.proof = proof;
    tournament.credential = credential;
    tournament.authorization = buildAuthorizationPaymentHeader(credential);
    appendEvent(flow, "INFO", "fiber-method", "Battlecode ticket payment settled", `mode=${String((proof as { mode?: unknown }).mode ?? "unknown")}`);
    c.header("cache-control", "no-store");
    return c.json({
      proof,
      credential,
      authorizationPreview: preview(tournament.authorization),
      flow
    });
  });

  app.post("/api/tournament/battlecode/register/claim", async (c) => {
    const flow = currentFlow(c.req.raw);
    const tournament = flow.tournament;
    if (!tournament?.registration || !tournament.authorization || !tournament.resourceUrl || !tournament.requestBody) {
      appendEvent(flow, "WARN", "gateway", "Battlecode ticket claim blocked", "pay the tournament entry first");
      return c.json({ error: "invalid-tournament-state", message: "pay the tournament entry first", flow }, 409);
    }
    appendEvent(flow, "INFO", "client", "claim Battlecode ticket with Authorization: Payment", preview(tournament.authorization));
    const response = await protectBattlecodeRegistration(tournament.registration)(new Request(tournament.resourceUrl, {
      method: "POST",
      headers: {
        authorization: tournament.authorization,
        "content-type": "application/json"
      },
      body: tournament.requestBody
    }));
    const body = await safeBody(response);
    const encodedReceipt = response.headers.get(PAYMENT_RECEIPT_HEADER);
    const receipt = encodedReceipt ? decodeReceipt(encodedReceipt) : undefined;
    tournament.receipt = receipt;
    let ticket: BattlecodeTicket | undefined;
    if (response.status === 200 && receipt) {
      ticket = issueBattlecodeTicket({
        registration: tournament.registration,
        submission: tournament.submission ?? await findBattlecodeSubmission(repoRoot, tournament.registration.submissionId, effectiveEnv()),
        fairnessManifest: tournament.fairnessManifest ?? await buildBattlecodeFairnessManifest(
          repoRoot,
          effectiveEnv(),
          tournament.submission ?? await findBattlecodeSubmission(repoRoot, tournament.registration.submissionId, effectiveEnv())
        ),
        receiptId: receipt.receiptId,
        paymentHash: receipt.settlement.paymentHash
      });
      tournament.ticket = ticket;
      await appendBattlecodeTicket(repoRoot, ticket, effectiveEnv());
      appendEvent(flow, "INFO", "tournament", "Battlecode ticket issued", ticket.ticketId);
    }
    c.header("cache-control", "no-store");
    return c.json({
      status: response.status,
      headers: exposeHeaders(response),
      body,
      receipt,
      ticket,
      flow
    });
  });

  app.post("/api/tournament/battlecode/match/run", async (c) => {
    const flow = currentFlow(c.req.raw);
    const tournament = flow.tournament;
    if (!tournament?.registration || !tournament.ticket || !tournament.submission) {
      appendEvent(flow, "WARN", "tournament", "Battlecode match blocked", "claim a paid ticket first");
      return c.json({ error: "invalid-tournament-state", message: "claim a paid ticket first", flow }, 409);
    }
    appendEvent(flow, "INFO", "battlecode", "match started", `${tournament.ticket.botPackage} vs baselinebot on ${tournament.registration.map}`);
    try {
      const report = await runBattlecodeTournament({
        registration: tournament.registration,
        ticket: tournament.ticket,
        submission: tournament.submission,
        repoRoot,
        env: effectiveEnv()
      });
      tournament.report = report;
      appendEvent(flow, "INFO", "battlecode", "match finished", `${report.match.winner} wins round ${report.match.round}`);
      if (report.award) {
        appendEvent(
          flow,
          "INFO",
          report.award.settlement === "fiber-xudt-payment" ? "fiber-xudt" : "xudt-ledger",
          report.award.settlement === "fiber-xudt-payment" ? "prize payment settled" : "prize award recorded",
          `${report.award.prizeAmount} ${report.award.xudtAsset}`
        );
      } else {
        appendEvent(flow, "WARN", "xudt-ledger", "no prize awarded", "registered bot did not win");
      }
      c.header("cache-control", "no-store");
      return c.json({ ok: true, report, flow });
    } catch (error) {
      appendEvent(flow, "ERROR", "battlecode", "match failed", errorMessage(error));
      c.header("cache-control", "no-store");
      return c.json({ error: "battlecode-match-failed", message: errorMessage(error), flow }, 500);
    }
  });

  app.get("/api/tournament/battlecode/export", async (c) => {
    const flow = currentFlow(c.req.raw);
    c.header("cache-control", "no-store");
    return c.json({
      generatedAt: new Date().toISOString(),
      tournament: flow.tournament ?? null,
      ledger: await readBattlecodeLedgerSafe()
    });
  });

  for (const [name] of Object.entries(reportFiles)) {
    app.get(`/api/reports/${kebabCase(name)}`, async (c) => {
      const report = await readReport(name as keyof typeof reportFiles);
      c.header("cache-control", "no-store");
      if (!report.exists) {
        return c.json(report, 404);
      }
      return c.json(report);
    });
  }

  return app;

  function protectResource(resource: EvidenceResource): (request: Request) => Promise<Response> {
    return protectWithRuntime({
      price: resource.price,
      methods: ["fiber"],
      fiberAmountShannons: resource.fiberAmountShannons,
      handler: async () => {
        if (typeof resource.response === "string") {
          return new Response(resource.response, {
            headers: { "content-type": resource.contentType ?? "text/plain" }
          });
        }
        return Response.json(resource.response);
      }
    });
  }

  function protectWithRuntime(route: Parameters<FiberPaidHttpMiddleware["protect"]>[0]): (request: Request) => Promise<Response> {
    if (!runtime) {
      return async () => liveFiberNotConfiguredResponse(getEvidenceMode(effectiveEnv()).blockers);
    }
    return runtime.middleware.protect(route);
  }

  function protectBattlecodeRegistration(registration: BattlecodeRegistrationInput): (request: Request) => Promise<Response> {
    return protectWithRuntime({
      price: battlecodeEntryPrice(registration),
      methods: ["fiber"],
      fiberAmountShannons: registration.entryAmount,
      fiberUdtTypeScript: runtime ? battlecodeXudtTypeScript(effectiveEnv()) : undefined,
      metadata: {
        application: "fiber-paid-http-battlecode-tournament",
        playerId: registration.playerId,
        submissionId: registration.submissionId,
        botPackage: registration.botPackage,
        botScriptHash: registration.botScriptHash,
        clientHash: registration.clientHash,
        fairnessCommitment: {
          botScriptHash: registration.botScriptHash,
          clientHash: registration.clientHash
        },
        xudtAsset: registration.xudtAsset,
        prizeAmount: registration.prizeAmount,
        map: registration.map
      },
      handler: async () => Response.json({
        ok: true,
        accepted: true,
        tournament: "battlecode",
        playerId: registration.playerId,
        submissionId: registration.submissionId,
        botPackage: registration.botPackage,
        botScriptHash: registration.botScriptHash,
        clientHash: registration.clientHash,
        xudtAsset: registration.xudtAsset,
        entryAmount: registration.entryAmount,
        prizeAmount: registration.prizeAmount
      })
    });
  }

  async function readBattlecodeLedgerSafe(): Promise<unknown> {
    try {
      const { readBattlecodeLedger } = await import("./battlecode.js");
      return readBattlecodeLedger(repoRoot, effectiveEnv());
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  async function buildEvidenceExport(request: EvidenceActionRequest, flow: EvidenceFlowState): Promise<Record<string, unknown>> {
    const [bootstrap, canonical, fiberTestnet, gateLocal, security, productionOps] = await Promise.all([
      cachedProductionBootstrap(),
      readReport("canonical"),
      readReport("fiberTestnet"),
      readReport("gateLocal"),
      readReport("security"),
      readReport("productionOps")
    ]);
    const configuration = await buildEvidenceConfiguration(resources, options, bootstrap, effectiveEnv(), runtimeSession);
    const requestedAmountCkb = normalizeAmountCkb(request.amountCkb);
    const requestedAmountShannons = normalizeAmountShannons(
      request.amountShannons ?? (requestedAmountCkb ? ckbToShannons(requestedAmountCkb) : undefined)
    );
    return {
      generatedAt: new Date().toISOString(),
      console: "Fiber Paid HTTP Evidence Console",
      requestedRun: {
        endpoint: stringValue(request.endpoint) ?? flow.endpoint ?? configuration.defaults.endpoint,
        profileSelection: normalizeProfileSelection(request, defaultProfileSelection()),
        parameters: {
          amountCkb: requestedAmountCkb ?? flow.parameters?.amountCkb ?? configuration.defaults.amountCkb,
          amountShannons: requestedAmountShannons ?? flow.parameters?.amountShannons ?? configuration.defaults.amountShannons
        }
      },
      configuration,
      bootstrap,
      flow,
      reports: {
        canonical,
        fiberTestnet,
        gateLocal,
        security,
        productionOps
      },
      safety: {
        secretsExposed: false,
        note: "RPC auth and signing secrets are intentionally omitted from this export."
      }
    };
  }

  function cachedProductionBootstrap(): Promise<ProductionBootstrap> {
    const now = Date.now();
    if (bootstrapCache && bootstrapCache.expiresAt > now) {
      return bootstrapCache.promise;
    }
    const promise = buildProductionBootstrap(effectiveEnv(), runtimeSession ? "runtime" : "env");
    bootstrapCache = {
      expiresAt: now + 2_000,
      promise
    };
    promise.catch(() => {
      if (bootstrapCache?.promise === promise) {
        bootstrapCache = null;
      }
    });
    return promise;
  }

  function effectiveEnv(): NodeJS.ProcessEnv {
    return runtimeSession ? { ...process.env, ...runtimeSession.env } : process.env;
  }

  function defaultProfileSelection(): Record<EvidenceRole, string> {
    const prefix = runtimeSession ? "runtime" : "env";
    return {
      payer: `${prefix}-payer`,
      payee: `${prefix}-payee`,
      gateway: `${prefix}-gateway`
    };
  }

  function currentFlow(request: Request): EvidenceFlowState {
    const sessionId = normalizeFlowSessionId(request.headers.get(FLOW_SESSION_HEADER) ?? new URL(request.url).searchParams.get("sessionId"));
    const existing = flows.get(sessionId);
    if (existing) {
      flows.delete(sessionId);
      flows.set(sessionId, existing);
      return existing;
    }
    if (flows.size >= 16) {
      const oldest = flows.keys().next().value;
      if (oldest) {
        flows.delete(oldest);
      }
    }
    const flow: EvidenceFlowState = { events: [] };
    flows.set(sessionId, flow);
    return flow;
  }

  function resetAllFlows(): void {
    for (const flow of flows.values()) {
      resetFlow(flow);
    }
  }
}

export function startEvidenceApi(port = Number(process.env.PORT ?? "8787")) {
  const app = createEvidenceApi();
  const server = serve({ fetch: app.fetch, port });
  console.log(`Fiber Paid HTTP evidence API listening on http://localhost:${port}`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startEvidenceApi();
}

function createFiberRuntime(options: EvidenceApiOptions, env: NodeJS.ProcessEnv = process.env): { middleware: FiberPaidHttpMiddleware; payerFiber: FiberMethodAdapter } | null {
  const readiness = getEvidenceMode(env);
  const hasInjectedAdapters = Boolean(options.fiber && options.payerFiber);
  if (!readiness.liveReady && !hasInjectedAdapters) {
    return null;
  }
  mkdirSync(dirname(evidenceDbPath), { recursive: true });
  const fiber = options.fiber ?? FiberMethodAdapter.fromEnv(env, "payee");
  const payerFiber = options.payerFiber ?? FiberMethodAdapter.fromEnv(env, "payer");
  const secret = options.secret ?? paidHttpSecret(env);
  if (!secret) {
    throw new Error("Fiber Paid HTTP evidence runtime requires FIBER_PAID_HTTP_SECRET or options.secret");
  }
  const middleware = createFiberPaidHttpMiddleware({
    secret,
    serverId: options.serverId ?? "fiber-paid-http-evidence-api",
    store: options.store ?? new SqliteStore(evidenceDbPath),
    fiber,
    defaultFiberAmountShannons: options.fiberAmountShannons ?? env.FIBER_E2E_AMOUNT_SHANNONS ?? "1000",
    challengeTtlSeconds: options.challengeTtlSeconds ?? positiveInteger(paidHttpChallengeTtlSeconds(env), 120),
    clockSkewSeconds: options.clockSkewSeconds ?? 2
  });
  return { middleware, payerFiber };
}

function getEvidenceMode(env: NodeJS.ProcessEnv = process.env): { mode: "local" | "testnet" | "unconfigured"; liveReady: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const runRequested = env.RUN_FIBER_E2E === "1";
  let mode: "local" | "testnet" | "unconfigured" = "unconfigured";
  try {
    mode = parseFiberMode(env.FIBER_MODE);
  } catch {
    blockers.push("Live Fiber mode inactive: set FIBER_MODE=local or FIBER_MODE=testnet");
  }
  if (!runRequested) {
    blockers.push("Live Fiber mode inactive: set RUN_FIBER_E2E=1 for local/testnet execution");
  }
  if (!(env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL)) {
    blockers.push("Live Fiber mode inactive: set FIBER_PAYEE_RPC_URL or FIBER_RPC_URL");
  }
  if (!env.FIBER_PAYER_RPC_URL) {
    blockers.push("Live Fiber mode inactive: set FIBER_PAYER_RPC_URL");
  }
  const secret = paidHttpSecret(env);
  if (!secret || secret.length < 32) {
    blockers.push("Live Fiber mode inactive: set FIBER_PAID_HTTP_SECRET to a random secret of at least 32 characters");
  }
  const liveReady = blockers.length === 0;
  return { mode, liveReady, blockers };
}

function fiberNodeContext(role: string, rpc: string, status: FiberNodeContext["status"]): FiberNodeContext {
  return { role, rpc, status };
}

function buildRouteContext(
  liveReady: boolean,
  localEvidence: boolean,
  networkStatus: FiberNodeContext["status"],
  env: NodeJS.ProcessEnv = process.env
): FiberRouteContext {
  const routeAvailable = liveReady || localEvidence;
  return {
    node1: fiberNodeContext("payer", env.FIBER_PAYER_RPC_URL ?? "127.0.0.1:21714", networkStatus),
    node2: fiberNodeContext("router", env.FIBER_ROUTER_RPC_URL ?? "127.0.0.1:21715", networkStatus),
    node3: fiberNodeContext("payee", env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL ?? "127.0.0.1:21716", networkStatus),
    route: routeAvailable ? ["node1", "node2", "node3"] : [],
    routeSource: liveReady ? "live-config" : localEvidence ? "fiber-local-e2e-report" : "unavailable",
    channelCount: localEvidence ? 2 : null,
    channelCountSource: localEvidence ? "fiber-local-e2e-report" : liveReady ? "not-polled" : "unavailable",
    routeStatus: liveReady
      ? "live RPC configured; channel count not polled"
      : localEvidence
        ? "local E2E evidence recorded; not live polled"
      : "not configured"
  };
}

async function buildProductionBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  source: "env" | "runtime" = "env"
): Promise<ProductionBootstrap> {
  const mode = getEvidenceMode(env);
  const [canonical, gate, gateDefault, gateLocal, fiberTestnet, productionBootstrap, productionOps, rustGate, tsGate] = await Promise.all([
    readReport("canonical"),
    readReport("gate"),
    readReport("gateDefault"),
    readReport("gateLocal"),
    readReport("fiberTestnet"),
    readReport("productionBootstrap"),
    readReport("productionOps"),
    readReport("rustGate"),
    readReport("tsGate")
  ]);
  const evidence = deriveProductionEvidence({
    canonical,
    fiberTestnet,
    gate,
    gateDefault,
    gateLocal,
    rustGate,
    tsGate,
    productionBootstrap,
    productionOps
  });
  const evidenceAvailable = evidence.testnetFiberE2e || evidence.localFiberE2e;
  return {
    generatedAt: new Date().toISOString(),
    mode: mode.mode,
    liveReady: mode.liveReady,
    evidence,
    roles: [
      await buildFiberBootstrapRole("payer", evidenceAvailable, env, source),
      await buildFiberBootstrapRole("payee", evidenceAvailable, env, source),
      buildGatewayBootstrapRole(mode.liveReady, evidence, canonical.data, env, source)
    ]
  };
}

async function buildEvidenceConfiguration(
  resources: EvidenceResource[],
  options: EvidenceApiOptions,
  bootstrapInput?: ProductionBootstrap,
  env: NodeJS.ProcessEnv = process.env,
  runtimeSession?: RuntimeBootstrapSession | null
): Promise<EvidenceConfiguration> {
  const bootstrap = bootstrapInput ?? await buildProductionBootstrap(env, runtimeSession ? "runtime" : "env");
  const defaultResource = resources[0]!;
  const profiles = {
    payer: buildProfilesForRole(bootstrap.roles.find((role) => role.role === "payer"), bootstrap, env),
    payee: buildProfilesForRole(bootstrap.roles.find((role) => role.role === "payee"), bootstrap, env),
    gateway: buildProfilesForRole(bootstrap.roles.find((role) => role.role === "gateway"), bootstrap, env)
  };
  const defaults = {
    endpoint: defaultResource.path,
    amountCkb: defaultResource.price.value,
    amountShannons: defaultResource.fiberAmountShannons,
    payerProfileId: profiles.payer[0]?.id ?? "env-payer",
    payeeProfileId: profiles.payee[0]?.id ?? "env-payee",
    gatewayProfileId: profiles.gateway[0]?.id ?? "env-gateway"
  };
  const executionRoleCapabilities = buildExecutionRoleCapabilities(profiles, defaults, bootstrap, options);
  return {
    generatedAt: new Date().toISOString(),
    currency: "CKB",
    profiles,
    executionRoleCapabilities,
    runtimeBootstrap: runtimeBootstrapSummary(runtimeSession ?? null, env, bootstrap),
    defaults,
    parameters: {
      resources: resources.map(summarizeResource),
      challengeTtlSeconds: positiveInteger(options.challengeTtlSeconds ?? paidHttpChallengeTtlSeconds(env), 120),
      settlementTimeoutMs: positiveInteger(env.FIBER_SETTLEMENT_TIMEOUT_MS ?? env.FIBER_E2E_SETTLEMENT_TIMEOUT_MS, 30_000),
      amountLimits: {
        minCkb: "0.00000001",
        maxCkb: "1000000000",
        minShannons: "1",
        maxShannons: "100000000000000000"
      }
    },
    envTemplate: buildEnvTemplate(defaultResource, env),
    warnings: [
      "Only env-payer, env-payee, and env-gateway are executable from process env; runtime-payer, runtime-payee, and runtime-gateway are executable after UI runtime bootstrap; recorded evidence profiles are export-only.",
      "The payer client sends Fiber payments; the payee FNN creates invoices; the Rust gateway protects resources, verifies settlement, and issues receipts.",
      "CKB is the user-facing protocol price unit; Fiber RPC settlement uses integer shannons."
    ]
  };
}

function buildExecutionRoleCapabilities(
  profiles: Record<EvidenceRole, EvidenceProfile[]>,
  defaults: EvidenceConfiguration["defaults"],
  bootstrap: ProductionBootstrap,
  options: EvidenceApiOptions
): Record<EvidenceRole, EvidenceRoleCapability> {
  const injectedRuntime = Boolean(options.fiber && options.payerFiber);
  const selected = {
    payer: defaults.payerProfileId,
    payee: defaults.payeeProfileId,
    gateway: defaults.gatewayProfileId
  };
  const ready = (role: EvidenceRole) => {
    const profile = profiles[role].find((item) => item.id === selected[role]) ?? profiles[role][0];
    return Boolean(injectedRuntime || profile?.status === "ready");
  };
  const blockers = (role: EvidenceRole) => {
    const profile = profiles[role].find((item) => item.id === selected[role]) ?? profiles[role][0];
    if (injectedRuntime) {
      return [];
    }
    return profile?.blockers ?? ["profile unavailable"];
  };
  const modeNote = bootstrap.liveReady
    ? `Live ${bootstrap.mode} Fiber execution is enabled.`
    : injectedRuntime
      ? "Injected runtime adapters are available for this process."
      : "Live Fiber execution is blocked until the role bootstrap checks pass.";

  return {
    payer: {
      role: "payer",
      label: "Payer client",
      boundary: "payer-client",
      selectedProfileId: selected.payer,
      liveExecution: ready("payer"),
      canSendPayment: ready("payer"),
      canCreateInvoice: false,
      canInspectSettlement: false,
      canProtectResource: false,
      canIssueReceipt: false,
      rpcEnv: ["FIBER_PAYER_RPC_URL", "FIBER_PAYER_RPC_AUTH"],
      blockers: blockers("payer"),
      notes: [
        "Owns the payer Fiber wallet/channel state and executes send_payment.",
        "Production gateways should not hold user payer wallet credentials.",
        modeNote
      ]
    },
    payee: {
      role: "payee",
      label: "Payee FNN",
      boundary: "payee-fnn",
      selectedProfileId: selected.payee,
      liveExecution: ready("payee"),
      canSendPayment: false,
      canCreateInvoice: ready("payee"),
      canInspectSettlement: ready("payee"),
      canProtectResource: false,
      canIssueReceipt: false,
      rpcEnv: ["FIBER_PAYEE_RPC_URL", "FIBER_PAYEE_RPC_AUTH"],
      blockers: blockers("payee"),
      notes: [
        "Creates Fiber invoices for HTTP 402 challenges.",
        "Provides settlement inspection for payment proof verification.",
        modeNote
      ]
    },
    gateway: {
      role: "gateway",
      label: "Rust gateway",
      boundary: "rust-gateway",
      selectedProfileId: selected.gateway,
      liveExecution: ready("gateway"),
      canSendPayment: false,
      canCreateInvoice: false,
      canInspectSettlement: ready("payee"),
      canProtectResource: ready("gateway"),
      canIssueReceipt: ready("gateway"),
      rpcEnv: ["FIBER_PAID_HTTP_SECRET", "FIBER_PAYEE_RPC_URL"],
      blockers: blockers("gateway"),
      notes: [
        "Owns the HTTP trusted boundary: challenge signing, replay store, and Payment-Receipt issuance.",
        "Uses the payee Fiber RPC path to verify payment settlement.",
        modeNote
      ]
    }
  };
}

function buildProfilesForRole(role: BootstrapRoleStatus | undefined, bootstrap: ProductionBootstrap, env: NodeJS.ProcessEnv): EvidenceProfile[] {
  const roleId = role?.role ?? "gateway";
  const title = role?.title ?? "Gateway";
  const rpcUrl = role?.rpcUrl;
  const source = role?.source ?? "env";
  const executablePrefix = source === "runtime" ? "runtime" : "env";
  const profiles: EvidenceProfile[] = [
    {
      id: `${executablePrefix}-${roleId}`,
      role: roleId,
      label: `${title} from ${source === "runtime" ? "UI runtime bootstrap" : "environment"}`,
      mode: role?.status === "ready" ? bootstrap.mode : role?.status === "evidence" ? "evidence" : "unconfigured",
      status: role?.status ?? "blocked",
      endpoint: rpcUrl,
      custody: roleId === "gateway" ? "rust-gateway" : "fnn-built-in-wallet",
      auth: profileAuthStatus(roleId, rpcUrl, env),
      source,
      notes: [
        roleId === "gateway" ? "Rust gateway verifies receipts and protects the API route." : "FNN built-in wallet owns Fiber channel state and executes payments.",
        role?.summary ?? "Bootstrap role is not available."
      ],
      blockers: role?.blockers ?? ["bootstrap role missing"]
    }
  ];

  if (bootstrap.evidence.testnetFiberE2e) {
    profiles.push(evidenceProfile(roleId, title, "testnet", bootstrap.evidence));
  }
  if (bootstrap.evidence.localFiberE2e) {
    profiles.push(evidenceProfile(roleId, title, "local", bootstrap.evidence));
  }
  return profiles;
}

function evidenceProfile(
  role: EvidenceRole,
  title: string,
  mode: "local" | "testnet",
  evidence: ProductionBootstrap["evidence"]
): EvidenceProfile {
  return {
    id: `${mode}-${role}-evidence`,
    role,
    label: `${title} ${mode} evidence`,
    mode: "evidence",
    status: "evidence",
    custody: role === "gateway" ? "rust-gateway" : "recorded-evidence",
    auth: "not-required",
    source: "report",
    notes: [
      `${mode} Fiber E2E report is available.`,
      evidence.paymentHash ? `payment_hash=${evidence.paymentHash}` : "payment_hash unavailable",
      evidence.receiptId ? `receipt_id=${evidence.receiptId}` : "receipt_id unavailable"
    ],
    blockers: ["recorded evidence only; not a live RPC profile in this process"]
  };
}

function profileAuthStatus(role: EvidenceRole, rpcUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): EvidenceProfile["auth"] {
  if (!rpcUrl) {
    return role === "gateway" ? "not-required" : "missing";
  }
  const auth = role === "payer"
    ? env.FIBER_PAYER_RPC_AUTH ?? env.FIBER_RPC_AUTH
    : env.FIBER_PAYEE_RPC_AUTH ?? env.FIBER_RPC_AUTH;
  if (auth) {
    return "present";
  }
  return isPrivateRpcUrl(rpcUrl) ? "private-rpc" : "missing";
}

function buildEnvTemplate(resource: EvidenceResource, env: NodeJS.ProcessEnv = process.env): string {
  const lines = [
    "RUN_FIBER_E2E=1",
    `FIBER_MODE=${env.FIBER_MODE === "local" ? "local" : "testnet"}`,
    `FIBER_PAYER_RPC_URL=${env.FIBER_PAYER_RPC_URL ?? "<payer-fnn-rpc-url>"}`,
    `FIBER_PAYEE_RPC_URL=${env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL ?? "<payee-fnn-rpc-url>"}`,
    `FIBER_PAID_HTTP_SECRET=${paidHttpSecret(env) ? "<present; not exported>" : "<32+ character random secret>"}`,
    `FIBER_E2E_AMOUNT_SHANNONS=${resource.fiberAmountShannons}`
  ];
  if (env.FIBER_ROUTER_RPC_URL) {
    lines.splice(4, 0, `FIBER_ROUTER_RPC_URL=${env.FIBER_ROUTER_RPC_URL}`);
  }
  if (env.FIBER_CURRENCY) {
    lines.push(`FIBER_CURRENCY=${env.FIBER_CURRENCY}`);
  }
  return lines.join("\n");
}

async function buildFiberBootstrapRole(
  role: "payer" | "payee",
  evidenceAvailable: boolean,
  env: NodeJS.ProcessEnv = process.env,
  source: "env" | "runtime" = "env"
): Promise<BootstrapRoleStatus> {
  const roleLabel = role === "payer" ? "Payer FNN" : "Payee FNN";
  const envPrefix = role === "payer" ? "PAYER" : "PAYEE";
  const rpcUrl = role === "payer"
    ? env.FIBER_PAYER_RPC_URL ?? env.FIBER_RPC_URL
    : env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
  const rpcAuth = role === "payer"
    ? env.FIBER_PAYER_RPC_AUTH ?? env.FIBER_RPC_AUTH
    : env.FIBER_PAYEE_RPC_AUTH ?? env.FIBER_RPC_AUTH;
  const mode = env.FIBER_MODE;
  const checkSource = source === "runtime" ? "runtime" : "env";
  const checks: BootstrapCheck[] = [
    check("mode", "Fiber mode", mode ?? null, mode === "local" || mode === "testnet", checkSource),
    check("execution", "Live execution flag", env.RUN_FIBER_E2E === "1", env.RUN_FIBER_E2E === "1", checkSource),
    check("rpc_url", `${roleLabel} RPC URL`, rpcUrl ?? null, Boolean(rpcUrl), checkSource),
    authCheck("rpc_auth", `${roleLabel} RPC auth`, rpcUrl, rpcAuth, checkSource)
  ];
  const blockers: string[] = [];
  if (mode !== "local" && mode !== "testnet") {
    blockers.push("set FIBER_MODE=local or FIBER_MODE=testnet");
  }
  if (env.RUN_FIBER_E2E !== "1") {
    blockers.push("set RUN_FIBER_E2E=1 for live local/testnet execution");
  }
  if (!rpcUrl) {
    blockers.push(`set FIBER_${envPrefix}_RPC_URL${role === "payee" ? " or FIBER_RPC_URL" : ""}`);
  }
  if (rpcUrl && !rpcAuth && !isPrivateRpcUrl(rpcUrl)) {
    blockers.push(`set FIBER_${envPrefix}_RPC_AUTH or keep ${roleLabel} RPC private`);
  }

  if (rpcUrl && (mode === "local" || mode === "testnet")) {
    const probe = await probeFiberNode(role, rpcUrl, rpcAuth);
    checks.push(...probe.checks);
    blockers.push(...probe.blockers);
  }

  return finalizeBootstrapRole({
    role,
    title: roleLabel,
    source,
    rpcUrl,
    checks,
    blockers,
    evidenceAvailable,
    readySummary: `${roleLabel} RPC, peers, and ChannelReady liquidity are available`,
    evidenceSummary: `${roleLabel} not live in this process; recorded Fiber E2E evidence exists`,
    blockedSummary: `${roleLabel} bootstrap is incomplete`
  });
}

function buildGatewayBootstrapRole(
  liveReady: boolean,
  evidence: ProductionBootstrap["evidence"],
  canonicalData: unknown,
  env: NodeJS.ProcessEnv = process.env,
  source: "env" | "runtime" = "env"
): BootstrapRoleStatus {
  const canonical = canonicalData as Record<string, unknown> | undefined;
  const secretPresent = Boolean(paidHttpSecret(env) && paidHttpSecret(env)!.length >= 32);
  const payeeRpcUrl = env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
  const checkSource = source === "runtime" ? "runtime" : "env";
  const checks: BootstrapCheck[] = [
    check("mode", "Fiber mode", env.FIBER_MODE ?? null, env.FIBER_MODE === "local" || env.FIBER_MODE === "testnet", checkSource),
    check("payee_rpc_url", "Payee RPC URL", payeeRpcUrl ?? null, Boolean(payeeRpcUrl), checkSource),
    check("secret", "Receipt signing secret", secretPresent ? "present" : "missing", secretPresent, checkSource),
    check("rust_gateway", "Rust gateway path", Boolean(canonical?.rust_gateway_production_path), Boolean(canonical?.rust_gateway_production_path), "report"),
    check("ops", "Production operations", evidence.productionOperationsReady, evidence.productionOperationsReady, "report"),
    check("testnet", "Testnet Fiber E2E", evidence.testnetFiberE2e, evidence.testnetFiberE2e, "report"),
    check("production_ready", "Production readiness gate", evidence.productionReady, evidence.productionReady, "report")
  ];
  const blockers = [
    ...(liveReady ? [] : ["configure live Fiber env for this gateway process"]),
    ...(secretPresent ? [] : ["set FIBER_PAID_HTTP_SECRET to a random secret of at least 32 characters"]),
    ...(evidence.productionOperationsReady ? [] : ["run production operations gate"]),
    ...(evidence.testnetFiberE2e ? [] : ["run testnet Fiber E2E evidence"]),
    ...(evidence.productionReady ? [] : ["production readiness gate has not passed"])
  ];
  return finalizeBootstrapRole({
    role: "gateway",
    title: "Rust Gateway",
    source,
    rpcUrl: payeeRpcUrl,
    checks,
    blockers,
    evidenceAvailable: evidence.productionReady,
    readySummary: "Gateway live env, operations, and testnet evidence are ready",
    evidenceSummary: "Production evidence passed; live gateway env is not active in this process",
    blockedSummary: "Gateway bootstrap is incomplete"
  });
}

function finalizeBootstrapRole(input: {
  role: BootstrapRoleStatus["role"];
  title: string;
  source: BootstrapRoleStatus["source"];
  rpcUrl?: string;
  checks: BootstrapCheck[];
  blockers: string[];
  evidenceAvailable: boolean;
  readySummary: string;
  evidenceSummary: string;
  blockedSummary: string;
}): BootstrapRoleStatus {
  const status = input.blockers.length === 0 ? "ready" : input.evidenceAvailable ? "evidence" : "blocked";
  return {
    role: input.role,
    title: input.title,
    source: input.source,
    status,
    summary: status === "ready" ? input.readySummary : status === "evidence" ? input.evidenceSummary : input.blockedSummary,
    rpcUrl: input.rpcUrl,
    checks: input.checks,
    blockers: input.blockers,
    nextSteps: bootstrapNextSteps(input.role, input.blockers)
  };
}

async function probeFiberNode(role: "payer" | "payee", rpcUrl: string, rpcAuth?: string): Promise<{ checks: BootstrapCheck[]; blockers: string[] }> {
  const client = new FiberRpcClient({
    url: rpcUrl,
    auth: rpcAuth,
    label: `bootstrap-${role}`,
    fetchImpl: timeoutFetch(1_200)
  });
  const checks: BootstrapCheck[] = [];
  const blockers: string[] = [];
  try {
    const info = await client.nodeInfo();
    checks.push(check("node_info", "RPC node_info", "ok", true, "rpc"));
    checks.push(check("node_version", "Node version", stringValue(field(info, "version")) ?? "unknown", true, "rpc"));
    checks.push(check("node_pubkey", "Node pubkey", shortValue(stringValue(field(info, "pubkey")) ?? stringValue(field(info, "node_id"))), true, "rpc"));
  } catch (error) {
    const message = errorMessage(error);
    checks.push(check("node_info", "RPC node_info", message, false, "rpc"));
    blockers.push(`${role} Fiber RPC node_info failed: ${message}`);
    return { checks, blockers };
  }

  try {
    const peers = namedArray(await client.request("list_peers", []), "peers");
    checks.push(check("peers", "Connected peers", peers.length, peers.length > 0, "rpc"));
    if (peers.length === 0) {
      blockers.push(`${role} Fiber node has no connected peers`);
    }
  } catch (error) {
    const message = errorMessage(error);
    checks.push(check("peers", "Connected peers", `list_peers failed: ${message}`, false, "rpc"));
    blockers.push(`${role} Fiber RPC list_peers failed: ${message}`);
  }

  try {
    const channels = namedArray(await client.listChannels(), "channels");
    const readyCount = channels.filter(isReadyChannel).length;
    checks.push(check("channels", "Channels", channels.length, channels.length > 0, "rpc"));
    checks.push(check("ready_channels", "ChannelReady", readyCount, readyCount > 0, "rpc"));
    checks.push(check("channel_states", "Channel states", summarizeChannelStates(channels), readyCount > 0, "rpc"));
    if (channels.length === 0) {
      blockers.push(`${role} Fiber node has no channels`);
    } else if (readyCount === 0) {
      blockers.push(`${role} Fiber node has no ChannelReady channels`);
    }
  } catch (error) {
    const message = errorMessage(error);
    checks.push(check("channels", "Channels", `list_channels failed: ${message}`, false, "rpc"));
    blockers.push(`${role} Fiber RPC list_channels failed: ${message}`);
  }
  return { checks, blockers };
}

function check(id: string, label: string, value: BootstrapCheck["value"], passed: boolean, source: BootstrapCheck["source"]): BootstrapCheck {
  return {
    id,
    label,
    value,
    status: passed ? "pass" : "fail",
    source
  };
}

function authCheck(
  id: string,
  label: string,
  rpcUrl: string | undefined,
  rpcAuth: string | undefined,
  source: BootstrapCheck["source"] = "env"
): BootstrapCheck {
  if (!rpcUrl) {
    return { id, label, value: null, status: "warn", source };
  }
  if (rpcAuth) {
    return { id, label, value: "present", status: "pass", source };
  }
  return { id, label, value: isPrivateRpcUrl(rpcUrl) ? "loopback/private" : "missing", status: isPrivateRpcUrl(rpcUrl) ? "warn" : "fail", source };
}

function bootstrapNextSteps(role: BootstrapRoleStatus["role"], blockers: string[]): string[] {
  if (blockers.length === 0) {
    return role === "gateway" ? ["run the paid HTTP flow"] : ["run the Fiber Paid HTTP live payment step"];
  }
  if (role === "payer") {
    return ["start or point at a funded payer FNN", "connect peers and wait for ChannelReady", "set FIBER_PAYER_RPC_URL"];
  }
  if (role === "payee") {
    return ["start or point at an invoice/payee FNN", "connect peers and wait for ChannelReady", "set FIBER_PAYEE_RPC_URL"];
  }
  return ["set FIBER_PAID_HTTP_SECRET", "set payee Fiber RPC env", "keep testnet E2E and operations gates green"];
}

function timeoutFetch(timeoutMs: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }) as typeof fetch;
}

function isPrivateRpcUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return isPrivateHost(host);
  } catch {
    return false;
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("10.") || host.startsWith("192.168.");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function envWithLegacy(env: NodeJS.ProcessEnv, primary: string, legacy: string): string | undefined {
  return env[primary] ?? env[legacy];
}

function paidHttpSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envWithLegacy(env, "FIBER_PAID_HTTP_SECRET", "FIBER_MPP_SECRET");
}

function paidHttpChallengeTtlSeconds(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envWithLegacy(env, "FIBER_PAID_HTTP_CHALLENGE_TTL_SECONDS", "FIBER_MPP_CHALLENGE_TTL_SECONDS");
}

function allowedConsoleOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!origin) {
    return undefined;
  }
  const configured = (
    env.FIBER_PAID_HTTP_CONSOLE_ORIGINS ??
    env.FIBER_PAID_HTTP_CONSOLE_ORIGIN ??
    env.FIBER_MPP_CONSOLE_ORIGINS ??
    env.FIBER_MPP_CONSOLE_ORIGIN ??
    ""
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes(origin)) {
    return origin;
  }
  if (origin === "null" && envWithLegacy(env, "FIBER_PAID_HTTP_ALLOW_FILE_ORIGIN", "FIBER_MPP_ALLOW_FILE_ORIGIN") === "1") {
    return origin;
  }
  try {
    const url = new URL(origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname)) {
      return origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shortValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function namedArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const array = (value as Record<string, unknown>)[key];
  return Array.isArray(array) ? array : [];
}

function isReadyChannel(value: unknown): boolean {
  const state = channelStateName(value).replace(/[_\s-]/g, "").toLowerCase();
  return state === "channelready";
}

function summarizeChannelStates(channels: unknown[]): string {
  if (channels.length === 0) {
    return "none";
  }
  const states = new Map<string, number>();
  for (const channel of channels) {
    const state = channelStateName(channel);
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return [...states.entries()].map(([state, count]) => `${state}:${count}`).join(", ");
}

function channelStateName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }
  const channel = value as Record<string, unknown>;
  const state = channel.state;
  if (typeof state === "string") {
    return state;
  }
  if (state && typeof state === "object") {
    const stateName = (state as Record<string, unknown>).state_name;
    return typeof stateName === "string" ? stateName : "unknown";
  }
  return typeof channel.state_name === "string" ? channel.state_name : "unknown";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timeout" : error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : String(error);
  }
  return String(error);
}

async function readRuntimeBootstrapInput(request: Request): Promise<RuntimeBootstrapInput> {
  const body = await request.json().catch(() => undefined) as RuntimeBootstrapInput | undefined;
  return body && typeof body === "object" ? body : {};
}

function assertRuntimeBootstrapAllowed(
  request: Request,
  input: RuntimeBootstrapInput,
  env: NodeJS.ProcessEnv = process.env
): void {
  const requestHost = new URL(request.url).hostname;
  if (!isLoopbackHost(requestHost) && envWithLegacy(env, "FIBER_PAID_HTTP_ALLOW_RUNTIME_BOOTSTRAP", "FIBER_MPP_ALLOW_RUNTIME_BOOTSTRAP") !== "1") {
    throw new RuntimeBootstrapPolicyError("UI runtime bootstrap is disabled on non-loopback API hosts; start the gateway with process env or set FIBER_PAID_HTTP_ALLOW_RUNTIME_BOOTSTRAP=1 intentionally");
  }
  const origin = request.headers.get("origin") ?? undefined;
  if (origin && !allowedConsoleOrigin(origin, env)) {
    throw new RuntimeBootstrapPolicyError(`UI runtime bootstrap rejected origin ${origin}`);
  }
  const confirmed = booleanValue(input.confirmRuntimeBootstrap ?? input.confirmInsecureRuntimeBootstrap, false);
  if (!confirmed) {
    throw new RuntimeBootstrapPolicyError("UI runtime bootstrap requires explicit confirmation because RPC auth and gateway signing state are sent to this API process");
  }
  const authProvided = Boolean(
    optionalRuntimeSecret(input.payerRpcAuth) ||
    optionalRuntimeSecret(input.payeeRpcAuth) ||
    optionalRuntimeSecret(input.rpcAuth)
  );
  if (authProvided && envWithLegacy(env, "FIBER_PAID_HTTP_ALLOW_REMOTE_RUNTIME_RPC_AUTH", "FIBER_MPP_ALLOW_REMOTE_RUNTIME_RPC_AUTH") !== "1") {
    const rpcUrls = [
      stringValue(input.payerRpcUrl),
      stringValue(input.payeeRpcUrl),
      stringValue(input.routerRpcUrl)
    ].filter((value): value is string => Boolean(value));
    const remote = rpcUrls.find((value) => !isPrivateRpcUrl(value));
    if (remote) {
      throw new RuntimeBootstrapPolicyError("UI runtime bootstrap refuses to send RPC auth to non-private Fiber RPC URLs; use process env or set FIBER_PAID_HTTP_ALLOW_REMOTE_RUNTIME_RPC_AUTH=1 intentionally");
    }
  }
}

function buildRuntimeBootstrapSession(input: RuntimeBootstrapInput): RuntimeBootstrapSession {
  const mode = parseFiberMode(stringValue(input.mode) ?? "local");
  const payerRpcUrl = normalizeRuntimeRpcUrl(input.payerRpcUrl, "payerRpcUrl");
  const payeeRpcUrl = normalizeRuntimeRpcUrl(input.payeeRpcUrl, "payeeRpcUrl");
  const routerRpcUrl = normalizeOptionalRuntimeRpcUrl(input.routerRpcUrl, "routerRpcUrl");
  const payerRpcAuth = optionalRuntimeSecret(input.payerRpcAuth);
  const payeeRpcAuth = optionalRuntimeSecret(input.payeeRpcAuth);
  const rpcAuth = optionalRuntimeSecret(input.rpcAuth);
  const amountShannons = normalizeAmountShannons(input.amountShannons ?? process.env.FIBER_E2E_AMOUNT_SHANNONS) ?? "100";
  const challengeTtlSeconds = positiveInteger(input.challengeTtlSeconds ?? paidHttpChallengeTtlSeconds(process.env), 120);
  const settlementTimeoutMs = positiveInteger(input.settlementTimeoutMs ?? process.env.FIBER_SETTLEMENT_TIMEOUT_MS, 30_000);
  const currency = normalizeFiberCurrency(input.currency) ?? process.env.FIBER_CURRENCY ?? (mode === "testnet" ? "Fibt" : "Fibd");
  const existingSecret = paidHttpSecret(process.env);
  const envSecret = existingSecret && existingSecret.length >= 32
    ? existingSecret
    : undefined;
  const generateRuntimeSecret = booleanValue(input.generateRuntimeSecret, false);
  const secret = envSecret ?? (generateRuntimeSecret ? randomBytes(32).toString("hex") : undefined);
  if (!secret) {
    throw new Error("FIBER_PAID_HTTP_SECRET is missing; enable runtime secret generation or set a durable gateway secret in the API process env");
  }
  const enableLive = booleanValue(input.enableLive, true);
  const env: NodeJS.ProcessEnv = {
    RUN_FIBER_E2E: enableLive ? "1" : "0",
    FIBER_MODE: mode,
    FIBER_PAYER_RPC_URL: payerRpcUrl,
    FIBER_PAYEE_RPC_URL: payeeRpcUrl,
    FIBER_E2E_AMOUNT_SHANNONS: amountShannons,
    FIBER_PAID_HTTP_CHALLENGE_TTL_SECONDS: String(challengeTtlSeconds),
    FIBER_SETTLEMENT_TIMEOUT_MS: String(settlementTimeoutMs),
    FIBER_CURRENCY: currency,
    FIBER_ASSET: "CKB",
    FIBER_PAID_HTTP_SECRET: secret
  };
  if (routerRpcUrl) env.FIBER_ROUTER_RPC_URL = routerRpcUrl;
  if (rpcAuth) env.FIBER_RPC_AUTH = rpcAuth;
  if (payerRpcAuth) env.FIBER_PAYER_RPC_AUTH = payerRpcAuth;
  if (payeeRpcAuth) env.FIBER_PAYEE_RPC_AUTH = payeeRpcAuth;
  return {
    configuredAt: new Date().toISOString(),
    env,
    secretGenerated: !envSecret
  };
}

function runtimeBootstrapSummary(
  session: RuntimeBootstrapSession | null,
  env: NodeJS.ProcessEnv,
  bootstrap?: ProductionBootstrap
): RuntimeBootstrapSummary {
  const mode = getEvidenceMode(env);
  const hasEnvConfig = !session && mode.liveReady;
  const configured = Boolean(session) || hasEnvConfig;
  return {
    configured,
    source: session ? "runtime" : hasEnvConfig ? "env" : "unconfigured",
    configuredAt: session?.configuredAt,
    mode: mode.mode,
    payerRpcUrl: env.FIBER_PAYER_RPC_URL,
    payeeRpcUrl: env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL,
    routerRpcUrl: env.FIBER_ROUTER_RPC_URL,
    currency: env.FIBER_CURRENCY,
    amountShannons: env.FIBER_E2E_AMOUNT_SHANNONS,
    secret: paidHttpSecret(env)
      ? session?.secretGenerated
        ? "runtime-generated"
        : "env"
      : "missing",
    auth: {
      payer: profileAuthStatus("payer", env.FIBER_PAYER_RPC_URL, env),
      payee: profileAuthStatus("payee", env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL, env)
    },
    blockers: bootstrap?.roles.flatMap((role) => role.blockers) ?? mode.blockers
  };
}

function normalizeRuntimeRpcUrl(value: unknown, label: string): string {
  const url = normalizeOptionalRuntimeRpcUrl(value, label);
  if (!url) {
    throw new Error(`${label} is required`);
  }
  return url;
}

function normalizeOptionalRuntimeRpcUrl(value: unknown, label: string): string | undefined {
  const text = stringValue(value)?.trim();
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
}

function optionalRuntimeSecret(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  return text || undefined;
}

function normalizeFiberCurrency(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  if (!text) return undefined;
  if (!/^[A-Za-z0-9._:-]{2,24}$/.test(text)) {
    throw new Error("currency must be a short Fiber RPC currency identifier");
  }
  return text;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true" || value === "1") return true;
    if (value.toLowerCase() === "false" || value === "0") return false;
  }
  return fallback;
}

async function readEvidenceActionRequest(request: Request): Promise<EvidenceActionRequest> {
  const body = await request.json().catch(() => undefined) as EvidenceActionRequest | undefined;
  return body && typeof body === "object" ? body : {};
}

function parseJsonBody(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return {};
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function resolveRequestedResource(resources: EvidenceResource[], request: EvidenceActionRequest): EvidenceResource {
  const resource = findResource(resources, stringValue(request.endpoint));
  const amountCkb = normalizeAmountCkb(request.amountCkb);
  const amountShannons = normalizeAmountShannons(
    request.amountShannons ?? (amountCkb ? ckbToShannons(amountCkb) : undefined)
  );
  if (!amountCkb && !amountShannons) {
    return resource;
  }
  const displayValue = amountCkb ?? resource.price.value;
  return {
    ...resource,
    price: {
      value: displayValue,
      currency: "CKB",
      display: `${displayValue} CKB`
    },
    fiberAmountShannons: amountShannons ?? resource.fiberAmountShannons
  };
}

function normalizeProfileSelection(
  request: EvidenceActionRequest,
  fallback: Record<EvidenceRole, string> = {
    payer: "env-payer",
    payee: "env-payee",
    gateway: "env-gateway"
  }
): Record<EvidenceRole, string> {
  return {
    payer: normalizeProfileId(request.payerProfileId, fallback.payer),
    payee: normalizeProfileId(request.payeeProfileId, fallback.payee),
    gateway: normalizeProfileId(request.gatewayProfileId, fallback.gateway)
  };
}

function assertExecutableProfileSelection(selection: Record<EvidenceRole, string>): void {
  const executableProfiles: Record<EvidenceRole, string[]> = {
    payer: ["env-payer", "runtime-payer"],
    payee: ["env-payee", "runtime-payee"],
    gateway: ["env-gateway", "runtime-gateway"]
  };
  for (const [role, profileId] of Object.entries(selection)) {
    const evidenceRole = role as EvidenceRole;
    if (!executableProfiles[evidenceRole].includes(profileId)) {
      throw new Error(
        `${role} profile ${profileId} cannot execute in this process; use ${executableProfiles[evidenceRole].join(" or ")} or export it as recorded evidence`
      );
    }
  }
}

function normalizeProfileId(value: unknown, fallback: string): string {
  const text = stringValue(value);
  if (!text) {
    return fallback;
  }
  if (!/^[a-z0-9][a-z0-9._:-]{0,80}$/i.test(text)) {
    throw new Error(`invalid profile id: ${text}`);
  }
  return text;
}

function normalizeFlowSessionId(value: unknown): string {
  const text = stringValue(value)?.trim();
  if (!text) {
    return "default";
  }
  return /^[a-z0-9][a-z0-9._:-]{0,80}$/i.test(text) ? text : "default";
}

function normalizeAmountCkb(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text)) {
    throw new Error("amountCkb must be a positive CKB decimal with at most 8 decimal places");
  }
  if (ckbToShannons(text) === "0") {
    throw new Error("amountCkb must be greater than zero");
  }
  if (BigInt(ckbToShannons(text)) > 100_000_000_000_000_000n) {
    throw new Error("amountCkb exceeds the console safety limit");
  }
  return text;
}

function normalizeAmountShannons(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw new Error("amountShannons must be a positive integer");
  }
  const amount = BigInt(text);
  if (amount <= 0n) {
    throw new Error("amountShannons must be greater than zero");
  }
  if (amount > 100_000_000_000_000_000n) {
    throw new Error("amountShannons exceeds the console safety limit");
  }
  return amount.toString();
}

function ckbToShannons(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole ?? "0") * 100_000_000n + BigInt(fraction.padEnd(8, "0"))).toString();
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function findResource(resources: EvidenceResource[], endpoint?: string): EvidenceResource {
  return resources.find((resource) => resource.path === endpoint) ?? resources[0]!;
}

function summarizeResource(resource: EvidenceResource): EvidenceResourceSummary {
  return {
    path: resource.path,
    label: resource.label,
    price: resource.price,
    fiberAmountShannons: resource.fiberAmountShannons,
    contentType: resource.contentType
  };
}

function resetFlow(flow: EvidenceFlowState): void {
  for (const key of Object.keys(flow) as Array<keyof EvidenceFlowState>) {
    if (key !== "events") {
      delete flow[key];
    }
  }
  flow.events = [];
}

function appendEvent(flow: EvidenceFlowState, level: FlowEvent["level"], actor: string, message: string, detail?: string): void {
  flow.events.push({
    time: new Date().toISOString(),
    level,
    actor,
    message,
    detail
  });
}

function findFiberChallenge(body: unknown): FiberMethodChallenge | undefined {
  const candidate = body as { challenge?: { methods?: unknown[] } };
  return candidate.challenge?.methods?.find((method): method is FiberMethodChallenge => {
    return Boolean(method && typeof method === "object" && (method as { method?: unknown }).method === "fiber");
  });
}

function getChallengeId(body: unknown): string | undefined {
  const candidate = body as { challengeId?: string; challenge?: { challengeId?: string } };
  return candidate.challengeId ?? candidate.challenge?.challengeId;
}

function challengeReadyBlocker(flow: EvidenceFlowState): string | undefined {
  if (!flow.fiberChallenge || !flow.challengeId || !flow.resourceUrl) {
    return "Send unpaid request before paying with Fiber";
  }
  return undefined;
}

function authorizationReadyBlocker(flow: EvidenceFlowState): string | undefined {
  if (!flow.authorization || !flow.resource || !flow.resourceUrl) {
    return "Pay with Fiber before retrying or replaying the credential";
  }
  return undefined;
}

async function safeJson(response: Response): Promise<unknown> {
  return response.clone().json().catch(async () => response.clone().text());
}

async function safeBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    return response.clone().json();
  }
  return response.clone().text();
}

function exposeHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["www-authenticate", PAYMENT_RECEIPT_HEADER.toLowerCase(), "cache-control", "content-type"]) {
    const value = response.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

function liveFiberNotConfiguredResponse(blockers: string[]): Response {
  return Response.json(
    {
      type: "https://github.com/a19q3/fiber-paid-http/blob/main/docs/fiber-local-e2e.md#live-fiber-not-configured",
      title: "live-fiber-not-configured",
      status: 503,
      blockers
    },
    {
      status: 503,
      headers: { "cache-control": "no-store" }
    }
  );
}

export type ReportReadResult = { name: string; path: string; exists: boolean; data?: unknown; error?: string };

async function readReport(name: keyof typeof reportFiles): Promise<ReportReadResult> {
  const relativePath = reportFiles[name];
  const absolutePath = resolve(repoRoot, relativePath);
  try {
    return {
      name,
      path: relativePath,
      exists: true,
      data: JSON.parse(await readFile(absolutePath, "utf8"))
    };
  } catch (error) {
    return {
      name,
      path: relativePath,
      exists: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function deriveProductionEvidence(reports: {
  canonical: ReportReadResult;
  fiberTestnet: ReportReadResult;
  gate: ReportReadResult;
  gateDefault: ReportReadResult;
  gateLocal: ReportReadResult;
  rustGate: ReportReadResult;
  tsGate: ReportReadResult;
  productionBootstrap: ReportReadResult;
  productionOps: ReportReadResult;
}): ProductionBootstrap["evidence"] {
  const localClaims = booleanClaims([reports.gateLocal], "live_fiber_local_e2e");
  const testnetClaims = booleanClaims([
    reports.fiberTestnet,
    reports.gate,
    reports.gateDefault,
    reports.rustGate,
    reports.tsGate,
    reports.canonical
  ], "testnet_fiber_e2e");
  const productionClaims = booleanClaims([
    reports.canonical,
    reports.fiberTestnet,
    reports.gate,
    reports.gateDefault,
    reports.rustGate,
    reports.tsGate,
    reports.productionOps
  ], "production_ready_for_fiber_method");
  const productionBootstrapClaims = booleanClaims([
    reports.canonical,
    reports.gate,
    reports.gateDefault,
    reports.rustGate,
    reports.tsGate,
    reports.productionOps
  ], "production_bootstrap_e2e");
  const gateReadyClaims = booleanClaims([
    reports.gate,
    reports.gateDefault,
    reports.tsGate
  ], "fiber_paid_http_gate_ready");
  const productionOpsReady = booleanField(reports.productionOps, "production_ops_ready") === true;
  const conflicts = [
    ...claimConflictMessages("live_fiber_local_e2e", localClaims),
    ...claimConflictMessages("testnet_fiber_e2e", testnetClaims),
    ...claimConflictMessages("production_ready_for_fiber_method", productionClaims),
    ...claimConflictMessages("production_bootstrap_e2e", productionBootstrapClaims),
    ...claimConflictMessages("fiber_paid_http_gate_ready", gateReadyClaims)
  ];
  const localFiberE2e = anyTrue(localClaims) && !hasBooleanConflict(localClaims);
  const preservedTestnetEvidence = fiberTestnetEvidence(reports.fiberTestnet);
  const testnetFiberE2e = preservedTestnetEvidence.passed;
  const productionBootstrapReady = anyTrue(productionBootstrapClaims) && !hasBooleanConflict(productionBootstrapClaims);
  const gateBlockers = stringArrayField(reports.gate, "fiber_paid_http_gate_blockers");
  const productionReady = testnetFiberE2e && productionOpsReady && productionBootstrapReady;
  const gateReady = productionReady || (anyTrue(gateReadyClaims) && !hasBooleanConflict(gateReadyClaims));
  return {
    localFiberE2e,
    testnetFiberE2e,
    productionOperationsReady: productionOpsReady,
    productionBootstrapReady,
    productionReady,
    gateReady,
    gateBlockers,
    paymentHash: preservedTestnetEvidence.paymentHash,
    receiptId: preservedTestnetEvidence.receiptId,
    sources: {
      localFiberE2e: localClaims,
      testnetFiberE2e: testnetClaims,
      productionOperationsReady: claimSources([reports.productionOps], "production_ops_ready"),
      productionBootstrapReady: productionBootstrapClaims,
      productionReady: productionClaims,
      gateReady: gateReadyClaims
    },
    conflicts
  };
}

function fiberTestnetEvidence(report: ReportReadResult): { passed: boolean; paymentHash?: string; receiptId?: string } {
  const data = report.data && typeof report.data === "object" ? report.data as Record<string, unknown> : {};
  const result = data.fiber_e2e_result && typeof data.fiber_e2e_result === "object"
    ? data.fiber_e2e_result as Record<string, unknown>
    : data;
  const gate = data.gate_report && typeof data.gate_report === "object"
    ? data.gate_report as Record<string, unknown>
    : data;
  const paymentHash = stringValue(result.fiber_e2e_payment_hash) || stringValue(gate.fiber_e2e_payment_hash);
  const receiptId = stringValue(result.fiber_e2e_receipt_id) || stringValue(gate.fiber_e2e_receipt_id);
  const resultBlockers = Array.isArray(result.fiber_e2e_blockers) ? result.fiber_e2e_blockers : [];
  const gateBlockers = Array.isArray(gate.fiber_e2e_blockers) ? gate.fiber_e2e_blockers : [];
  const passed = (
    (typeof data.status === "undefined" || data.status === "passed") &&
    (typeof data.gate_exit === "undefined" || data.gate_exit === 0) &&
    (result.fiber_preflight_test_loaded === true || gate.fiber_preflight_test_loaded === true) &&
    (result.fiber_live_test_selected === true || gate.fiber_live_test_selected === true) &&
    (result.fiber_e2e_mode === "testnet" || gate.fiber_e2e_mode === "testnet") &&
    (result.fiber_e2e_status === "passed" || gate.fiber_e2e_status === "passed") &&
    (result.fiber_live_test_loaded === true || gate.fiber_live_test_loaded === true) &&
    (result.testnet_fiber_e2e === true || gate.testnet_fiber_e2e === true) &&
    (result.live_fiber_testnet_e2e === true || gate.live_fiber_testnet_e2e === true) &&
    (result.testnet_fiber_e2e_evidence === true || gate.testnet_fiber_e2e_evidence === true) &&
    resultBlockers.length === 0 &&
    gateBlockers.length === 0 &&
    /^0x[0-9a-fA-F]{64}$/.test(paymentHash ?? "") &&
    /^rcpt_[a-z0-9]+$/i.test(receiptId ?? "")
  );
  return {
    passed,
    paymentHash: passed ? paymentHash : undefined,
    receiptId: passed ? receiptId : undefined
  };
}

function booleanClaims(reports: ReportReadResult[], fieldName: string): Array<{ path: string; value: boolean }> {
  return claimSources(reports, fieldName).filter((claim): claim is { path: string; value: boolean } => typeof claim.value === "boolean");
}

function claimSources(reports: ReportReadResult[], fieldName: string): Array<{ path: string; value: unknown }> {
  return reports.flatMap((report) => {
    const value = reportField(report, fieldName);
    return typeof value === "undefined" ? [] : [{ path: report.path, value }];
  });
}

function hasBooleanConflict(claims: Array<{ value: boolean }>): boolean {
  return claims.some((claim) => claim.value === true) && claims.some((claim) => claim.value === false);
}

function anyTrue(claims: Array<{ value: boolean }>): boolean {
  return claims.some((claim) => claim.value === true);
}

function claimConflictMessages(fieldName: string, claims: Array<{ path: string; value: boolean }>): string[] {
  if (!hasBooleanConflict(claims)) {
    return [];
  }
  const values = claims.map((claim) => `${claim.path}=${claim.value}`).join(", ");
  return [`conflicting ${fieldName} claims: ${values}`];
}

function booleanField(report: ReportReadResult, fieldName: string): boolean | undefined {
  const value = reportField(report, fieldName);
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayField(report: ReportReadResult, fieldName: string): string[] {
  const value = reportField(report, fieldName);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function reportField(report: ReportReadResult, fieldName: string): unknown {
  return report.data && typeof report.data === "object" ? (report.data as Record<string, unknown>)[fieldName] : undefined;
}

function summarizeReport(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const report = data as Record<string, unknown>;
  return {
    production_ready_for_fiber_method: report.production_ready_for_fiber_method,
    fiber_paid_http_gate_ready: report.fiber_paid_http_gate_ready,
    fiber_paid_http_gate_blockers: report.fiber_paid_http_gate_blockers,
    evidence_console_layout: report.evidence_console_layout,
    evidence_console_layout_blockers: report.evidence_console_layout_blockers,
    production_bootstrap_e2e: report.production_bootstrap_e2e,
    production_bootstrap_e2e_blockers: report.production_bootstrap_e2e_blockers,
    fiber_e2e_status: report.fiber_e2e_status,
    live_fiber_local_e2e: report.live_fiber_local_e2e,
    rust_canonical_verifier: report.rust_canonical_verifier,
    typescript_vector_harness: report.typescript_vector_harness,
    typescript_trusted_boundary: report.typescript_trusted_boundary,
    shared_vectors_total: report.shared_vectors_total,
    shared_vectors_passed_rust: report.shared_vectors_passed_rust,
    shared_vectors_passed_typescript_harness: report.shared_vectors_passed_typescript_harness,
    f402_parity: report.f402_parity,
    canonical_hash_parity: report.canonical_hash_parity,
    error_code_parity: report.error_code_parity,
    fiber_commit: report.fiber_commit,
    fiber_e2e_payment_hash: report.fiber_e2e_payment_hash ?? report.payment_hash,
    fiber_e2e_receipt_id: report.fiber_e2e_receipt_id ?? report.receipt_id,
    production_blockers: report.production_blockers
  };
}

function preview(value: string): string {
  if (value.length <= 28) {
    return value;
  }
  return `${value.slice(0, 14)}...${value.slice(-10)}`;
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
