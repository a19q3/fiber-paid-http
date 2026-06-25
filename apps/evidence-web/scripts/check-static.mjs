import { readFile, access, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const distHtmlPath = resolve(here, "..", "dist", "index.html");
const distDir = resolve(here, "..", "dist");
const rootPackagePath = resolve(repoRoot, "package.json");
const apiPackagePath = resolve(repoRoot, "apps", "evidence-api", "package.json");
const webPackagePath = resolve(repoRoot, "apps", "evidence-web", "package.json");
const webServerPath = resolve(repoRoot, "apps", "evidence-web", "server.mjs");
const cliPackagePath = resolve(repoRoot, "packages", "cli", "package.json");
const cliSourcePath = resolve(repoRoot, "packages", "cli", "src", "index.ts");
const gateScriptPath = resolve(repoRoot, "scripts", "fiber_mpp_gate.sh");
const tsconfigBasePath = resolve(repoRoot, "tsconfig.base.json");

async function safeRead(path) {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

let distAssetsContent = "";
try {
  const assetFiles = await readdir(resolve(distDir, "assets"));
  const jsFiles = assetFiles.filter((f) => f.endsWith(".js") || f.endsWith(".css"));
  const contents = await Promise.all(jsFiles.map((f) => readFile(resolve(distDir, "assets", f), "utf8")));
  distAssetsContent = contents.join("\n");
} catch {
  // no assets dir yet
}

const [html, rootPackageJson, apiPackageJson, webPackageJson, webServer, cliPackageJson, cliSource, gateScript, tsconfigBase] = await Promise.all([
  safeRead(distHtmlPath),
  safeRead(rootPackagePath),
  safeRead(apiPackagePath),
  safeRead(webPackagePath),
  safeRead(webServerPath),
  safeRead(cliPackagePath),
  safeRead(cliSourcePath),
  safeRead(gateScriptPath),
  safeRead(tsconfigBasePath),
]);

if (!html) {
  console.error(`dist/index.html not found at ${distHtmlPath}. Run: pnpm --filter @fiber-mpp/evidence-web build`);
  process.exit(1);
}

await access(distDir).catch(() => {
  console.error(`dist/ directory not found. Run: pnpm --filter @fiber-mpp/evidence-web build`);
  process.exit(1);
});

const commandSurface = [
  html,
  distAssetsContent,
  rootPackageJson,
  apiPackageJson,
  webPackageJson,
  webServer,
  cliPackageJson,
  cliSource,
  gateScript,
  tsconfigBase,
].join("\n");

const requiredHtmlFragments = [
  '<div id="root"',
  '<script type="module"',
];

const requiredCommandFragments = [
  'evidence/reset',
  'evidence/export',
  'bootstrap/runtime',
  'bootstrap/runtime/reset',
  'x-fiber-mpp-session',
  'sessionId',
  'pollMs',
  'unpaid',
  'payment_settled',
  'receipt_returned',
  'replay_rejected',
  'challenge_received',
  'productionReady',
];

const requiredCliFragments = [
  'evidence-web',
  'evidence-api',
];

for (const fragment of requiredHtmlFragments) {
  if (!html.includes(fragment)) {
    console.error(`dist/index.html missing required fragment: ${fragment}`);
    process.exit(1);
  }
}

for (const fragment of requiredCommandFragments) {
  if (!commandSurface.includes(fragment)) {
    console.error(`Command surface missing required fragment: ${fragment}`);
    process.exit(1);
  }
}

for (const fragment of requiredCliFragments) {
  if (!commandSurface.includes(fragment)) {
    console.error(`CLI surface missing required fragment: ${fragment}`);
    process.exit(1);
  }
}

const distAssets = html.match(/\/assets\/[^"]+\.(js|css)/g) || [];
if (distAssets.length === 0) {
  console.error("dist/index.html has no bundled assets. Build may have failed.");
  process.exit(1);
}

console.log(`evidence-web dist check passed: ${distAssets.length} assets, ${requiredHtmlFragments.length} html anchors, ${requiredCommandFragments.length} command anchors`);
