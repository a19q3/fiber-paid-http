import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const serverPath = resolve(repoRoot, "apps", "evidence-web", "server.mjs");
const reportPath = resolve(repoRoot, "reports", "evidence-console-browser-smoke.json");
const screenshotDir = resolve(tmpdir(), "fiber-paid-http-browser-smoke");
const chromeBin = process.env.CHROME_BIN || await findChrome();
const smokeApiLabel = "temporary-local-api";
const smokeWebOrigin = "served-local-web-server";

if (!chromeBin) {
  throw new Error("Chrome not found. Set CHROME_BIN or install google-chrome-stable/chromium.");
}

const apiPort = await findFreePort();
const webPort = await findFreePort();
const cdpPort = await findFreePort();
const profileDir = await mkdtemp(resolve(tmpdir(), "fiber-paid-http-smoke-profile-"));
const apiBase = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}/`;
const apiProcess = spawn("pnpm", ["exec", "tsx", "--eval", fixtureApiSource()], {
  cwd: repoRoot,
  env: deterministicApiEnv(apiPort),
  stdio: ["ignore", "pipe", "pipe"]
});
const apiOutput = [];
apiProcess.stdout.on("data", (chunk) => apiOutput.push(String(chunk)));
apiProcess.stderr.on("data", (chunk) => apiOutput.push(String(chunk)));
const webProcess = spawn(process.execPath, [serverPath], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(webPort), FIBER_PAID_HTTP_EVIDENCE_API_BASE: apiBase },
  stdio: ["ignore", "pipe", "pipe"]
});
const webOutput = [];
webProcess.stdout.on("data", (chunk) => webOutput.push(String(chunk)));
webProcess.stderr.on("data", (chunk) => webOutput.push(String(chunk)));

let chrome;
try {
  await waitForHttp(`${apiBase}/api/status`, 12_000);
  await waitForHttp(webUrl, 12_000, webOutput);
  chrome = spawn(chromeBin, [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1440,1100",
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  await waitForDebugger(cdpPort);
  const page = await firstPage(cdpPort);
  const client = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.send("Page.navigate", { url: webUrl });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await runSmoke(client, apiBase, webUrl);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
    await mkdir(screenshotDir, { recursive: true });
    const screenshot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    await writeFile(resolve(screenshotDir, "browser-smoke-final.png"), Buffer.from(screenshot.data, "base64"));
    console.log(`evidence console browser smoke passed: ${result.steps.length} UI checks, api=${smokeApiLabel}`);
  } finally {
    client.close();
  }
} finally {
  if (chrome) {
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome);
  }
  apiProcess.kill("SIGTERM");
  await waitForProcessExit(apiProcess);
  webProcess.kill("SIGTERM");
  await waitForProcessExit(webProcess);
  await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function runSmoke(client, apiBase, webUrl) {
  const steps = [];
  await waitFor(client, `document.querySelector("#api-state-text")?.textContent?.includes(${JSON.stringify(`connected ${apiBase}`)})`, "connected API state");
  steps.push(await snapshot(client, "connected-api"));

  await click(client, "#open-settings");
  await waitFor(client, "Boolean(document.querySelector('#api-base-input'))", "api input");
  await waitFor(client, `document.querySelector("#api-base-input")?.value === ${JSON.stringify(apiBase)}`, "injected API base");
  await setInputAndChange(client, "#settings-amount-shannons", "200");
  await waitFor(client, `document.querySelector("#amount-ckb")?.value === "0.000002"`, "CKB amount stored");
  await click(client, "#close-settings");
  await waitFor(client, `!document.querySelector("#settings-overlay")`, "settings closed");

  await click(client, '[data-workspace-tab="flow"]');
  await waitFor(client, `document.querySelector(".console")?.dataset.workspace === "flow"`, "flow workspace");
  assertSmoke(await client.evaluate(`document.querySelector("#flow-actions")?.textContent?.includes("Client / AI Agent") && document.querySelector("#flow-actions")?.textContent?.includes("Payer FNN")`), "main actions must identify the client and payer FNN actor boundaries");
  assertSmoke(await client.evaluate(`document.querySelector("#flow-mode-guided")?.getAttribute("aria-pressed") === "true" && !document.querySelector("#continue")`), "guided demo must be the default and hide the manual continuation control");
  assertSmoke(await client.evaluate(`document.querySelector("#flow-actions")?.textContent?.includes("Pay once; SDK resumes delivery")`), "guided demo must explain automatic delivery continuation");
  assertSmoke(await client.evaluate(`document.querySelector("#send").disabled === false`), "send button must be usable with the fixture API");
  assertSmoke(await client.evaluate(`document.querySelector("#pay").disabled === true && document.querySelector("#action-hint")?.textContent?.includes("unpaid request")`), "pay button must be blocked before a challenge");
  await waitFor(client, `document.querySelector("#price")?.textContent === "0.000002 CKB"`, "CKB amount reflected");
  steps.push(await snapshot(client, "flow-workspace"));

  await client.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll("#scenarios .scenario-btn"));
    const file = rows.find((node) => node.textContent.includes("/paid/file")) || rows[0];
    if (!file) throw new Error("scenario row missing");
    file.click();
  })()`);
  await waitFor(client, `document.querySelector("#selected-label")?.textContent?.includes("/paid/") && !document.querySelector("#selected-label")?.textContent?.includes("protocol-service")`, "resource scenario selection");
  await waitFor(client, `document.querySelector("#logs")?.textContent?.includes("flow reset")`, "resource reset log");
  steps.push(await snapshot(client, "resource-selected"));

  await click(client, "#send");
  await waitFor(client, `document.querySelector("#challenge-id")?.textContent !== "pending"`, "challenge received");
  await waitFor(client, `document.querySelector("#resource-hash")?.textContent !== "pending"`, "resource hash rendered");
  await waitFor(client, `document.querySelector("#timeline")?.textContent?.includes("send_payment") && document.querySelector("#timeline")?.textContent?.includes("PAYER FNN")`, "payer FNN payment step rendered");
  await waitFor(client, `document.querySelector("#pay")?.disabled === false`, "pay enabled after challenge");
  steps.push(await snapshot(client, "unpaid-request"));

  await click(client, "#pay");
  await waitFor(client, `document.querySelector("#replay")?.disabled === false`, "guided payment automatically resumes delivery and enables replay check");
  await waitFor(client, `document.querySelector("#payment-completion-state")?.textContent?.includes("COMPLETE")`, "guided payment flow marked complete after receipt");
  assertSmoke(await client.evaluate(`!document.querySelector("#continue")`), "guided demo must never expose continuation as a third SOP step");
  assertSmoke(await client.evaluate(`document.querySelectorAll("#timeline .timeline-row").length === 8`), "primary payment timeline must contain only the eight transaction steps");
  assertSmoke(await client.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll("#timeline .timeline-desc strong")).map((node) => node.textContent?.trim());
    return labels[6] === "Execute protected service" && labels[7] === "Return response + Payment-Receipt";
  })()`), "service execution must precede the response and receipt in the timeline");
  await waitFor(client, `document.querySelector("#actuator-service")?.textContent === "executed before receipt"`, "service execution ordered before receipt");
  await waitFor(client, `document.querySelector("#timeline")?.textContent?.includes("receipt_reference")`, "timeline receipt reference rendered");
  steps.push(await snapshot(client, "guided-payment-and-delivery"));

  await click(client, "#replay");
  await waitFor(client, `document.querySelector("#actuator-reissued")?.textContent === "false"`, "receipt not reissued");
  await waitFor(client, `document.querySelector("#actuator-replay")?.textContent?.includes("blocked")`, "actuator replay blocked");
  await waitFor(client, `document.querySelector("#replay-security-state")?.textContent?.includes("VERIFIED")`, "replay protection marked as a separate verified security check");
  steps.push(await snapshot(client, "replay-rejected"));
  const completedFlowEvidence = assertCompletedFlowEvidence(steps.at(-1)?.evidence);

  await click(client, "#clear-log");
  await waitFor(client, `document.querySelector("#challenge-id")?.textContent === "pending"`, "flow reset before guided recovery check");
  await client.evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__fiberPaidHttpOriginalFetch = originalFetch;
    let failContinuationOnce = true;
    window.fetch = async (...args) => {
      const input = args[0];
      const url = typeof input === "string" ? input : input?.url || "";
      if (failContinuationOnce && url.includes("/api/evidence/retry")) {
        failContinuationOnce = false;
        return new Response(JSON.stringify({ error: "simulated-continuation-failure", message: "simulated delivery network interruption" }), {
          status: 502,
          headers: { "content-type": "application/json" }
        });
      }
      return originalFetch(...args);
    };
  })()`);
  await click(client, "#send");
  await waitFor(client, `document.querySelector("#pay")?.disabled === false`, "guided recovery challenge ready");
  await click(client, "#pay");
  await waitFor(client, `Boolean(document.querySelector("#resume-delivery"))`, "guided flow exposes no-payment recovery after continuation failure");
  assertSmoke(await client.evaluate(`document.querySelector("#resume-delivery")?.textContent?.includes("no new payment") && document.querySelector("#payment-completion-state")?.textContent?.includes("IN PROGRESS")`), "recovery control must preserve the settled payment without claiming completion");
  assertSmoke(await client.evaluate(`(document.querySelector("#logs")?.textContent?.match(/send_payment/g) || []).length === 1`), "guided recovery must have exactly one payment attempt before resuming delivery");
  steps.push(await snapshot(client, "guided-recovery-ready"));
  await click(client, "#resume-delivery");
  await waitFor(client, `document.querySelector("#payment-completion-state")?.textContent?.includes("COMPLETE")`, "guided recovery completes delivery");
  assertSmoke(await client.evaluate(`(document.querySelector("#logs")?.textContent?.match(/send_payment/g) || []).length === 1`), "resuming delivery must not send a second payment");
  steps.push(await snapshot(client, "guided-recovery-complete"));
  const recoveryFlowEvidence = assertDeliveredFlowEvidence(steps.at(-1)?.evidence);
  await client.evaluate(`(() => {
    if (window.__fiberPaidHttpOriginalFetch) window.fetch = window.__fiberPaidHttpOriginalFetch;
    delete window.__fiberPaidHttpOriginalFetch;
  })()`);

  await click(client, "#clear-log");
  await waitFor(client, `document.querySelector("#challenge-id")?.textContent === "pending"`, "flow reset before manual protocol check");
  await waitFor(client, `document.querySelector("#flow-mode-manual")?.disabled === false`, "manual protocol mode switch ready after reset");
  await click(client, "#flow-mode-manual");
  await waitFor(client, `document.querySelector("#flow-mode-manual")?.getAttribute("aria-pressed") === "true" && document.querySelector("#continue")?.disabled === true`, "manual protocol mode exposes a disabled continuation control");
  assertSmoke(await client.evaluate(`document.querySelector(".protocol-run-context")?.textContent?.includes("not product SOP")`), "manual mode must be labeled as protocol debugging rather than the product SOP");
  steps.push(await snapshot(client, "manual-protocol-ready"));

  await click(client, "#send");
  await waitFor(client, `document.querySelector("#pay")?.disabled === false`, "manual mode challenge ready");
  await click(client, "#pay");
  await waitFor(client, `document.querySelector("#continue")?.disabled === false`, "manual continuation enabled after one successful payment");
  assertSmoke(await client.evaluate(`document.querySelector("#payment-completion-state")?.textContent?.includes("IN PROGRESS") && document.querySelector("#replay")?.disabled === true`), "manual mode must pause after settlement without marking delivery complete");
  steps.push(await snapshot(client, "manual-payment-settled"));

  await click(client, "#continue");
  await waitFor(client, `document.querySelector("#payment-completion-state")?.textContent?.includes("COMPLETE")`, "manual continuation completes delivery");
  await waitFor(client, `document.querySelector("#replay")?.disabled === false`, "manual delivery enables the optional replay check");
  steps.push(await snapshot(client, "manual-credential-continuation"));
  const manualFlowEvidence = assertDeliveredFlowEvidence(steps.at(-1)?.evidence);

  await click(client, "#open-settings");
  await waitFor(client, `Boolean(document.querySelector("#settings-overlay"))`, "settings open");
  await client.evaluate(`document.querySelector("#settings-persona").value = "auditor"; document.querySelector("#settings-persona").dispatchEvent(new Event("change", { bubbles: true }))`);
  await waitFor(client, `document.querySelector(".settings-note")?.textContent?.includes("Security auditor")`, "persona change rendered");
  await click(client, "#close-settings");
  await waitFor(client, `!document.querySelector("#settings-overlay")`, "settings closed");
  steps.push(await snapshot(client, "settings-roundtrip"));

  await click(client, '[data-workspace-tab="evidence"]');
  await waitFor(client, `document.querySelector(".console")?.dataset.workspace === "evidence"`, "evidence workspace");
  await client.evaluate(`Array.from(document.querySelectorAll("#tabs .tab")).find((node) => node.textContent.includes("Payment Receipt"))?.click()`);
  await waitFor(client, `document.querySelector("#json")?.textContent?.includes('"reference"') && document.querySelector("#json")?.textContent?.includes('"challengeId"')`, "payment receipt evidence tab");
  steps.push(await snapshot(client, "evidence-tab"));
  assertCompletedFlowEvidence(completedFlowEvidence);

  await click(client, '[data-workspace-tab="bootstrap"]');
  await click(client, "#refresh-bootstrap");
  await waitFor(client, `!document.querySelector("#refresh-bootstrap")?.classList.contains("is-busy")`, "bootstrap refresh settles");
  await waitFor(client, `document.querySelector("#bootstrap-summary")?.textContent?.length > 20`, "bootstrap summary rendered");
  steps.push(await snapshot(client, "bootstrap-refresh"));

  await click(client, "#clear-log");
  await waitFor(client, `(() => {
    const text = document.querySelector("#logs")?.textContent || "";
    return !text.includes("CKB price parameter changed") && !text.includes("flow reset") && !text.includes("checks refreshed");
  })()`, "session log clear");
  steps.push(await snapshot(client, "clear-log"));
  const resetEvidence = steps.at(-1)?.evidence ?? {};
  const resetEvidenceAfterClear = !resetEvidence.challenge_id && !resetEvidence.resource_hash && resetEvidence.service_executed === "not executed";
  assertSmoke(resetEvidenceAfterClear, "clear-log must reset the active flow while preserving earlier completed evidence snapshots");

  return {
    evidence_console_browser_smoke: true,
    report_schema: "fiber-paid-http-evidence-console-browser-smoke-v1",
    api_base: smokeApiLabel,
    web_origin: smokeWebOrigin,
    console_url: webUrl.replace(/:\d+\//, ":<port>/"),
    api_base_source: "served HTML injected by evidence web server",
    api_backing: "temporary local evidence API process with in-process Fiber adapters",
    mode: normalizeSmokeText(await client.evaluate(`window.__fiberPaidHttpSmokeMode || document.querySelector("#api-state-text")?.textContent || ""`), apiBase),
    completed_flow_evidence: completedFlowEvidence,
    recovery_flow_evidence: recoveryFlowEvidence,
    manual_flow_evidence: manualFlowEvidence,
    reset_evidence_after_clear: resetEvidenceAfterClear,
    steps
  };
}

function assertCompletedFlowEvidence(evidence) {
  assertDeliveredFlowEvidence(evidence);
  assertSmoke(evidence.replay_status === "blocked", "completed evidence snapshot must show replay blocked");
  assertSmoke(evidence.receipt_reissued === "false", "completed evidence snapshot must show receipt not reissued");
  assertSmoke(evidence.replay_security === "VERIFIED", "completed evidence snapshot must mark replay protection as a separate verified check");
  assertSmoke(evidence.replay_control_disabled === true, "completed evidence snapshot must disable the consumed replay credential control");
  return evidence;
}

function assertDeliveredFlowEvidence(evidence) {
  assertSmoke(Boolean(evidence), "delivered evidence snapshot is missing");
  assertSmoke(/^[A-Za-z0-9_-]{43}$/.test(evidence.challenge_id), "completed evidence snapshot must keep a canonical challenge_id");
  assertSmoke(/^[0-9a-f]{64}$/i.test(evidence.resource_hash), "completed evidence snapshot must keep a canonical resource_hash");
  assertSmoke(/^0x[0-9a-f]{64}$/i.test(evidence.payment_hash), "completed evidence snapshot must keep a canonical payment_hash");
  assertSmoke(/^0x[0-9a-f]{64}$/i.test(evidence.receipt_reference), "completed evidence snapshot must keep a canonical receipt_reference");
  assertSmoke(evidence.payment_hash.toLowerCase() === evidence.receipt_reference.toLowerCase(), "receipt_reference must equal payment_hash");
  assertSmoke(evidence.service_executed === "executed before receipt", "completed evidence snapshot must show correctly ordered service execution");
  assertSmoke(evidence.payment_completion === "COMPLETE", "completed evidence snapshot must mark the payment transaction complete");
  return evidence;
}

async function snapshot(client, step) {
  const evidence = await evidenceSnapshot(client);
  return {
    step,
    workspace: await client.evaluate(`document.querySelector(".console")?.dataset.workspace || ""`),
    api_state: normalizeSmokeText(await client.evaluate(`document.querySelector("#api-state-text")?.textContent || ""`), apiBase),
    selected_resource: await client.evaluate(`document.querySelector("#selected-label")?.textContent || ""`),
    action_hint: await client.evaluate(`document.querySelector("#action-hint")?.textContent?.trim() || ""`),
    send_disabled: await client.evaluate(`document.querySelector("#send")?.disabled === true`),
    pay_disabled: await client.evaluate(`document.querySelector("#pay")?.disabled === true`),
    flow_mode: await client.evaluate(`document.querySelector("#flow-mode-guided")?.getAttribute("aria-pressed") === "true" ? "guided" : "manual"`),
    evidence
  };
}

async function evidenceSnapshot(client) {
  return client.evaluate(`(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
    const json = text("#json");
    const findCapture = (source, pattern) => {
      const match = String(source || "").match(pattern);
      return match ? match[1] : "";
    };
    const visibleChallenge = text("#challenge-id");
    const visibleResourceHash = text("#resource-hash");
    const visiblePaymentHash = text("#inspector-payment-hash");
    const visibleReceiptReference = text("#inspector-receipt-reference");
    return {
      challenge_id: visibleChallenge && visibleChallenge !== "pending" ? visibleChallenge : findCapture(json, /"challenge_id":\\s*"([^"]+)"/i),
      resource_hash: visibleResourceHash && visibleResourceHash !== "pending" ? visibleResourceHash : findCapture(json, /"resource_hash":\\s*"([^"]+)"/i),
      payment_hash: /^0x[0-9a-f]{64}$/i.test(visiblePaymentHash) ? visiblePaymentHash : findCapture(json, /"paymentHash":\\s*"(0x[0-9a-f]{64})"/i),
      receipt_reference: /^0x[0-9a-f]{64}$/i.test(visibleReceiptReference) ? visibleReceiptReference : findCapture(json, /"reference":\\s*"(0x[0-9a-f]{64})"/i),
      service_executed: text("#actuator-service"),
      replay_status: text("#actuator-replay"),
      receipt_reissued: text("#actuator-reissued"),
      actuator_health: text("#actuator-health"),
      replay_blocked: text("#blocked"),
      payment_completion: text("#payment-completion-state"),
      replay_security: text("#replay-security-state"),
      replay_control_disabled: document.querySelector("#replay")?.disabled === true
    };
  })()`);
}

function normalizeSmokeText(text, apiBase) {
  return String(text || "")
    .replaceAll(apiBase, smokeApiLabel)
    .replace(/ · \d{2}:\d{2}:\d{2}\.\d{3}/g, " · <time>");
}

async function click(client, selector) {
  await client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error(${JSON.stringify(`missing ${selector}`)});
    node.click();
  })()`);
}

async function setInputAndChange(client, selector, value) {
  await client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error(${JSON.stringify(`missing ${selector}`)});
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    if (descriptor?.set) descriptor.set.call(input, ${JSON.stringify(value)});
    else input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function waitFor(client, expression, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await client.evaluate(`Boolean(${expression})`);
    if (value) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await smokeDiagnostics(client))}`);
}

function assertSmoke(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function smokeDiagnostics(client) {
  return client.evaluate(`(() => ({
    workspace: document.querySelector(".console")?.dataset.workspace,
    selected: document.querySelector("#selected-label")?.textContent,
    challenge: document.querySelector("#challenge-id")?.textContent,
    actionHint: document.querySelector("#action-hint")?.textContent?.trim(),
    send: {
      disabled: document.querySelector("#send")?.disabled,
      title: document.querySelector("#send")?.title
    },
    pay: {
      disabled: document.querySelector("#pay")?.disabled,
      title: document.querySelector("#pay")?.title
    },
    logs: document.querySelector("#logs")?.textContent?.replace(/\\s+/g, " ").trim().slice(-800),
    api: document.querySelector("#api-state-text")?.textContent
  }))()`);
}

function deterministicApiEnv(port) {
  const env = { ...process.env, PORT: String(port) };
  for (const key of [
    "RUN_FIBER_E2E",
    "FIBER_MODE",
    "FIBER_RPC_URL",
    "FIBER_PAYEE_RPC_URL",
    "FIBER_PAYER_RPC_URL",
    "FIBER_ROUTER_RPC_URL",
    "FIBER_RPC_AUTH",
    "FIBER_PAYEE_RPC_AUTH",
    "FIBER_PAYER_RPC_AUTH",
    "FIBER_PAID_HTTP_SECRET"
  ]) {
    delete env[key];
  }
  return env;
}

function fixtureApiSource() {
  return `
    import { serve } from "@hono/node-server";
    import { createEvidenceApi } from "./apps/evidence-api/src/index.ts";
    import { createFiberFixtureAdapters, createSqliteTestStore } from "./tests/helpers/fiber-fixture.ts";

    const { payeeFiber, payerFiber } = createFiberFixtureAdapters();
    const app = createEvidenceApi({
      fiber: payeeFiber,
      payerFiber,
      store: createSqliteTestStore("fiber-paid-http-browser-smoke-"),
      secret: "browser-smoke-secret-at-least-32-chars"
    });
    const server = serve({ fetch: app.fetch, port: Number(process.env.PORT) });
    console.log("Fiber Paid HTTP browser smoke API listening on http://127.0.0.1:" + process.env.PORT);
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
}

async function waitForHttp(url, timeoutMs, output = apiOutput) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Wait for the evidence API to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${output.join("")}`);
}

async function firstPage(port) {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((item) => item.type === "page");
  if (!page) {
    throw new Error("Chrome did not expose a page target");
  }
  return page;
}

async function connectCdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(JSON.stringify(message.error)));
      } else {
        callbacks.resolve(message.result);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    send(method, params = {}) {
      const next = ++id;
      ws.send(JSON.stringify({ id: next, method, params }));
      return new Promise((resolve, reject) => pending.set(next, { resolve, reject }));
    },
    evaluate(expression) {
      return this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
        .then((result) => {
          if (result.exceptionDetails) {
            throw new Error(JSON.stringify(result.exceptionDetails));
          }
          return result.result.value;
        });
    },
    close() {
      ws.close();
    }
  };
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Retry until Chrome opens the debugging endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chrome debugging endpoint");
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function findChrome() {
  const candidates = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];
  for (const candidate of candidates) {
    if (await commandExists(candidate)) return candidate;
  }
  return "";
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", "command -v \"$1\" >/dev/null 2>&1 || [ -x \"$1\" ]", "sh", command], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
