#!/usr/bin/env node
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { startDemoApi } from "@fiber-mpp/demo-api";
import {
  resourceHash,
  verifyReceiptSignature,
  type PaymentReceipt
} from "@fiber-mpp/core";
import { paidFetch, inspectChallenge } from "@fiber-mpp/client";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { F402ChallengeSchema, f402ChallengeToMpp, f402ProofToCredential } from "@fiber-mpp/f402-compat";
import { createFiberMppMiddleware, createReverseProxyHandler } from "@fiber-mpp/server-middleware";
import { SqliteStore } from "@fiber-mpp/storage";
import {
  BootstrapError,
  buildBootstrapReport,
  fiberEnvFromGatewayConfig,
  parseGatewayConfig,
  resolveGatewayConfig,
  writeGatewayConfigTemplate,
  type BootstrapRole,
  type GatewayConfig,
  type ResolvedGatewayConfig
} from "./bootstrap.js";
import { generateVectors, verifyVectors } from "./vectors.js";

const program = new Command();

program
  .name("fiber-mpp")
  .description("Fiber payment method tooling for Machine Payments Protocol")
  .version("0.1.0")
  .option("--engine <engine>", "execution engine", "typescript")
  .hook("preAction", (command) => {
    const engine = command.opts<{ engine: string }>().engine;
    if (engine !== "typescript") {
      throw new Error("The TypeScript CLI only supports --engine typescript. Use fiber-mpp-rs for the Rust engine.");
    }
  });

program
  .command("serve")
  .option("--config <path>", "gateway config JSON")
  .option("--upstream <url>", "upstream server URL")
  .option("--price-usd <amount>", "USD price")
  .option("--methods <methods>", "comma-separated methods")
  .option("--storage <uri>", "sqlite://path")
  .option("--port <port>", "port")
  .option("--server-id <id>", "server id")
  .description("Run FiberMPP as a reverse proxy in front of an upstream HTTP service")
  .action(async (opts: { config?: string; upstream?: string; priceUsd?: string; methods?: string; storage?: string; port?: string; serverId?: string }) => {
    const config = opts.config ? parseGatewayConfig(await readJson(opts.config)) : undefined;
    const resolved = resolveGatewayConfig({ ...opts, config }, process.env);
    await assertGatewayRpcReady(resolved);
    startGateway(resolved);
  });

program
  .command("init")
  .option("--role <role>", "bootstrap role", "gateway")
  .option("--out <path>", "config output path", "fiber-mpp.gateway.json")
  .description("Write a FiberMPP bootstrap config template")
  .action(async (opts: { role: string; out: string }) => {
    const role = parseRole(opts.role);
    if (role !== "gateway") {
      throw new Error("Only `fiber-mpp init --role gateway` is supported");
    }
    await writeGatewayConfigTemplate(opts.out);
    console.log(JSON.stringify({
      role,
      written: opts.out,
      secret: "export FIBER_MPP_SECRET=$(openssl rand -hex 32)",
      next_steps: [
        `edit ${opts.out}`,
        `fiber-mpp doctor --role gateway --config ${opts.out}`,
        `fiber-mpp serve --config ${opts.out}`
      ]
    }, null, 2));
  });

program
  .command("refs")
  .argument("<action>", "init")
  .description("Create or refresh local reference notes")
  .action(async (action: string) => {
    if (action !== "init") {
      throw new Error("Only `fiber-mpp refs init` is supported");
    }
    const result = await writeReferenceStarterNotes(process.cwd());
    console.log(
      JSON.stringify(
        {
          docs_refs: "initialized",
          written: result.written,
          skipped_existing: result.skipped
        },
        null,
        2
      )
    );
  });

program
  .command("server")
  .option("--config <path>", "config file")
  .option("--port <port>", "port")
  .description("Start the demo API, or start a configured FiberMPP gateway when --config is provided")
  .action(async (opts: { config?: string; port: string }) => {
    if (opts.config) {
      const config = parseGatewayConfig(await readJson(opts.config));
      const resolved = resolveGatewayConfig({ config, port: opts.port }, process.env);
      await assertGatewayRpcReady(resolved);
      startGateway(resolved);
      return;
    }
    startDemoApi(Number(opts.port ?? "8787"));
  });

program
  .command("challenge")
  .argument("<action>", "inspect")
  .argument("<url>")
  .description("Inspect an MPP 402 challenge")
  .action(async (action: string, url: string) => {
    if (action !== "inspect") {
      throw new Error("Only `fiber-mpp challenge inspect <url>` is supported");
    }
    const signed = await inspectChallenge(url);
    console.log(JSON.stringify(signed, null, 2));
  });

program
  .command("pay")
  .argument("<url>")
  .option("--method <method>", "payment method", "fiber")
  .description("Pay an MPP endpoint and print the response")
  .action(async (url: string, opts: { method: string }) => {
    if (opts.method !== "fiber") {
      throw new Error("Only --method fiber is implemented");
    }
    const report = buildBootstrapReport("payer");
    if (report.status === "blocked") {
      throw new BootstrapError(report);
    }
    const result = await paidFetch(url, {}, { fiber: FiberMethodAdapter.fromEnv(process.env, "payer") });
    console.log(
      JSON.stringify(
        {
          status: result.response.status,
          receipt: result.receipt,
          body: await result.response.text()
        },
        null,
        2
      )
    );
  });

program
  .command("f402")
  .argument("<action>", "convert")
  .argument("<file>")
  .description("Convert F402 challenge/proof JSON to FiberMPP shapes")
  .action(async (action: string, file: string) => {
    if (action !== "convert") {
      throw new Error("Only `fiber-mpp f402 convert <file>` is supported");
    }
    const f402 = F402ChallengeSchema.parse(await readJson(file));
    const resource = {
      method: "GET",
      url: typeof f402.resource === "string" ? f402.resource : "http://f402.local/compat"
    };
    const challenge = f402ChallengeToMpp({
      f402,
      resource,
      serverId: "fiber-mpp-cli"
    });
    const credential = f402ProofToCredential({
      proof: {
        paymentHash: f402.paymentHash,
        invoice: f402.invoice,
        amountShannons: f402.amount,
        mode: process.env.FIBER_MODE === "testnet" ? "testnet" : "local",
        status: "settled",
        token: f402.token
      },
      challengeId: challenge.challengeId,
      resourceHash: resourceHash(resource)
    });
    console.log(JSON.stringify({ challenge, credential }, null, 2));
  });

program
  .command("receipt")
  .argument("<action>", "verify")
  .argument("<file>")
  .option("--secret <secret>", "receipt HMAC secret")
  .description("Verify a Payment-Receipt JSON file")
  .action(async (action: string, file: string, opts: { secret?: string }) => {
    if (action !== "verify") {
      throw new Error("Only `fiber-mpp receipt verify <receipt.json>` is supported");
    }
    const receipt = (await readJson(file)) as PaymentReceipt;
    const secret = opts.secret ?? process.env.FIBER_MPP_SECRET;
    if (!secret) {
      throw new Error("Provide --secret or FIBER_MPP_SECRET");
    }
    console.log(JSON.stringify({ valid: verifyReceiptSignature(receipt, secret) }, null, 2));
  });

program
  .command("vectors")
  .argument("<action>", "generate|verify")
  .description("Generate or verify canonical FiberMPP conformance vectors")
  .action(async (action: string) => {
    if (action === "generate") {
      await generateVectors();
      return;
    }
    if (action === "verify") {
      await verifyVectors();
      return;
    }
    throw new Error("Use `fiber-mpp vectors generate` or `fiber-mpp vectors verify`");
  });

program
  .command("doctor")
  .argument("[url]")
  .option("--role <role>", "payer|payee|gateway")
  .option("--config <path>", "gateway config JSON")
  .description("Report FiberMPP bootstrap readiness")
  .action(async (url: string | undefined, opts: { role?: string; config?: string }) => {
    const role = parseRole(opts.role ?? (url ? "payer" : "gateway"));
    const config = opts.config ? parseGatewayConfig(await readJson(opts.config)) : undefined;
    const report = await doctorReport(role, config);
    const output: Record<string, unknown> = { ...report };
    if (url) {
      output.target_url = url;
    }
    if (url && role === "payer" && report.status === "ready") {
      const challenge = await inspectChallenge(url);
      output.challenge = challenge;
      const result = await paidFetch(url, {}, { fiber: FiberMethodAdapter.fromEnv(process.env, "payer") });
      output.responseStatus = result.response.status;
      output.receiptPresent = Boolean(result.receipt);
    }
    console.log(JSON.stringify(output, null, 2));
  });

program
  .command("demo")
  .argument("<action>", "start")
  .option("--port <port>", "port", "8787")
  .description("Start the FiberMPP live evidence API")
  .action(async (action: string, opts: { port: string }) => {
    if (action === "start") {
      startDemoApi(Number(opts.port));
      return;
    }
    throw new Error("Use `fiber-mpp demo start`");
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof BootstrapError) {
    console.error(JSON.stringify(error.report, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as Record<string, unknown>;
}

function startGateway(config: ResolvedGatewayConfig): void {
  if (!config.storage.startsWith("sqlite://")) {
    throw new Error("fiber-mpp gateway requires storage sqlite://path");
  }
  const store = new SqliteStore(config.storage.slice("sqlite://".length));
  const middleware = createFiberMppMiddleware({
    secret: config.secret,
    serverId: config.serverId,
    store,
    fiber: FiberMethodAdapter.fromEnv(config.fiberEnv, "payee")
  });
  const handler = createReverseProxyHandler(middleware, {
    upstream: config.upstream,
    price: config.price,
    methods: config.methods as never
  });
  createServer(async (req, res) => {
    try {
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      await sendWebResponse(res, await handler(await nodeRequestToWeb(req)));
    } catch (error) {
      res.writeHead(500, { ...corsHeaders(), "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  }).listen(config.port, () => {
    console.log(`FiberMPP reverse proxy listening on http://localhost:${config.port}`);
    console.log(`Server ID: ${config.serverId}`);
    console.log(`Upstream: ${config.upstream}`);
    console.log(`Storage: ${config.storage}`);
  });
}

async function doctorReport(role: BootstrapRole, config: GatewayConfig | undefined) {
  if (role === "gateway") {
    const fiberEnv = fiberEnvFromGatewayConfig(config, process.env);
    const methods = config?.methods ?? ["fiber"];
    const report = buildBootstrapReport(role, {
      env: fiberEnv,
      secret: process.env[config?.secret_env ?? "FIBER_MPP_SECRET"],
      secretEnv: config?.secret_env ?? "FIBER_MPP_SECRET",
      storage: config?.storage ?? "sqlite://./fiber-mpp.sqlite",
      upstream: config?.upstream,
      methods
    });
    return probeIfStructurallyReady(report, fiberEnv, "payee");
  }
  const report = buildBootstrapReport(role);
  return probeIfStructurallyReady(report, process.env, role);
}

function parseRole(value: string): BootstrapRole {
  if (value === "payer" || value === "payee" || value === "gateway") {
    return value;
  }
  throw new Error("role must be payer, payee, or gateway");
}

async function assertGatewayRpcReady(config: ResolvedGatewayConfig): Promise<void> {
  const report = await probeIfStructurallyReady(buildBootstrapReport("gateway", {
    env: config.fiberEnv,
    secret: config.secret,
    storage: config.storage,
    upstream: config.upstream,
    methods: config.methods
  }), config.fiberEnv, "payee");
  if (report.status === "blocked") {
    throw new BootstrapError(report);
  }
}

async function probeIfStructurallyReady(
  report: ReturnType<typeof buildBootstrapReport>,
  env: NodeJS.ProcessEnv,
  role: "payer" | "payee" | "gateway"
) {
  if (report.status === "blocked") {
    return report;
  }
  const rpcUrl = role === "payer" ? env.FIBER_PAYER_RPC_URL ?? env.FIBER_RPC_URL : env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
  const rpcAuth = role === "payer" ? env.FIBER_PAYER_RPC_AUTH ?? env.FIBER_RPC_AUTH : env.FIBER_PAYEE_RPC_AUTH ?? env.FIBER_RPC_AUTH;
  if (!rpcUrl) {
    return report;
  }
  const probe = await probeFiberNodeInfo(rpcUrl, rpcAuth);
  report.checks.rpc_probe = probe.ok ? "node_info ok" : probe.error;
  if (!probe.ok) {
    report.status = "blocked";
    report.blockers.push(`${role === "payer" ? "payer" : "payee"} Fiber RPC node_info failed: ${probe.error}`);
    const retryRole = role === "gateway" ? "gateway" : role;
    report.next_steps = [
      "start the required Fiber node",
      "check the RPC URL and Authorization header",
      `retry fiber-mpp doctor --role ${retryRole}`
    ];
  }
  return report;
}

async function probeFiberNodeInfo(url: string, auth?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (auth) {
      headers.set("authorization", auth);
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "fiber-mpp-doctor",
        method: "node_info",
        params: []
      })
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json() as { error?: { message?: string } };
    if (payload.error) {
      return { ok: false, error: payload.error.message ?? JSON.stringify(payload.error) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeReferenceStarterNotes(cwd: string): Promise<{ written: string[]; skipped: string[] }> {
  const files = new Map<string, string>([
    ["docs/refs/README.md", "# FiberMPP Reference Index\n\nReference notes for FiberMPP protocol, Fiber RPC, F402/L402 compatibility, and security boundaries.\n"],
    ["docs/refs/fiber.md", "# Fiber References\n\nTrack Fiber JSON-RPC invoice creation, payment sending, invoice status, payment status, and settlement semantics used by FiberMPP.\n"],
    ["docs/refs/mpp.md", "# MPP References\n\nTrack the HTTP 402 challenge, credential, receipt, replay, and resource-binding lifecycle used by FiberMPP.\n"],
    ["docs/refs/infern.md", "# Infern / F402 References\n\nTrack F402 compatibility boundaries and integration assumptions for Fiber-backed paid access flows.\n"],
    ["docs/refs/l402.md", "# L402 References\n\nTrack macaroon, preimage, and paid-access precedent relevant to Authorization-bound receipts.\n"],
    ["docs/refs/security.md", "# Security References\n\nTrack replay, wrong-resource, wrong-method, wrong-amount, expired-challenge, paid-but-denied, and unpaid-service attack coverage.\n"]
  ]);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [file, contents] of files) {
    const path = resolve(cwd, file);
    await mkdir(dirname(path), { recursive: true });
    if (await pathExists(path)) {
      skipped.push(file);
      continue;
    }
    await writeFile(path, contents);
    written.push(file);
  }
  return { written, skipped };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function nodeRequestToWeb(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value) {
      headers.set(key, value);
    }
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Request(url, {
    method,
    headers,
    body: Buffer.concat(chunks)
  });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = corsHeaders();
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-expose-headers": "payment-receipt, www-authenticate"
  };
}
