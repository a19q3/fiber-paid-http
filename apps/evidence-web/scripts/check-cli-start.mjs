import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const reportPath = resolve(repoRoot, "reports", "evidence-console-cli-start.json");
const apiPort = await findFreePort();
const webPort = await findFreePort(apiPort);
const expectedApiBase = `http://127.0.0.1:${apiPort}`;
const output = [];
const child = spawn("pnpm", ["exec", "fiber-paid-http", "evidence", "start", "--port", String(apiPort), "--web-port", String(webPort)], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

try {
  await waitForHttp(`http://127.0.0.1:${apiPort}/healthz`, 8_000);
  await waitForHttp(`http://127.0.0.1:${webPort}/`, 8_000);
  const healthResponse = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
  const health = await healthResponse.json();
  const htmlResponse = await fetch(`http://127.0.0.1:${webPort}/`);
  const html = await htmlResponse.text();
  assert(healthResponse.status === 200, `/healthz returned ${healthResponse.status}`);
  assert(health.service === "fiber-paid-http-evidence-api", "/healthz did not identify the Evidence API");
  assert(htmlResponse.status === 200, `GET / returned ${htmlResponse.status}`);
  assert(html.includes("Fiber Paid HTTP Evidence Console"), "web server did not serve the Evidence Console");
  assert(html.includes(expectedApiBase), "web HTML did not inject the CLI API port");
  assert(!html.includes("http://localhost:8787"), "web HTML kept the default API base after CLI startup");
  assert(output.join("").includes(`Fiber Paid HTTP evidence API listening on http://localhost:${apiPort}`), "CLI did not log API startup");
  assert(output.join("").includes(`Fiber Paid HTTP evidence console listening on http://localhost:${webPort}`), "CLI did not log web startup");

  const report = {
    ok: true,
    command: "fiber-paid-http evidence start",
    api_port: apiPort,
    web_port: webPort,
    api_health_status: health.status,
    api_service: health.service,
    injected_api_base: expectedApiBase,
    web_served_console: true,
    api_and_web_started_by_single_cli_command: true
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`evidence console CLI start smoke passed: api=${apiPort}, web=${webPort}`);
} finally {
  child.kill("SIGTERM");
  await waitForExit(child);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`CLI exited before ${url} was ready\n${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown"}\n${output.join("")}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForExit(process) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => {
    process.once("exit", resolveExit);
  });
}

function findFreePort(exclude) {
  const probe = createServer();
  return new Promise((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a free port"));
        } else if (address.port === exclude) {
          resolvePort(findFreePort(exclude));
        } else {
          resolvePort(address.port);
        }
      });
    });
  });
}
