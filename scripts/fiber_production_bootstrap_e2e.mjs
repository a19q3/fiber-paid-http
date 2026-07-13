import { spawn } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAYMENT_RECEIPT_HEADER,
  PaymentReceiptSchema,
  buildAuthorizationPaymentHeader,
  decodeFiberChargeRequest,
  decodeReceipt,
  parseWwwAuthenticatePaymentHeader
} from "@fiber-paid-http/core";
import { FiberMethodAdapter } from "@fiber-paid-http/fiber-method";
import { SqliteStore } from "@fiber-paid-http/storage";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(repoRoot, process.env.FIBER_PRODUCTION_BOOTSTRAP_REPORT ?? "reports/production-bootstrap-e2e.json");
const mode = process.env.FIBER_MODE;
const payeeRpcUrl = process.env.FIBER_PAYEE_RPC_URL ?? process.env.FIBER_RPC_URL;
const payerRpcUrl = process.env.FIBER_PAYER_RPC_URL;
const payeeRpcAuth = process.env.FIBER_PAYEE_RPC_AUTH ?? process.env.FIBER_RPC_AUTH;
const payerRpcAuth = process.env.FIBER_PAYER_RPC_AUTH ?? process.env.FIBER_RPC_AUTH;
const secret = process.env.FIBER_PAID_HTTP_SECRET;
const amount = process.env.FIBER_E2E_AMOUNT_SHANNONS ?? "100";
const currency = process.env.FIBER_CURRENCY ?? "Fibt";
const workDir = await mkdtemp(join(tmpdir(), "fiber-paid-http-production-bootstrap-"));
const storagePath = join(workDir, "gateway.sqlite");
const configPath = join(workDir, "gateway.json");
const keyPath = join(workDir, "tls-key.pem");
const certPath = join(workDir, "tls-cert.pem");
let rustProcess;
let upstreamServer;
let tlsServer;
let serviceExecutions = 0;
let responseLimitExecutions = 0;
let timeoutExecutions = 0;
let childLog = "";
let report = {
  schema: "fiber-paid-http-production-bootstrap-v1",
  generated_at: new Date().toISOString(),
  status: "failed",
  blockers: []
};

try {
  const blockers = requiredEnvironmentBlockers();
  if (blockers.length > 0) throw new Error(blockers.join("; "));

  await run("cargo", ["build", "-p", "fiber-paid-http-cli"], { cwd: repoRoot });
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1"
  ], { cwd: repoRoot, quiet: true });

  const rustPort = await freePort();
  upstreamServer = createHttpServer((request, response) => {
    if (request.url === "/paid/upstream-response-limit") {
      responseLimitExecutions += 1;
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(2048, 1));
      return;
    }
    if (request.url === "/paid/upstream-timeout") {
      timeoutExecutions += 1;
      setTimeout(() => {
        if (!response.writableEnded) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ delayed: true }));
        }
      }, 1000);
      return;
    }
    serviceExecutions += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ paid: true, engine: "rust" }));
  });
  const upstreamPort = await listen(upstreamServer);

  tlsServer = createHttpsServer({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
    minVersion: "TLSv1.2"
  }, (request, response) => {
    const headers = sanitizeProxyHeaders(request.headers);
    headers.host = `127.0.0.1:${rustPort}`;
    const proxy = httpRequest({
      hostname: "127.0.0.1",
      port: rustPort,
      path: request.url,
      method: request.method,
      headers
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, sanitizeProxyHeaders(upstream.headers));
      upstream.pipe(response);
    });
    proxy.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "gateway-unavailable" }));
    });
    request.pipe(proxy);
  });
  const tlsPort = await listen(tlsServer);
  const publicBaseUrl = `https://127.0.0.1:${tlsPort}`;

  const config = {
    role: "gateway",
    listen: `127.0.0.1:${rustPort}`,
    server_id: "fiber-paid-http-production-bootstrap-e2e",
    realm: "127.0.0.1",
    public_base_url: publicBaseUrl,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    storage: `sqlite://${storagePath}`,
    charge: {
      amount,
      currency: "ckb",
      description: "Rust production bootstrap E2E"
    },
    secret_env: "FIBER_PAID_HTTP_SECRET",
    operations: {
      health_path: "/healthz",
      readiness_path: "/readyz",
      metrics_path: "/metrics",
      request_body_limit_bytes: 1048576,
      upstream_response_limit_bytes: 1024,
      upstream_timeout_ms: 250,
      shutdown_grace_ms: 10000,
      rate_limit: { window_ms: 60000, max_requests: 8 }
    },
    fiber: {
      mode: "testnet",
      currency,
      payee_rpc_url: payeeRpcUrl,
      payee_rpc_auth_env: "FIBER_PAYEE_RPC_AUTH",
      settlement_timeout_ms: Number(process.env.FIBER_SETTLEMENT_TIMEOUT_MS ?? 60000),
      settlement_poll_ms: Number(process.env.FIBER_SETTLEMENT_POLL_MS ?? 500)
    }
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  rustProcess = spawn(resolve(repoRoot, "target/debug/fiber-paid-http-rs"), ["server", "--config", configPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FIBER_PAID_HTTP_SECRET: secret,
      FIBER_PAYEE_RPC_AUTH: payeeRpcAuth
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  rustProcess.stdout.on("data", (chunk) => { childLog = boundedAppend(childLog, chunk); });
  rustProcess.stderr.on("data", (chunk) => { childLog = boundedAppend(childLog, chunk); });

  const readyResponse = await waitForReady(tlsPort, rustProcess);
  const payerBootstrap = await rpcBootstrapFacts(payerRpcUrl, payerRpcAuth);
  const payeeBootstrap = await rpcBootstrapFacts(payeeRpcUrl, payeeRpcAuth);

  const bodyLimit = await tlsCall(tlsPort, "/paid/body-limit", {}, {
    method: "POST",
    body: Buffer.alloc(1048577, 1)
  });
  if (bodyLimit.status !== 413 || responseHeader(bodyLimit.headers, PAYMENT_RECEIPT_HEADER)) {
    throw new Error(`body-limit probe returned ${bodyLimit.status}, expected receipt-free 413`);
  }

  const payer = FiberMethodAdapter.fromEnv({
    ...process.env,
    FIBER_MODE: "testnet",
    FIBER_PAYER_RPC_URL: payerRpcUrl,
    FIBER_PAYER_RPC_AUTH: payerRpcAuth,
    FIBER_CURRENCY: currency
  }, "payer");
  const { unpaid, challenge, charge, authorization, response: paid } = await payProtectedPath(
    tlsPort,
    "/paid/bootstrap",
    payer
  );
  if (paid.status !== 200) throw new Error(`paid request returned ${paid.status}, expected 200`);
  const receiptHeader = headerText(responseHeader(paid.headers, PAYMENT_RECEIPT_HEADER));
  const receipt = decodeReceipt(receiptHeader);
  const receiptCheck = PaymentReceiptSchema.safeParse(receipt);
  if (!receiptCheck.success) throw new Error("Rust gateway returned an invalid Payment-Receipt");
  if (receipt.reference !== charge.methodDetails.paymentHash || receipt.challengeId !== challenge.id) {
    throw new Error("Payment-Receipt does not match the settled charge");
  }

  const replay = await tlsCall(tlsPort, "/paid/bootstrap", { authorization });
  if (replay.status !== 402 || responseHeader(replay.headers, PAYMENT_RECEIPT_HEADER)) {
    throw new Error("replay was not rejected with a fresh receipt-free 402");
  }
  const responseLimitProbe = await payProtectedPath(tlsPort, "/paid/upstream-response-limit", payer);
  if (
    responseLimitProbe.response.status !== 502 ||
    responseHeader(responseLimitProbe.response.headers, PAYMENT_RECEIPT_HEADER)
  ) {
    throw new Error(
      `upstream response-limit probe returned ${responseLimitProbe.response.status}, expected receipt-free 502`
    );
  }
  const timeoutProbe = await payProtectedPath(tlsPort, "/paid/upstream-timeout", payer);
  if (timeoutProbe.response.status !== 502 || responseHeader(timeoutProbe.response.headers, PAYMENT_RECEIPT_HEADER)) {
    throw new Error(`upstream timeout probe returned ${timeoutProbe.response.status}, expected receipt-free 502`);
  }
  const limited = await tlsCall(tlsPort, "/paid/bootstrap");
  if (limited.status !== 429) throw new Error(`rate-limit probe returned ${limited.status}, expected 429`);
  if (!limited.headers["retry-after"]) throw new Error("rate-limit probe did not return Retry-After");
  if (serviceExecutions !== 1) throw new Error(`protected upstream executed ${serviceExecutions} times, expected once`);
  if (responseLimitExecutions !== 1 || timeoutExecutions !== 1) {
    throw new Error("upstream limit probes did not each execute exactly once");
  }

  const metrics = await tlsCall(tlsPort, "/metrics");
  if (metrics.status !== 200 || !metrics.body.toString("utf8").includes("fiber_paid_http_gateway_rate_limit_rejections_total")) {
    throw new Error("Rust gateway metrics endpoint did not expose rate-limit evidence");
  }

  const shutdown = await stopChild(rustProcess);
  if (!shutdown.graceful) throw new Error("Rust gateway did not complete graceful SIGINT shutdown");
  rustProcess = undefined;
  const store = new SqliteStore(storagePath);
  const health = store.healthReport(storagePath);
  const receipts = await store.listReceipts();
  const deliveries = await store.listDeliveryOutcomes();
  const validReceipts = receipts.filter((value) => PaymentReceiptSchema.safeParse(value).success).length;
  const failedDeliveries = deliveries.filter((value) => value.status === "failed").length;
  const expectedProbeChallengeIds = new Set([responseLimitProbe.challenge.id, timeoutProbe.challenge.id]);
  const expectedProbeFailedDeliveries = deliveries.filter(
    (value) => value.status === "failed" && expectedProbeChallengeIds.has(value.challengeId)
  ).length;
  const unexpectedFailedDeliveries = deliveries.filter(
    (value) => value.status === "failed" && !expectedProbeChallengeIds.has(value.challengeId)
  ).length;
  if (expectedProbeFailedDeliveries !== 2 || unexpectedFailedDeliveries !== 0) {
    throw new Error("delivery audit did not isolate the two expected upstream limit failures");
  }
  const sensitiveValues = [secret, payeeRpcAuth, payerRpcAuth, charge.methodDetails.invoice].filter(Boolean);
  const logRedactionEnabled = sensitiveValues.every((value) => !childLog.includes(value));
  if (!logRedactionEnabled) throw new Error("Rust gateway output contained sensitive payment or RPC material");

  report = {
    schema: "fiber-paid-http-production-bootstrap-v1",
    generated_at: new Date().toISOString(),
    fiber_commit: await fiberCommit(),
    status: "passed",
    mode: "testnet",
    engine: "rust",
    transport: {
      tls: true,
      protocol: paid.tlsProtocol,
      public_base_url: publicBaseUrl,
      self_signed_test_certificate: true
    },
    payer_bootstrap: payerBootstrap,
    payee_bootstrap: payeeBootstrap,
    gateway_bootstrap: {
      status: readyResponse.status === 200 ? "ready" : "blocked",
      server_id: config.server_id,
      engine: "rust",
      rust_gateway: true,
      rpc_auth_from_env: Boolean(payeeRpcAuth),
      log_redaction_enabled: logRedactionEnabled,
      rate_limit_enforced: limited.status === 429 && Boolean(limited.headers["retry-after"]),
      body_limit_enforced:
        bodyLimit.status === 413 && !responseHeader(bodyLimit.headers, PAYMENT_RECEIPT_HEADER),
      upstream_timeout_enforced:
        timeoutProbe.response.status === 502 &&
        !responseHeader(timeoutProbe.response.headers, PAYMENT_RECEIPT_HEADER),
      upstream_response_limit_enforced:
        responseLimitProbe.response.status === 502 &&
        !responseHeader(responseLimitProbe.response.headers, PAYMENT_RECEIPT_HEADER),
      graceful_shutdown: shutdown.graceful,
      graceful_shutdown_duration_ms: shutdown.durationMs
    },
    unpaid_request_status: unpaid.status,
    paid_request: {
      status: paid.status,
      receipt_reference: receipt.reference,
      challenge_id: receipt.challengeId,
      payment_hash: charge.methodDetails.paymentHash,
      receipt_schema_valid: receiptCheck.success,
      settlement_status: "settled",
      delivery_status: "delivered",
      delivery_response_status: paid.status
    },
    replay: {
      status: replay.status,
      receipt_reissued: Boolean(responseHeader(replay.headers, PAYMENT_RECEIPT_HEADER)),
      service_executions: serviceExecutions
    },
    operational_limits: {
      body_limit_status: bodyLimit.status,
      rate_limit_status: limited.status,
      retry_after_present: Boolean(limited.headers["retry-after"]),
      upstream_response_limit_status: responseLimitProbe.response.status,
      upstream_response_limit_receipt_reissued: Boolean(
        responseHeader(responseLimitProbe.response.headers, PAYMENT_RECEIPT_HEADER)
      ),
      upstream_timeout_status: timeoutProbe.response.status,
      upstream_timeout_receipt_reissued: Boolean(
        responseHeader(timeoutProbe.response.headers, PAYMENT_RECEIPT_HEADER)
      )
    },
    storage: {
      schema_version: health.schemaVersion,
      journal_mode: health.journalMode,
      foreign_keys: health.foreignKeys,
      integrity_check: health.integrityCheck,
      receipts: receipts.length,
      valid_receipts: validReceipts,
      invalid_receipts: receipts.length - validReceipts,
      failed_deliveries: failedDeliveries,
      expected_probe_failed_deliveries: expectedProbeFailedDeliveries,
      unexpected_failed_deliveries: unexpectedFailedDeliveries
    },
    blockers: []
  };
} catch (error) {
  report = {
    ...report,
    generated_at: new Date().toISOString(),
    status: "failed",
    blockers: [safeError(error)]
  };
  throw error;
} finally {
  if (rustProcess) await stopChild(rustProcess);
  await closeServer(tlsServer);
  await closeServer(upstreamServer);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(workDir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));

function requiredEnvironmentBlockers() {
  return [
    ...(mode === "testnet" ? [] : ["set FIBER_MODE=testnet"]),
    ...(payeeRpcUrl ? [] : ["set FIBER_PAYEE_RPC_URL or FIBER_RPC_URL"]),
    ...(payerRpcUrl ? [] : ["set FIBER_PAYER_RPC_URL"]),
    ...(payeeRpcAuth ? [] : ["set FIBER_PAYEE_RPC_AUTH or FIBER_RPC_AUTH through an authenticated trusted RPC proxy"]),
    ...(payerRpcAuth ? [] : ["set FIBER_PAYER_RPC_AUTH or FIBER_RPC_AUTH through an authenticated trusted RPC proxy"]),
    ...(secret && secret.length >= 32 ? [] : ["set FIBER_PAID_HTTP_SECRET to at least 32 characters"])
  ];
}

async function payProtectedPath(port, path, payer) {
  const unpaid = await tlsCall(port, path);
  if (unpaid.status !== 402) throw new Error(`unpaid ${path} request returned ${unpaid.status}, expected 402`);
  if (String(unpaid.headers["cache-control"] ?? "") !== "no-store") {
    throw new Error(`unpaid ${path} response missing Cache-Control: no-store`);
  }
  const challenge = parseWwwAuthenticatePaymentHeader(headerText(unpaid.headers["www-authenticate"]));
  if (!challenge) throw new Error(`unpaid ${path} response did not contain a Payment challenge`);
  const charge = decodeFiberChargeRequest(challenge.request);
  const payload = await payer.payCharge(charge);
  const authorization = buildAuthorizationPaymentHeader({ challenge, payload });
  const response = await tlsCall(port, path, { authorization });
  return { unpaid, challenge, charge, authorization, response };
}

async function rpcBootstrapFacts(url, auth) {
  const node = await rpc(url, auth, "node_info", []);
  const peers = namedArray(await rpc(url, auth, "list_peers", []), "peers");
  const channels = namedArray(await rpc(url, auth, "list_channels", [{}]), "channels");
  const readyChannels = channels.filter((channel) => normalizeState(channelState(channel)) === "channelready").length;
  if (peers.length === 0 || readyChannels === 0) throw new Error("Fiber bootstrap requires a peer and a ready channel");
  const authFacts = await rpcAuthFacts(url);
  return {
    status: "ready",
    node_id: node?.pubkey ?? node?.node_id ?? null,
    rpc_auth_from_env: Boolean(auth),
    ...authFacts,
    peers: peers.length,
    channels: channels.length,
    ready_channels: readyChannels
  };
}

async function rpcAuthFacts(url) {
  const [missingAuthRejected, invalidAuthRejected] = await Promise.all([
    rpcRequestRejectedAsUnauthorized(url),
    rpcRequestRejectedAsUnauthorized(url, "Bearer fiber-paid-http-invalid-token")
  ]);
  if (!missingAuthRejected || !invalidAuthRejected) {
    throw new Error("Fiber RPC must reject missing and invalid authentication");
  }
  return {
    rpc_auth_enforced: true,
    missing_auth_rejected: true,
    invalid_auth_rejected: true
  };
}

async function rpcRequestRejectedAsUnauthorized(url, auth) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_info", params: [] }),
    signal: AbortSignal.timeout(5000)
  });
  if (response.status === 401 || response.status === 403) return true;
  const value = await response.json().catch(() => null);
  return value?.error?.code === -32999 && value.error.message === "Unauthorized";
}

async function rpc(url, auth, method, params) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Fiber RPC ${method} returned HTTP ${response.status}`);
  const value = await response.json();
  if (
    value?.jsonrpc !== "2.0" ||
    value?.id !== 1 ||
    value?.error ||
    !Object.hasOwn(value ?? {}, "result")
  ) {
    throw new Error(`Fiber RPC ${method} returned an invalid JSON-RPC 2.0 envelope`);
  }
  return value.result;
}

function namedArray(value, field) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[field]) ? value[field] : [];
}

function channelState(value) {
  if (typeof value?.state === "string") return value.state;
  if (typeof value?.state?.state_name === "string") return value.state.state_name;
  return typeof value?.state_name === "string" ? value.state_name : "unknown";
}

function normalizeState(value) {
  return String(value).replace(/[_\s-]/g, "").toLowerCase();
}

async function tlsCall(port, path, headers = {}, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const body = options.body ?? null;
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: body ? { ...headers, "content-length": String(body.length) } : headers,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2"
    }, (response) => {
      const tlsProtocol = response.socket?.getProtocol?.() ?? null;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        tlsProtocol
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function waitForReady(port, child) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) throw new Error(`Rust gateway exited before readiness with code ${child.exitCode}`);
    try {
      const response = await tlsCall(port, "/readyz");
      if (response.status === 200) return response;
    } catch {
      // The process or TLS proxy may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Rust gateway readiness timed out");
}

function headerText(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value !== "string" || !value) throw new Error("required HTTP header is missing");
  return value;
}

function responseHeader(headers, name) {
  return headers[name.toLowerCase()] ?? headers[name];
}

async function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise(server.address().port);
    });
  });
}

async function freePort() {
  const server = createNetServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

async function stopChild(child) {
  const started = Date.now();
  if (!child || child.exitCode !== null) {
    return { graceful: child?.exitCode === 0, durationMs: 0 };
  }
  child.kill("SIGINT");
  let forced = false;
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(() => {
      forced = true;
      resolvePromise();
    }, 10000))
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
  return {
    graceful: !forced && child.exitCode === 0,
    durationMs: Date.now() - started
  };
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.quiet ? "ignore" : "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function fiberCommit() {
  const fiberRepo = resolve(repoRoot, process.env.FIBER_REPO ?? "../fiber");
  let output = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", fiberRepo, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error("unable to read Fiber commit")));
  });
  return output.trim();
}

function boundedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-1024 * 1024);
}

function sanitizeProxyHeaders(headers) {
  const next = { ...headers };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [
    ...connectionTokens,
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]) {
    delete next[name];
  }
  return next;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [secret, payeeRpcAuth, payerRpcAuth]
    .filter((value) => typeof value === "string" && value.length > 0)
    .reduce((redacted, value) => redacted.replaceAll(value, "[REDACTED]"), message);
}
