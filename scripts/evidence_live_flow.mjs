#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const apiBase = stripTrailingSlash(args["api-base"] || process.env.FIBER_PAID_HTTP_EVIDENCE_API_BASE || "http://127.0.0.1:8787");
const webUrl = stripTrailingSlash(args["web-url"] || process.env.FIBER_PAID_HTTP_EVIDENCE_WEB_URL || "http://127.0.0.1:8788");
const sessionId = normalizeSessionId(args.session || process.env.FIBER_PAID_HTTP_DEMO_SESSION || "live-demo");
const endpoint = args.endpoint || process.env.FIBER_PAID_HTTP_DEMO_ENDPOINT || "/paid/protocol-service";
const amountShannons = args["amount-shannons"] || process.env.FIBER_PAID_HTTP_DEMO_AMOUNT_SHANNONS || process.env.FIBER_E2E_AMOUNT_SHANNONS || "100";
const amountCkb = shannonsToCkb(amountShannons);
const stepDelayMs = boundedInteger(args["delay-ms"] || process.env.FIBER_PAID_HTTP_DEMO_STEP_DELAY_MS, 0, 120000, 3500);
const reportPath = resolve(repoRoot, args.report || process.env.FIBER_PAID_HTTP_DEMO_REPORT || "reports/evidence-live-demo-flow.json");
const startedAt = new Date().toISOString();
const steps = [];

try {
  console.log(`Fiber Paid HTTP live evidence demo`);
  console.log(`api_base=${apiBase}`);
  console.log(`session=${sessionId}`);
  console.log(`endpoint=${endpoint}`);
  console.log(`amount=${amountCkb} CKB; fiber_amount_shannons=${amountShannons}`);

  const readiness = await readLiveReadiness();
  steps.push({ step: "readiness", path: readiness.path, status: readiness.response.status, body: readiness.body });
  if (!readiness.body?.ok) {
    const blockers = readiness.body?.blockers?.length ? readiness.body.blockers : ["live Fiber readiness failed"];
    throw new Error(`Evidence API is not live-ready: ${blockers.join(" | ")}`);
  }
  console.log(`readiness=ready source=${readiness.path} mode=${readiness.body.mode}`);

  await postStep("reset", "/api/evidence/reset", {});
  await pause("reset visible");

  const unpaid = await postStep("unpaid", "/api/evidence/unpaid", {
    endpoint,
    amountShannons
  });
  if (unpaid.body?.status !== 402 || !unpaid.body?.fiberChallenge) {
    throw new Error(`unpaid request did not return a Fiber 402 challenge: ${JSON.stringify(summarizeBody(unpaid.body))}`);
  }
  const paymentHash = unpaid.body.fiberChallenge.paymentHash || unpaid.body.flow?.fiberChallenge?.paymentHash;
  console.log(`402 challenge observed payment_hash=${paymentHash || "unknown"}`);
  await pause("402 challenge visible");

  const pay = await postStep("pay", "/api/evidence/pay", {});
  const proof = pay.body?.payload || pay.body?.proof || pay.body?.flow?.proof || {};
  const proofHash = proof.paymentHash || proof.payment_hash || paymentHash;
  console.log(`Fiber payment sent credential=ready payment_hash=${proofHash || "unknown"}`);
  await pause("payment visible");

  const continuation = await postStep("continue", "/api/evidence/retry", {});
  if (continuation.body?.status !== 200 || !continuation.body?.receipt) {
    throw new Error(`Authenticated request did not return HTTP 200 with Payment-Receipt: ${JSON.stringify(summarizeBody(continuation.body))}`);
  }
  const receiptReference = continuation.body.receipt.reference;
  const challengeId = continuation.body.receipt.challengeId;
  console.log(`Payment-Receipt returned receipt_reference=${receiptReference} challenge_id=${challengeId}`);
  await pause("receipt visible");

  const replay = await postStep("replay", "/api/evidence/replay", {});
  if (replay.body?.status !== 402 || replay.body?.receiptReissued !== false) {
    throw new Error(`replay was not rejected without a new receipt: ${JSON.stringify(summarizeBody(replay.body))}`);
  }
  console.log(`Replay rejected status=${replay.body.status} receipt_reissued=false`);
  await pause("replay visible");

  const status = await getJson("/api/status");
  steps.push({ step: "status", status: status.response.status, body: summarizeFlow(status.body?.flow) });
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    startedAt,
    apiBase,
    sessionId,
    endpoint,
    amountCkb,
    amountShannons,
    paymentHash: proofHash,
    receiptReference,
    challengeId,
    replayRejected: true,
    receiptReissued: false,
    frontendObserveUrl: `${webUrl}/?sessionId=${encodeURIComponent(sessionId)}&pollMs=1200`,
    steps
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report=${reportPath}`);
} catch (error) {
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    startedAt,
    apiBase,
    sessionId,
    endpoint,
    amountCkb,
    amountShannons,
    error: errorMessage(error),
    steps
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(errorMessage(error));
  console.error(`report=${reportPath}`);
  process.exitCode = 1;
}

async function postStep(name, path, body) {
  const result = await postJson(path, body);
  steps.push({ step: name, status: result.response.status, body: summarizeBody(result.body) });
  console.log(`${name}=HTTP ${result.response.status}`);
  return result;
}

async function pause(label) {
  if (stepDelayMs <= 0) return;
  console.log(`observe=${label}; sleeping ${stepDelayMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
}

async function readLiveReadiness() {
  const readyz = await getJson("/readyz", { acceptStatuses: [200, 403, 404, 503] });
  if ((readyz.response.status === 200 || readyz.response.status === 503) && typeof readyz.body?.ok === "boolean") {
    return { ...readyz, path: "/readyz" };
  }
  const status = await getJson("/api/status");
  return {
    response: status.response,
    path: "/api/status",
    body: {
      ok: status.body?.livePaymentEnabled === true,
      mode: status.body?.mode,
      blockers: Array.isArray(status.body?.blockers) ? status.body.blockers : []
    }
  };
}

async function getJson(path, options = {}) {
  return requestJson(path, { method: "GET" }, options);
}

async function postJson(path, body) {
  return requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
}

async function requestJson(path, init, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "x-fiber-paid-http-session": sessionId
    }
  });
  const payload = await response.json().catch(() => ({}));
  const acceptStatuses = options.acceptStatuses || [200];
  if (!acceptStatuses.includes(response.status)) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return { response, body: payload };
}

function summarizeBody(body) {
  if (!body || typeof body !== "object") return body;
  return {
    status: body.status,
    error: body.error,
    message: body.message,
    rejected: body.rejected,
    receiptReissued: body.receiptReissued,
    fiberChallenge: body.fiberChallenge ? {
      paymentHash: body.fiberChallenge.paymentHash,
      amount: body.fiberChallenge.amount,
      currency: body.fiberChallenge.currency
    } : undefined,
    proof: (body.payload || body.proof) ? {
      mode: (body.payload || body.proof).mode,
      status: (body.payload || body.proof).status,
      paymentHash: (body.payload || body.proof).paymentHash || (body.payload || body.proof).payment_hash
    } : undefined,
    receipt: body.receipt ? {
      reference: body.receipt.reference,
      challengeId: body.receipt.challengeId
    } : undefined,
    flow: summarizeFlow(body.flow)
  };
}

function summarizeFlow(flow) {
  if (!flow || typeof flow !== "object") return flow;
  return {
    endpoint: flow.endpoint,
    challengeId: flow.challengeId,
    resourceHash: flow.resourceHash,
    paymentHash: flow.fiberChallenge?.paymentHash || flow.proof?.paymentHash || flow.proof?.payment_hash,
    receiptReference: flow.receipt?.reference,
    receiptChallengeId: flow.receipt?.challengeId,
    replayStatus: flow.replayStatus,
    events: Array.isArray(flow.events) ? flow.events.map((event) => ({
      time: event.time,
      level: event.level,
      actor: event.actor,
      message: event.message,
      detail: event.detail
    })) : []
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "1";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizeSessionId(value) {
  const text = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._:-]{0,80}$/i.test(text) ? text : "live-demo";
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function shannonsToCkb(value) {
  const shannons = BigInt(String(value));
  const padded = shannons.toString().padStart(9, "0");
  const whole = padded.slice(0, -8) || "0";
  const fraction = padded.slice(-8).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
