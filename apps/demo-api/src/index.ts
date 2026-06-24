import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
} from "@fiber-mpp/core";
import { FiberMethodAdapter, parseFiberMode } from "@fiber-mpp/fiber-method";
import { createFiberMppMiddleware, type FiberMppMiddleware, type FiberMppMiddlewareConfig } from "@fiber-mpp/server-middleware";
import { SqliteStore } from "@fiber-mpp/storage";

export type EvidenceApiOptions = Partial<FiberMppMiddlewareConfig> & {
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

type FlowEvent = {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  actor: string;
  message: string;
  detail?: string;
};

type EvidenceFlowState = {
  endpoint?: string;
  resource?: EvidenceResourceSummary;
  resourceUrl?: string;
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
  events: FlowEvent[];
};

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const evidenceDbPath = resolve(repoRoot, ".tmp/fiber-mpp-evidence-api.sqlite");
const reportFiles = {
  canonical: "reports/canonical-core-parity.json",
  fiberLocal: "reports/fiber-local-e2e-evidence.json",
  gateLocal: "reports/fiber-mpp-gate.local.json",
  gateDefault: "reports/fiber-mpp-gate.default.json",
  rustGate: "reports/fiber-mpp-rust-gate.json",
  tsGate: "reports/fiber-mpp-ts-gate.json",
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
      tool: "fiber_mpp.echo",
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
  const runtime = createFiberRuntime(options);

  const resources = defaultResources.map((resource) => ({
    ...resource,
    price: options.price ?? resource.price,
    fiberAmountShannons: options.fiberAmountShannons ?? resource.fiberAmountShannons
  }));
  const flow: EvidenceFlowState = { events: [] };

  app.use("*", async (c, next) => {
    await next();
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "authorization, content-type");
    c.header("access-control-expose-headers", "payment-receipt, www-authenticate");
  });

  app.options("*", (c) =>
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS"
      }
    })
  );

  app.get("/free", (c) =>
    c.json({
      ok: true,
      message: "free FiberMPP evidence route"
    })
  );

  for (const resource of resources) {
    app.get(resource.path, async (c) => protectResource(resource)(c.req.raw));
  }

  app.get("/api/status", async (c) => {
    const [canonical, fiberLocal, gateDefault, gateLocal, rustGate, tsGate] = await Promise.all([
      readReport("canonical"),
      readReport("fiberLocal"),
      readReport("gateDefault"),
      readReport("gateLocal"),
      readReport("rustGate"),
      readReport("tsGate")
    ]);
    const mode = getEvidenceMode();
    const localEvidence = Boolean((gateLocal.data as { live_fiber_local_e2e?: boolean } | undefined)?.live_fiber_local_e2e);
    const networkStatus = mode.liveReady ? "connected" : localEvidence ? "evidence" : "unconfigured";
    const routeContext = buildRouteContext(mode.liveReady, localEvidence, networkStatus);
    c.header("cache-control", "no-store");
    return c.json({
      name: "FiberMPP Evidence Console",
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
        localFiberE2e: Boolean((gateLocal.data as { live_fiber_local_e2e?: boolean } | undefined)?.live_fiber_local_e2e),
        f402Compatibility: Boolean((canonical.data as { f402_parity?: boolean } | undefined)?.f402_parity),
        productionReady: Boolean(
          (canonical.data as { production_ready_for_fiber_method?: boolean } | undefined)?.production_ready_for_fiber_method
        )
      },
      engine: {
        canonical: "rust",
        typescriptRole: "compatibility tooling",
        typescriptTrustedBoundary: false
      },
      reports: {
        canonical: summarizeReport(canonical.data),
        fiberLocal: summarizeReport(fiberLocal.data),
        gateDefault: summarizeReport(gateDefault.data),
        gateLocal: summarizeReport(gateLocal.data),
        rustGate: summarizeReport(rustGate.data),
        tsGate: summarizeReport(tsGate.data)
      },
      flow
    });
  });

  app.post("/api/evidence/unpaid", async (c) => {
    resetFlow(flow);
    const resource = findResource(resources, await readEndpoint(c.req.raw));
    const resourceUrl = new URL(resource.path, c.req.url).toString();
    flow.endpoint = resource.path;
    flow.resource = summarizeResource(resource);
    flow.resourceUrl = resourceUrl;
    appendEvent(flow, "INFO", "client", `GET ${resource.path}`, `amount=${resource.fiberAmountShannons} CKB`);
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
    if (!runtime) {
      appendEvent(flow, "ERROR", "server", "live Fiber not configured", "payment step unavailable");
      return c.json({ error: "live-fiber-not-configured", flow }, 503);
    }
    assertChallengeReady(flow);
    appendEvent(flow, "INFO", "node1 (payer)", "send_payment", `payment_hash=${flow.fiberChallenge!.paymentHash}`);
    const proof = await runtime.payerFiber.payChallenge(flow.fiberChallenge!);
    flow.proof = proof;
    flow.credential = {
      domain: "fiber-mpp-credential-v1",
      challengeId: flow.challengeId!,
      method: "fiber",
      resourceHash: await resourceHashFromRequest(new Request(flow.resourceUrl!)),
      paymentProof: proof,
      submittedAt: new Date().toISOString()
    };
    flow.authorization = buildAuthorizationPaymentHeader(flow.credential);
    appendEvent(flow, "INFO", "node2 (router)", "forward payment", "route=node1->node2->node3");
    appendEvent(flow, "INFO", "node3 (payee)", "payment settled", `status=${String((proof as { status?: unknown }).status ?? "settled")}`);
    return c.json({
      proof,
      credential: flow.credential,
      authorizationPreview: preview(flow.authorization!),
      flow
    });
  });

  app.post("/api/evidence/retry", async (c) => {
    assertAuthorizationReady(flow);
    const resource = findResource(resources, flow.endpoint);
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
    assertAuthorizationReady(flow);
    const resource = findResource(resources, flow.endpoint);
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

  app.post("/api/evidence/reset", (c) => {
    resetFlow(flow);
    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      flow
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

  function protectWithRuntime(route: Parameters<FiberMppMiddleware["protect"]>[0]): (request: Request) => Promise<Response> {
    if (!runtime) {
      return async () => liveFiberNotConfiguredResponse(getEvidenceMode().blockers);
    }
    return runtime.middleware.protect(route);
  }
}

export function startEvidenceApi(port = Number(process.env.PORT ?? "8787")): void {
  const app = createEvidenceApi();
  serve({ fetch: app.fetch, port });
  console.log(`FiberMPP evidence API listening on http://localhost:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startEvidenceApi();
}

function createFiberRuntime(options: EvidenceApiOptions): { middleware: FiberMppMiddleware; payerFiber: FiberMethodAdapter } | null {
  const readiness = getEvidenceMode();
  const hasInjectedAdapters = Boolean(options.fiber && options.payerFiber);
  if (!readiness.liveReady && !hasInjectedAdapters) {
    return null;
  }
  mkdirSync(dirname(evidenceDbPath), { recursive: true });
  const fiber = options.fiber ?? FiberMethodAdapter.fromEnv(process.env, "payee");
  const payerFiber = options.payerFiber ?? FiberMethodAdapter.fromEnv(process.env, "payer");
  const secret = options.secret ?? process.env.FIBER_MPP_SECRET;
  if (!secret) {
    throw new Error("FiberMPP evidence runtime requires FIBER_MPP_SECRET or options.secret");
  }
  const middleware = createFiberMppMiddleware({
    secret,
    serverId: options.serverId ?? "fiber-mpp-evidence-api",
    store: options.store ?? new SqliteStore(evidenceDbPath),
    fiber,
    defaultFiberAmountShannons: options.fiberAmountShannons ?? "1000",
    challengeTtlSeconds: options.challengeTtlSeconds ?? 120,
    clockSkewSeconds: options.clockSkewSeconds ?? 2
  });
  return { middleware, payerFiber };
}

function getEvidenceMode(): { mode: "local" | "testnet" | "unconfigured"; liveReady: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const runRequested = process.env.RUN_FIBER_E2E === "1";
  let mode: "local" | "testnet" | "unconfigured" = "unconfigured";
  try {
    mode = parseFiberMode(process.env.FIBER_MODE);
  } catch {
    blockers.push("Live Fiber mode inactive: set FIBER_MODE=local or FIBER_MODE=testnet");
  }
  if (!runRequested) {
    blockers.push("Live Fiber mode inactive: set RUN_FIBER_E2E=1 for local/testnet execution");
  }
  if (!(process.env.FIBER_PAYEE_RPC_URL ?? process.env.FIBER_RPC_URL)) {
    blockers.push("Live Fiber mode inactive: set FIBER_PAYEE_RPC_URL or FIBER_RPC_URL");
  }
  if (!process.env.FIBER_PAYER_RPC_URL) {
    blockers.push("Live Fiber mode inactive: set FIBER_PAYER_RPC_URL");
  }
  if (!process.env.FIBER_MPP_SECRET || process.env.FIBER_MPP_SECRET.length < 32) {
    blockers.push("Live Fiber mode inactive: set FIBER_MPP_SECRET to a random secret of at least 32 characters");
  }
  const liveReady = blockers.length === 0;
  return { mode, liveReady, blockers };
}

function fiberNodeContext(role: string, rpc: string, status: FiberNodeContext["status"]): FiberNodeContext {
  return { role, rpc, status };
}

function buildRouteContext(liveReady: boolean, localEvidence: boolean, networkStatus: FiberNodeContext["status"]): FiberRouteContext {
  const routeAvailable = liveReady || localEvidence;
  return {
    node1: fiberNodeContext("payer", process.env.FIBER_PAYER_RPC_URL ?? "127.0.0.1:21714", networkStatus),
    node2: fiberNodeContext("router", process.env.FIBER_ROUTER_RPC_URL ?? "127.0.0.1:21715", networkStatus),
    node3: fiberNodeContext("payee", process.env.FIBER_PAYEE_RPC_URL ?? process.env.FIBER_RPC_URL ?? "127.0.0.1:21716", networkStatus),
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

async function readEndpoint(request: Request): Promise<string | undefined> {
  const body = await request.json().catch(() => undefined) as { endpoint?: string } | undefined;
  return body?.endpoint;
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

function assertChallengeReady(flow: EvidenceFlowState): void {
  if (!flow.fiberChallenge || !flow.challengeId || !flow.resourceUrl) {
    throw new Error("Send unpaid request before paying with Fiber");
  }
}

function assertAuthorizationReady(flow: EvidenceFlowState): void {
  if (!flow.authorization || !flow.resource || !flow.resourceUrl) {
    throw new Error("Pay with Fiber before retrying or replaying the credential");
  }
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
      type: "https://fiber-mpp.local/problems/live-fiber-not-configured",
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

async function readReport(name: keyof typeof reportFiles): Promise<{ name: string; path: string; exists: boolean; data?: unknown; error?: string }> {
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

function summarizeReport(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const report = data as Record<string, unknown>;
  return {
    production_ready_for_fiber_method: report.production_ready_for_fiber_method,
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
