import { readFile, access, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const distHtmlPath = resolve(here, "..", "dist", "index.html");
const distDir = resolve(here, "..", "dist");

async function safeRead(path) {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

let distBundle = { js: "", css: "", all: "", files: [] };
try {
  const assetFiles = await readdir(resolve(distDir, "assets"));
  const jsFiles = assetFiles.filter((f) => f.endsWith(".js"));
  const cssFiles = assetFiles.filter((f) => f.endsWith(".css"));
  const jsContents = await Promise.all(jsFiles.map((f) => readFile(resolve(distDir, "assets", f), "utf8")));
  const cssContents = await Promise.all(cssFiles.map((f) => readFile(resolve(distDir, "assets", f), "utf8")));
  distBundle = {
    js: jsContents.join("\n"),
    css: cssContents.join("\n"),
    all: [...jsContents, ...cssContents].join("\n"),
    files: [...jsFiles, ...cssFiles],
  };
} catch {
  // dist/ may not exist yet (pre-build)
}

const html = await safeRead(distHtmlPath);
await access(distDir).catch(() => {
  console.error(`dist/ directory not found. Run: pnpm --filter @fiber-paid-http/evidence-web build`);
  process.exit(1);
});

if (!html) {
  console.error(`dist/index.html not found at ${distHtmlPath}. Run: pnpm --filter @fiber-paid-http/evidence-web build`);
  process.exit(1);
}

const requiredHtmlFragments = [
  '<div id="root"',
  '<script type="module"',
];

// API URL fragments that must appear inside a `/api/...` URL literal in the
// production bundle. This catches "endpoint renamed" and "URL split across
// concatenation" — both of which the old string-includes check missed.
const requiredUrlFragments = [
  "evidence/reset",
  "evidence/export",
  "bootstrap/runtime",
  "bootstrap/runtime/reset",
  "tournament/battlecode/status",
  "tournament/battlecode/manifest",
];

// Other constants that must survive minification as string literals in the
// bundle. Phase names, header names, localStorage keys, badge fields.
const requiredBundleFragments = [
  "x-fiber-paid-http-session",
  "sessionId",
  "pollMs",
  "unpaid",
  "payment_settled",
  "receipt_returned",
  "replay_rejected",
  "challenge_received",
  "productionReady",
  "gateway-lab",
  "Verified readiness",
  "Protocol perspective",
  "REFERENCE INTEGRATION",
];

for (const fragment of requiredHtmlFragments) {
  if (!html.includes(fragment)) {
    console.error(`dist/index.html missing required fragment: ${fragment}`);
    process.exit(1);
  }
}

// Extract every `/api/...` URL literal from the JS bundle (covers both
// string literals and template-literal URLs like `/api/evidence/${action}`).
const apiUrlRegex = /\/api\/[A-Za-z0-9_/$\-\{\}]+/g;
const apiUrlMatches = distBundle.js.match(apiUrlRegex) || [];
const apiUrls = [...new Set(apiUrlMatches)];

const missingUrls = requiredUrlFragments.filter((frag) => !apiUrls.some((url) => url.includes(frag)));
if (missingUrls.length) {
  console.error("Bundle is missing required API URL fragments:");
  for (const frag of missingUrls) console.error(`  - ${frag}`);
  console.error(`Bundle API URLs detected: ${apiUrls.join(", ") || "(none)"}`);
  process.exit(1);
}

const missingBundle = requiredBundleFragments.filter((frag) => !distBundle.all.includes(frag));
if (missingBundle.length) {
  console.error("Bundle is missing required constants:");
  for (const frag of missingBundle) console.error(`  - ${frag}`);
  process.exit(1);
}

const distAssets = html.match(/\/assets\/[^"]+\.(js|css)/g) || [];
if (distAssets.length === 0) {
  console.error("dist/index.html has no bundled assets. Build may have failed.");
  process.exit(1);
}

console.log(
  `evidence-web dist check passed: ${distAssets.length} assets, ` +
  `${distBundle.files.length} bundle files, ${apiUrls.length} API URLs detected, ` +
  `${requiredUrlFragments.length} URL anchors, ${requiredBundleFragments.length} constant anchors`,
);
