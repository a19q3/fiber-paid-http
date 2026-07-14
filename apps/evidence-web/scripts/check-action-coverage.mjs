import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const distHtmlPath = resolve(here, "..", "dist", "index.html");
const distAssetsDir = resolve(here, "..", "dist", "assets");
const apiPath = resolve(repoRoot, "apps", "evidence-api", "src", "index.ts");
const integrationTestPath = resolve(repoRoot, "tests", "integration", "full-flow.test.ts");
const reportPath = resolve(repoRoot, "reports", "evidence-console-action-coverage.json");

const [html, api, integrationTest] = await Promise.all([
  readFile(distHtmlPath, "utf8"),
  readFile(apiPath, "utf8"),
  readFile(integrationTestPath, "utf8"),
]);

let builtJs = "";
try {
  const assetFiles = await readdir(distAssetsDir);
  const jsFiles = assetFiles.filter((f) => f.endsWith(".js"));
  const contents = await Promise.all(jsFiles.map((f) => readFile(resolve(distAssetsDir, f), "utf8")));
  builtJs = contents.join("\n");
} catch {
  // no assets
}

const commandSurface = [html, builtJs].join("\n");

const controls = [
  { id: "api-apply", label: "Connect API", endpoint: "/api/status", surface: ["api-settings", "api-apply"] },
  { id: "refresh-all", label: "Refresh Gateway Lab", endpoint: "/api/status", surface: ["refresh-all"] },
  { id: "send", label: "Send unpaid request", endpoint: "/api/evidence/unpaid", surface: ["send", "evidence/"] },
  { id: "pay", label: "Pay with Fiber", endpoint: "/api/evidence/pay", surface: ["pay"] },
  { id: "retry", label: "Retry with Authorization", endpoint: "/api/evidence/retry", surface: ["retry"] },
  { id: "replay", label: "Replay same credential", endpoint: "/api/evidence/replay", surface: ["replay"] },
  { id: "clear-log", label: "Clear log / reset flow", endpoint: "/api/evidence/reset", surface: ["clear-log", "evidence/reset"] },
  { id: "apply-runtime-bootstrap", label: "Apply runtime bootstrap", endpoint: "/api/bootstrap/runtime", surface: ["apply-runtime-bootstrap", "bootstrap/runtime"] },
  { id: "clear-runtime-bootstrap", label: "Clear runtime bootstrap", endpoint: "/api/bootstrap/runtime/reset", surface: ["clear-runtime-bootstrap", "runtime/reset"] },
  { id: "export-evidence", label: "Export evidence", endpoint: "/api/evidence/export", surface: ["export-evidence", "evidence/export"] },
  { id: "copy-env", label: "Copy env template", endpoint: null, surface: ["copy-env"] },
];

const failures = [];
const results = [];

for (const control of controls) {
  const surfaceFound = control.surface.every((s) => commandSurface.includes(s));
  const endpointFound = !control.endpoint || api.includes(control.endpoint);
  const testFound = !control.endpoint || integrationTest.includes(control.endpoint);

  if (!surfaceFound) failures.push(`${control.id}: missing surface fragments ${JSON.stringify(control.surface)}`);
  if (!endpointFound) failures.push(`${control.id}: backend endpoint ${control.endpoint} not found in API`);
  if (!testFound) failures.push(`${control.id}: endpoint ${control.endpoint} not covered by integration test`);

  results.push({
    id: control.id,
    label: control.label,
    surfaceFound,
    endpointFound,
    testFound,
    endpoint: control.endpoint,
    status: (surfaceFound && endpointFound && testFound) ? "passed" : "failed"
  });
}

await mkdir(resolve(reportPath, ".."), { recursive: true });
await writeFile(reportPath, JSON.stringify({ controls: results, timestamp: new Date().toISOString() }, null, 2));

if (failures.length) {
  console.error(`Action coverage check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`Gateway Lab action coverage passed: ${results.length} controls verified`);
