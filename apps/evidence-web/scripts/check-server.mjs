import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "server.mjs");
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: String(port), FIBER_PAID_HTTP_EVIDENCE_API_BASE: "http://127.0.0.1:9876" },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHttp(`${baseUrl}/`, 4000);

  const index = await fetch(`${baseUrl}/`);
  assert(index.status === 200, `GET / returned ${index.status}`);
  assert((index.headers.get("content-type") || "").includes("text/html"), "GET / must serve HTML");
  assert(index.headers.get("cache-control") === "no-store", "Evidence console HTML must be no-store");
  assert((index.headers.get("content-security-policy") || "").includes("default-src 'self'"), "CSP must restrict default-src to self");
  const indexHtml = await index.text();
  assert(indexHtml.includes("Fiber Paid HTTP Evidence Console"), "GET / must serve the evidence console");
  assert(indexHtml.includes("http://127.0.0.1:9876"), "Evidence console HTML must receive the configured API base");
  assert(!indexHtml.includes("http://localhost:8787"), "Evidence console HTML must not keep the default API base after injection");
  const csp = index.headers.get("content-security-policy") || "";
  assert(csp.includes("connect-src 'self' http://127.0.0.1:9876"), "CSP must allow the configured Evidence API origin");
  assert(csp.includes("style-src 'self'"), "CSP must allow bundled stylesheet assets from self");
  assert(!csp.includes("http://localhost:*"), "CSP must not allow every localhost port");
  assert(!csp.includes("http://127.0.0.1:*"), "CSP must not allow every 127.0.0.1 port");

  const head = await fetch(`${baseUrl}/index.html`, { method: "HEAD" });
  assert(head.status === 200, `HEAD /index.html returned ${head.status}`);
  assert((await head.text()) === "", "HEAD /index.html must not return a response body");

  const post = await fetch(`${baseUrl}/`, { method: "POST" });
  assert(post.status === 405, `POST / returned ${post.status}`);
  assert(post.headers.get("allow") === "GET, HEAD", "POST / must advertise GET, HEAD only");

  const traversal = await fetch(`${baseUrl}/%2e%2e/evidence-api/package.json`);
  assert(traversal.status !== 200, "Encoded parent path must not read outside the web root");

  const implementationFile = await fetch(`${baseUrl}/server.mjs`);
  assert(implementationFile.status === 404, `GET /server.mjs returned ${implementationFile.status}`);

  console.log("evidence web server hardening checks passed: methods, headers, root containment, implementation-file denylist");
} finally {
  server.kill("SIGTERM");
  await waitForExit(server);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // Wait for the local evidence web server to bind its port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}${stderr ? `\n${stderr}` : ""}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => {
    child.once("exit", resolveExit);
  });
}

function findFreePort() {
  const probe = createServer();
  return new Promise((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a free port"));
        } else {
          resolvePort(address.port);
        }
      });
    });
  });
}
