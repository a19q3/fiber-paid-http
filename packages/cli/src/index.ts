#!/usr/bin/env node
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import {
  resourceHash,
  verifyReceiptSignatureWithAnySecret,
  type PaymentReceipt,
  type ResourceDescriptor
} from "@fiber-mpp/core";
import { paidFetch, inspectChallenge } from "@fiber-mpp/client";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { F402ChallengeSchema, f402ChallengeToMpp, f402ProofToCredential } from "@fiber-mpp/f402-compat";
import {
  FL402ChallengeSchema,
  FL402ProofSchema,
  fl402ChallengeToMpp,
  fl402ProofToCredential,
  issueFl402Challenge,
  verifyFl402Proof
} from "@fiber-mpp/fl402-compat";
import { createFiberMppMiddleware, createReverseProxyHandler } from "@fiber-mpp/server-middleware";
import {
  SqliteStore,
  auditSqliteReceipts,
  backupSqliteStore,
  checkSqliteStore,
  exportSqliteReceipts,
  listSqliteDeliveryOutcomes,
  restoreSqliteStore
} from "@fiber-mpp/storage";
import {
  BootstrapError,
  buildBootstrapReport,
  fiberEnvFromGatewayConfig,
  gatewayConfigHasLiteralRpcAuth,
  parseGatewayConfig,
  previousSecretsFromGatewayConfig,
  probeFiberRpcReadiness,
  resolveGatewayCorsPolicy,
  resolveGatewayConfig,
  resolveGatewayOperations,
  writeGatewayConfigTemplate,
  type BootstrapRole,
  type GatewayConfig,
  type GatewayCorsPolicy,
  type GatewayOperations,
  type ResolvedGatewayConfig
} from "./bootstrap.js";
import { redactForLog } from "./ops.js";
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
  .option("--price-ckb <amount>", "CKB price")
  .option("--methods <methods>", "comma-separated methods")
  .option("--storage <uri>", "sqlite://path")
  .option("--port <port>", "port")
  .option("--server-id <id>", "server id")
  .description("Run FiberMPP as a reverse proxy in front of an upstream HTTP service")
  .action(async (opts: { config?: string; upstream?: string; priceCkb?: string; methods?: string; storage?: string; port?: string; serverId?: string }) => {
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
  .description("Start a configured FiberMPP gateway")
  .action(async (opts: { config?: string; port?: string }) => {
    if (!opts.config) {
      throw new Error("fiber-mpp server requires --config. Use `fiber-mpp evidence start` for the local evidence API.");
    }
    const config = parseGatewayConfig(await readJson(opts.config));
    const resolved = resolveGatewayConfig({ config, port: opts.port }, process.env);
    await assertGatewayRpcReady(resolved);
    startGateway(resolved);
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
  .command("fl402")
  .argument("<action>", "issue|verify|convert")
  .argument("<file>")
  .option("--root-key <key>", "F-L402 root key; defaults to FIBER_MPP_FL402_ROOT_KEY")
  .option("--server-id <id>", "server id for MPP conversion", "fiber-mpp-cli")
  .description("Issue, verify, or convert F-L402 challenge/proof JSON")
  .action(async (action: string, file: string, opts: { rootKey?: string; serverId: string }) => {
    const input = unwrapVectorInput(await readJson(file));
    const rootKey = opts.rootKey ?? process.env.FIBER_MPP_FL402_ROOT_KEY;
    if (action === "issue") {
      if (!rootKey) {
        throw new Error("fiber-mpp fl402 issue requires --root-key or FIBER_MPP_FL402_ROOT_KEY");
      }
      const resource = fl402Resource(input);
      const challenge = issueFl402Challenge({
        rootKey,
        invoice: stringInput(input, "invoice"),
        paymentHash: stringInput(input, "paymentHash"),
        amount: stringInput(input, "amount"),
        currency: typeof input.currency === "string" ? input.currency : "CKB",
        expiresAt: stringInput(input, "expiresAt"),
        resource,
        challengeId: typeof input.challengeId === "string" ? input.challengeId : undefined,
        issuer: typeof input.issuer === "string" ? input.issuer : opts.serverId,
        fiberNodeId: typeof input.fiberNodeId === "string" ? input.fiberNodeId : undefined,
        hashAlgorithm: input.hashAlgorithm === "sha256" ? "sha256" : "ckb_hash"
      });
      console.log(JSON.stringify({ fl402: challenge }, null, 2));
      return;
    }
    const fl402 = FL402ChallengeSchema.parse(input.fl402 ?? input);
    const proofSource = input.proof && typeof input.proof === "object" ? input.proof : input;
    if (action === "verify") {
      if (!rootKey) {
        throw new Error("fiber-mpp fl402 verify requires --root-key or FIBER_MPP_FL402_ROOT_KEY");
      }
      const proof = FL402ProofSchema.parse(proofSource);
      const payload = verifyFl402Proof({ challenge: fl402, proof, rootKey });
      console.log(JSON.stringify({ valid: true, payload }, null, 2));
      return;
    }
    if (action === "convert") {
      const resource = fl402Resource(input, fl402.resource);
      const challenge = fl402ChallengeToMpp({
        fl402,
        resource,
        serverId: opts.serverId,
        challengeId: fl402.challengeId
      });
      const proof = input.proof && typeof input.proof === "object" ? FL402ProofSchema.parse(input.proof) : null;
      const credential = proof
        ? fl402ProofToCredential({
            proof,
            challengeId: fl402.challengeId ?? challenge.challengeId,
            resourceHash: resourceHash(resource)
          })
        : undefined;
      console.log(JSON.stringify({ challenge, ...(credential ? { credential } : {}) }, null, 2));
      return;
    }
    throw new Error("Use `fiber-mpp fl402 issue`, `fiber-mpp fl402 verify`, or `fiber-mpp fl402 convert`");
  });

program
  .command("receipt")
  .argument("<action>", "verify")
  .argument("<file>")
  .option("--secret <secret>", "receipt HMAC secret")
  .option("--previous-secret <secret...>", "previous receipt HMAC secret accepted during rotation")
  .description("Verify a Payment-Receipt JSON file")
  .action(async (action: string, file: string, opts: { secret?: string; previousSecret?: string[] }) => {
    if (action !== "verify") {
      throw new Error("Only `fiber-mpp receipt verify <receipt.json>` is supported");
    }
    const receipt = (await readJson(file)) as PaymentReceipt;
    const secrets = receiptAuditSecrets(undefined, opts.secret, opts.previousSecret, true);
    console.log(JSON.stringify({ valid: verifyReceiptSignatureWithAnySecret(receipt, secrets) }, null, 2));
  });

program
  .command("storage")
  .argument("<action>", "backup|restore|check|export-receipts|audit-receipts|list-deliveries")
  .option("--config <path>", "gateway config JSON")
  .option("--storage <uri>", "sqlite://path")
  .option("--out <path>", "backup destination path")
  .option("--from <path>", "restore source backup path")
  .option("--secret <secret>", "receipt HMAC secret for receipt export/audit")
  .option("--previous-secret <secret...>", "previous receipt HMAC secret accepted during rotation")
  .option("--force", "overwrite restore destination")
  .description("Operate on FiberMPP durable storage")
  .action(async (action: string, opts: { config?: string; storage?: string; out?: string; from?: string; secret?: string; previousSecret?: string[]; force?: boolean }) => {
    const config = opts.config ? parseGatewayConfig(await readJson(opts.config)) : undefined;
    const storagePath = storagePathFromOptions(opts.storage, config);
    if (action === "backup") {
      if (!opts.out) {
        throw new Error("fiber-mpp storage backup requires --out <path>");
      }
      const result = await backupSqliteStore(storagePath, opts.out);
      console.log(JSON.stringify({ storage: "sqlite", action, ...result }, null, 2));
      return;
    }
    if (action === "check") {
      const result = await checkSqliteStore(storagePath);
      console.log(JSON.stringify({ storage: "sqlite", action, ...result }, null, 2));
      if (result.integrityCheck !== "ok" || result.schemaVersion < 1) {
        process.exitCode = 1;
      }
      return;
    }
    if (action === "restore") {
      if (!opts.from) {
        throw new Error("fiber-mpp storage restore requires --from <path>");
      }
      if (!opts.force) {
        throw new Error("fiber-mpp storage restore requires --force to overwrite the configured SQLite database");
      }
      const result = await restoreSqliteStore(opts.from, storagePath, { force: true });
      console.log(JSON.stringify({ storage: "sqlite", action, ...result }, null, 2));
      return;
    }
    if (action === "export-receipts") {
      if (!opts.out) {
        throw new Error("fiber-mpp storage export-receipts requires --out <path>");
      }
      const secrets = receiptAuditSecrets(config, opts.secret, opts.previousSecret, false);
      const result = await exportSqliteReceipts(storagePath, opts.out, secrets.length > 0 ? { secrets } : {});
      console.log(JSON.stringify({
        storage: "sqlite",
        action,
        receipt_signature_checked: secrets.length > 0,
        receipt_signature_secret_count: secrets.length,
        ...result
      }, null, 2));
      return;
    }
    if (action === "audit-receipts") {
      const secrets = receiptAuditSecrets(config, opts.secret, opts.previousSecret, true);
      const result = await auditSqliteReceipts(storagePath, secrets);
      console.log(JSON.stringify({ storage: "sqlite", action, ...result }, null, 2));
      if (result.invalid > 0) {
        process.exitCode = 1;
      }
      return;
    }
    if (action === "list-deliveries") {
      const outcomes = await listSqliteDeliveryOutcomes(storagePath);
      console.log(JSON.stringify({
        storage: "sqlite",
        action,
        deliveries: outcomes.length,
        failed: outcomes.filter((outcome) => outcome.status === "failed").length,
        outcomes
      }, null, 2));
      return;
    }
    throw new Error("Use `fiber-mpp storage backup`, `fiber-mpp storage restore`, `fiber-mpp storage check`, `fiber-mpp storage export-receipts`, `fiber-mpp storage audit-receipts`, or `fiber-mpp storage list-deliveries`");
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
  .command("evidence")
  .argument("<action>", "start")
  .option("--port <port>", "API port", "8787")
  .option("--web-port <port>", "web console port", "8788")
  .option("--api-only", "start only the Evidence API")
  .description("Start the FiberMPP local evidence API and web console")
  .action(async (action: string, opts: { port: string; webPort: string; apiOnly?: boolean }) => {
    if (action === "start") {
      const apiPort = Number(opts.port);
      const { startEvidenceApi } = await loadEvidenceApi();
      const servers: unknown[] = [startEvidenceApi(apiPort)];
      if (!opts.apiOnly) {
        const { startEvidenceWeb } = await loadEvidenceWeb();
        servers.push(startEvidenceWeb(Number(opts.webPort), { apiBase: `http://127.0.0.1:${apiPort}` }));
      }
      await waitForEvidenceServers(servers);
      return;
    }
    throw new Error("Use `fiber-mpp evidence start`");
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

function stringInput(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${field} in input JSON`);
  }
  return value;
}

function unwrapVectorInput(input: Record<string, unknown>): Record<string, unknown> {
  const nested = input.input;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return input;
}

function fl402Resource(input: Record<string, unknown>, fallbackUrl = "http://fl402.local/compat"): ResourceDescriptor {
  const resource = input.resource;
  if (resource && typeof resource === "object" && !Array.isArray(resource)) {
    const method = (resource as { method?: unknown }).method;
    const url = (resource as { url?: unknown }).url;
    if (typeof method === "string" && typeof url === "string") {
      return {
        method,
        url,
        ...(
          typeof (resource as { bodyHash?: unknown }).bodyHash === "string"
            ? { bodyHash: (resource as { bodyHash: string }).bodyHash }
            : {}
        ),
        ...(
          typeof (resource as { contentType?: unknown }).contentType === "string"
            ? { contentType: (resource as { contentType: string }).contentType }
            : {}
        )
      };
    }
  }
  return {
    method: typeof input.method === "string" ? input.method : "GET",
    url: typeof resource === "string" ? resource : fallbackUrl
  };
}

function startGateway(config: ResolvedGatewayConfig): void {
  if (!config.storage.startsWith("sqlite://")) {
    throw new Error("fiber-mpp gateway requires storage sqlite://path");
  }
  const startedAt = new Date();
  const metrics: GatewayMetrics = {
    startedAt,
    requestsTotal: 0,
    responsesByStatus: new Map(),
    readinessChecks: 0,
    readinessFailures: 0,
    rateLimitRejections: 0
  };
  const rateLimiter = createRateLimiter(config.operations.rateLimit);
  const store = new SqliteStore(config.storage.slice("sqlite://".length));
  const middleware = createFiberMppMiddleware({
    secret: config.secret,
    previousSecrets: config.previousSecrets,
    serverId: config.serverId,
    store,
    fiber: FiberMethodAdapter.fromEnv(config.fiberEnv, "payee"),
    fl402: config.fl402
      ? {
          rootKey: config.fl402.rootKey,
          hashAlgorithm: config.fl402.hashAlgorithm
        }
      : undefined
  });
  const handler = createReverseProxyHandler(middleware, {
    upstream: config.upstream,
    price: config.price,
    methods: config.methods as never
  });
  const server = createServer(async (req, res) => {
    const requestStarted = Date.now();
    let status = 500;
    try {
      const pathname = requestPath(req);
      const origin = req.headers.origin;
      if (origin && !corsHeaders(config.cors, origin).allowed) {
        status = 403;
        sendJson(res, status, { error: "cors-origin-not-allowed" });
        return;
      }
      if ((req.method ?? "GET").toUpperCase() === "GET" && pathname === config.operations.healthPath) {
        status = 200;
        sendJson(res, status, {
          status: "ok",
          service: "fiber-mpp-gateway",
          server_id: config.serverId,
          started_at: startedAt.toISOString()
        }, config.cors, origin);
        return;
      }
      if ((req.method ?? "GET").toUpperCase() === "GET" && pathname === config.operations.readinessPath) {
        metrics.readinessChecks += 1;
        const report = await gatewayReadinessReport(config);
        status = report.status === "ready" ? 200 : 503;
        if (status !== 200) {
          metrics.readinessFailures += 1;
        }
        sendJson(res, status, report, config.cors, origin);
        return;
      }
      if ((req.method ?? "GET").toUpperCase() === "GET" && pathname === config.operations.metricsPath) {
        status = 200;
        sendText(res, status, renderMetrics(metrics, config), "text/plain; version=0.0.4", config.cors, origin);
        return;
      }
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        const cors = corsHeaders(config.cors, origin);
        status = 204;
        res.writeHead(status, cors.headers);
        res.end();
        return;
      }
      const rateLimit = rateLimiter(clientKey(req));
      if (!isOperationsPath(pathname, config.operations) && !rateLimit.allowed) {
        status = 429;
        metrics.rateLimitRejections += 1;
        sendRateLimitResponse(res, config.cors, origin, rateLimit.retryAfterSeconds);
        return;
      }
      const request = await nodeRequestToWeb(req, config.operations.requestBodyLimitBytes);
      const response = await handler(request);
      status = response.status;
      await sendWebResponse(res, response, config.cors, origin);
    } catch (error) {
      status = error instanceof GatewayHttpError ? error.status : 500;
      logJson("gateway_request_error", {
        status,
        method: req.method ?? "GET",
        path: requestPath(req),
        error: error instanceof Error ? error.message : String(error)
      }, config.operations);
      sendJson(res, status, {
        error: status === 500 ? "internal-server-error" : errorCode(error)
      }, config.cors, req.headers.origin);
    } finally {
      metrics.requestsTotal += 1;
      metrics.responsesByStatus.set(status, (metrics.responsesByStatus.get(status) ?? 0) + 1);
      logJson("gateway_request", {
        status,
        method: req.method ?? "GET",
        path: requestPath(req),
        duration_ms: Date.now() - requestStarted
      }, config.operations);
    }
  }).listen(config.port, () => {
    logJson("gateway_started", {
      listen: `http://localhost:${config.port}`,
      server_id: config.serverId,
      upstream: config.upstream,
      storage_kind: "sqlite",
      health_path: config.operations.healthPath,
      readiness_path: config.operations.readinessPath,
      metrics_path: config.operations.metricsPath,
      request_body_limit_bytes: config.operations.requestBodyLimitBytes,
      rate_limit_window_ms: config.operations.rateLimit.windowMs,
      rate_limit_max_requests: config.operations.rateLimit.maxRequests
    }, config.operations);
  });
  installGracefulShutdown(server, config.operations);
}

async function doctorReport(role: BootstrapRole, config: GatewayConfig | undefined) {
  if (role === "gateway") {
    const fiberEnv = fiberEnvFromGatewayConfig(config, process.env);
    const methods = config?.methods ?? ["fiber"];
    const price = config?.price ?? { value: "1", currency: "CKB", display: "1 CKB" };
    const report = buildBootstrapReport(role, {
      env: fiberEnv,
      secret: process.env[config?.secret_env ?? "FIBER_MPP_SECRET"],
      secretEnv: config?.secret_env ?? "FIBER_MPP_SECRET",
      previousSecretEnvs: previousSecretsFromGatewayConfig(config, process.env).secretEnvs,
      previousSecrets: previousSecretsFromGatewayConfig(config, process.env).secrets,
      missingPreviousSecretEnvs: previousSecretsFromGatewayConfig(config, process.env).missing,
      shortPreviousSecretEnvs: previousSecretsFromGatewayConfig(config, process.env).short,
      literalRpcAuth: gatewayConfigHasLiteralRpcAuth(config),
      storage: config?.storage ?? "sqlite://./fiber-mpp.sqlite",
      upstream: config?.upstream,
      methods,
      price,
      cors: resolveGatewayCorsPolicy(config),
      operations: resolveGatewayOperations(config)
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

function storagePathFromOptions(storage: string | undefined, config: GatewayConfig | undefined): string {
  const uri = storage ?? config?.storage;
  if (!uri) {
    throw new Error("Provide --storage sqlite://path or --config with storage");
  }
  const normalized = uri.startsWith("sqlite://") || uri.includes("://") ? uri : `sqlite://${uri}`;
  if (!normalized.startsWith("sqlite://")) {
    throw new Error("FiberMPP storage operations currently support sqlite:// storage only");
  }
  const path = normalized.slice("sqlite://".length);
  if (!path) {
    throw new Error("sqlite:// storage path is empty");
  }
  return path;
}

function receiptAuditSecrets(
  config: GatewayConfig | undefined,
  explicitSecret: string | undefined,
  explicitPreviousSecrets: string[] | undefined,
  required: boolean
): string[] {
  const previous = previousSecretsFromGatewayConfig(config, process.env);
  if (previous.missing.length > 0) {
    throw new Error(`Configured previous secret env var(s) are missing: ${previous.missing.join(", ")}`);
  }
  if (previous.short.length > 0) {
    throw new Error(`Configured previous secret env var(s) must be at least 32 characters: ${previous.short.join(", ")}`);
  }
  const currentSecret = explicitSecret ?? process.env[config?.secret_env ?? "FIBER_MPP_SECRET"];
  const secrets = [
    ...(currentSecret ? [currentSecret] : []),
    ...(explicitPreviousSecrets ?? []),
    ...previous.secrets
  ].filter(Boolean);
  if (secrets.length === 0 && required) {
    throw new Error("Provide --secret, --previous-secret, FIBER_MPP_SECRET, or configured previous_secret_envs");
  }
  return Array.from(new Set(secrets));
}

async function assertGatewayRpcReady(config: ResolvedGatewayConfig): Promise<void> {
  const report = await probeIfStructurallyReady(buildBootstrapReport("gateway", {
    env: config.fiberEnv,
    secret: config.secret,
    secretEnv: config.secretEnv,
    previousSecretEnvs: config.previousSecretEnvs,
    previousSecrets: config.previousSecrets,
    literalRpcAuth: false,
    storage: config.storage,
    upstream: config.upstream,
    methods: config.methods,
    price: config.price,
    cors: config.cors,
    operations: config.operations
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
  const roleLabel = role === "payer" ? "payer" : "payee";
  const probe = await probeFiberRpcReadiness({
    url: rpcUrl,
    auth: rpcAuth,
    role: roleLabel
  });
  Object.assign(report.checks, probe.checks);
  if (!probe.ok) {
    report.status = "blocked";
    report.blockers.push(...probe.blockers);
    const retryRole = role === "gateway" ? "gateway" : role;
    report.next_steps = [
      "start the required Fiber node",
      "check the RPC URL, Authorization header, peers, and ChannelReady channels",
      `retry fiber-mpp doctor --role ${retryRole}`
    ];
  }
  return report;
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

async function gatewayReadinessReport(config: ResolvedGatewayConfig) {
  return probeIfStructurallyReady(buildBootstrapReport("gateway", {
    env: config.fiberEnv,
    secret: config.secret,
    secretEnv: config.secretEnv,
    previousSecretEnvs: config.previousSecretEnvs,
    previousSecrets: config.previousSecrets,
    literalRpcAuth: false,
    storage: config.storage,
    upstream: config.upstream,
    methods: config.methods,
    price: config.price,
    cors: config.cors,
    operations: config.operations
  }), config.fiberEnv, "payee");
}

async function nodeRequestToWeb(req: IncomingMessage, bodyLimitBytes: number): Promise<Request> {
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
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > bodyLimitBytes) {
      throw new GatewayHttpError(413, "request-body-too-large");
    }
    chunks.push(buffer);
  }
  return new Request(url, {
    method,
    headers,
    body: Buffer.concat(chunks)
  });
}

async function sendWebResponse(
  res: ServerResponse,
  response: Response,
  cors: GatewayCorsPolicy,
  origin?: string
): Promise<void> {
  const headers: Record<string, string> = corsHeaders(cors, origin).headers;
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  cors?: GatewayCorsPolicy,
  origin?: string
): void {
  sendText(res, status, `${JSON.stringify(body, null, 2)}\n`, "application/json", cors, origin);
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  cors?: GatewayCorsPolicy,
  origin?: string
): void {
  res.writeHead(status, {
    ...(cors ? corsHeaders(cors, origin).headers : {}),
    "content-type": contentType
  });
  res.end(body);
}

function sendRateLimitResponse(
  res: ServerResponse,
  cors: GatewayCorsPolicy,
  origin: string | undefined,
  retryAfterSeconds: number
): void {
  res.writeHead(429, {
    ...corsHeaders(cors, origin).headers,
    "content-type": "application/json",
    "retry-after": String(retryAfterSeconds)
  });
  res.end(`${JSON.stringify({
    error: "rate-limit-exceeded",
    retry_after_seconds: retryAfterSeconds
  }, null, 2)}\n`);
}

function corsHeaders(cors: GatewayCorsPolicy, origin?: string): { allowed: boolean; headers: Record<string, string> } {
  if (!origin) {
    return { allowed: true, headers: {} };
  }
  if (!cors.allowedOrigins.includes(origin)) {
    return { allowed: false, headers: { vary: "origin" } };
  }
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": cors.allowedHeaders.join(", "),
    "access-control-allow-methods": cors.allowedMethods.join(", "),
    "access-control-expose-headers": cors.exposeHeaders.join(", "),
    vary: "origin"
  };
  if (cors.allowCredentials) {
    headers["access-control-allow-credentials"] = "true";
  }
  if (typeof cors.maxAgeSeconds === "number") {
    headers["access-control-max-age"] = String(cors.maxAgeSeconds);
  }
  return { allowed: true, headers };
}

function requestPath(req: IncomingMessage): string {
  return new URL(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`).pathname;
}

function isOperationsPath(pathname: string, operations: GatewayOperations): boolean {
  return pathname === operations.healthPath || pathname === operations.readinessPath || pathname === operations.metricsPath;
}

function renderMetrics(metrics: GatewayMetrics, config: ResolvedGatewayConfig): string {
  const lines = [
    "# HELP fiber_mpp_gateway_requests_total Total FiberMPP gateway HTTP requests.",
    "# TYPE fiber_mpp_gateway_requests_total counter",
    `fiber_mpp_gateway_requests_total{server_id="${escapePromLabel(config.serverId)}"} ${metrics.requestsTotal}`,
    "# HELP fiber_mpp_gateway_responses_total FiberMPP gateway HTTP responses by status.",
    "# TYPE fiber_mpp_gateway_responses_total counter"
  ];
  for (const [status, count] of [...metrics.responsesByStatus.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`fiber_mpp_gateway_responses_total{server_id="${escapePromLabel(config.serverId)}",status="${status}"} ${count}`);
  }
  lines.push(
    "# HELP fiber_mpp_gateway_readiness_checks_total Total readiness checks.",
    "# TYPE fiber_mpp_gateway_readiness_checks_total counter",
    `fiber_mpp_gateway_readiness_checks_total{server_id="${escapePromLabel(config.serverId)}"} ${metrics.readinessChecks}`,
    "# HELP fiber_mpp_gateway_readiness_failures_total Total failed readiness checks.",
    "# TYPE fiber_mpp_gateway_readiness_failures_total counter",
    `fiber_mpp_gateway_readiness_failures_total{server_id="${escapePromLabel(config.serverId)}"} ${metrics.readinessFailures}`,
    "# HELP fiber_mpp_gateway_rate_limit_rejections_total Total requests rejected by the gateway rate limiter.",
    "# TYPE fiber_mpp_gateway_rate_limit_rejections_total counter",
    `fiber_mpp_gateway_rate_limit_rejections_total{server_id="${escapePromLabel(config.serverId)}"} ${metrics.rateLimitRejections}`,
    ""
  );
  return lines.join("\n");
}

function createRateLimiter(policy: GatewayOperations["rateLimit"]): (key: string) => { allowed: boolean; retryAfterSeconds: number } {
  const windows = new Map<string, { resetAt: number; count: number }>();
  let nextCleanupAt = Date.now() + policy.windowMs;
  return (key: string) => {
    const now = Date.now();
    if (now >= nextCleanupAt) {
      for (const [entryKey, entry] of windows) {
        if (entry.resetAt <= now) {
          windows.delete(entryKey);
        }
      }
      nextCleanupAt = now + policy.windowMs;
    }
    const current = windows.get(key);
    if (!current || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + policy.windowMs });
      return { allowed: true, retryAfterSeconds: Math.ceil(policy.windowMs / 1000) };
    }
    current.count += 1;
    if (current.count > policy.maxRequests) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  };
}

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function installGracefulShutdown(server: Server, operations: GatewayOperations): void {
  const shutdown = (signal: NodeJS.Signals) => {
    logJson("gateway_shutdown_started", { signal }, operations);
    const timer = setTimeout(() => {
      logJson("gateway_shutdown_forced", { signal }, operations);
      process.exit(1);
    }, operations.shutdownGraceMs);
    timer.unref();
    server.close((error) => {
      if (error) {
        logJson("gateway_shutdown_error", { signal, error: error.message }, operations);
        process.exit(1);
      }
      logJson("gateway_shutdown_complete", { signal }, operations);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function logJson(event: string, fields: Record<string, unknown>, operations?: GatewayOperations): void {
  console.log(JSON.stringify(redactForLog({
    ts: new Date().toISOString(),
    event,
    ...fields
  }, operations?.logRedaction ?? { enabled: true })));
}

function errorCode(error: unknown): string {
  return error instanceof GatewayHttpError ? error.code : "internal-server-error";
}

function escapePromLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

class GatewayHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code);
  }
}

async function loadEvidenceApi(): Promise<{ startEvidenceApi: (port?: number) => unknown }> {
  const mod = await import("@fiber-mpp/evidence-api") as unknown as {
    startEvidenceApi?: (port?: number) => unknown;
  };
  if (!mod.startEvidenceApi) {
    throw new Error("@fiber-mpp/evidence-api does not export startEvidenceApi; run pnpm build before using the evidence API");
  }
  return { startEvidenceApi: mod.startEvidenceApi };
}

async function loadEvidenceWeb(): Promise<{ startEvidenceWeb: (port?: number, options?: { apiBase?: string }) => unknown }> {
  const mod = await import("@fiber-mpp/evidence-web") as unknown as {
    startEvidenceWeb?: (port?: number, options?: { apiBase?: string }) => unknown;
  };
  if (!mod.startEvidenceWeb) {
    throw new Error("@fiber-mpp/evidence-web does not export startEvidenceWeb; run pnpm install and pnpm build before using the evidence console");
  }
  return { startEvidenceWeb: mod.startEvidenceWeb };
}

async function waitForEvidenceServers(servers: unknown[]): Promise<void> {
  await new Promise<void>((resolve) => {
    let closing = false;
    const keeper = setInterval(() => undefined, 60_000);
    const close = () => {
      if (closing) return;
      closing = true;
      clearInterval(keeper);
      Promise.all(servers.map(closeServerHandle)).finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function closeServerHandle(server: unknown): Promise<void> {
  const close = (server as { close?: (callback?: (error?: Error) => void) => void } | null)?.close;
  if (typeof close !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    close.call(server, () => resolve());
  });
}

type GatewayMetrics = {
  startedAt: Date;
  requestsTotal: number;
  responsesByStatus: Map<number, number>;
  readinessChecks: number;
  readinessFailures: number;
  rateLimitRejections: number;
};
