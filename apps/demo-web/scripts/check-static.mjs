import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "..", "index.html");
const iconsPath = resolve(here, "..", "src", "components", "icons.tsx");
const [html, iconsTsx] = await Promise.all([
  readFile(htmlPath, "utf8"),
  readFile(iconsPath, "utf8")
]);

const spriteStart = '<script id="lucide-icon-sprite" type="application/json">';
const spriteEnd = "</script>";
const spriteStartIndex = html.indexOf(spriteStart);
const spriteEndIndex = html.indexOf(spriteEnd, spriteStartIndex);

assert(spriteStartIndex >= 0 && spriteEndIndex > spriteStartIndex, "Missing lucide-react icon sprite");

const spriteJson = html.slice(spriteStartIndex + spriteStart.length, spriteEndIndex).trim();
const sprite = JSON.parse(spriteJson);
const htmlWithoutSprite = html.slice(0, spriteStartIndex) + html.slice(spriteEndIndex + spriteEnd.length);

const requiredHtmlFragments = [
  '<div class="badges" id="badges">',
  '<div class="timeline" id="timeline">',
  '<div class="route-chips" id="route-chips">',
  'data-lucide-icon="RequestScenario"',
  'data-lucide-icon="ActionSend"',
  'data-lucide-icon="ActionPay"',
  'data-lucide-icon="ActionRetry"',
  'data-lucide-icon="ActionReplay"',
  'data-lucide-icon="ClearLog"',
  'data-lucide-icon="Terminal"',
  'data-lucide-icon="Activity"',
  'postJson("/api/demo/reset", {})',
  "function copyTextToClipboard(value)",
  "timeline-row-enter",
  "flow-scan",
  "evidence-refresh",
  "log-enter",
  "action-icon-tick",
  "actuator-blocked-flash",
  "prefers-reduced-motion: reduce",
  "state.activeAction",
  "pulseElement(json, \"evidence-refresh\")",
  "row.classList.add(status)",
  "classList.toggle(\"is-busy\"",
  'function iconHtml(name, label)',
  'function hydrateLucideIcons(root = document)',
  'function isLiveFiberFlow()',
  'function channelEvidenceText(network)',
  'Live Fiber required',
  'No payment executed',
  'route_source:',
  'channel_count_source:',
  'Production Ready',
  'Compatibility Tooling',
  'function badgeState(label, value)',
  'function vectorSummary(canonical)',
  'function unavailableEvidence(reason)',
  'function renderServiceActuatorStatus()',
  'demo actions disabled',
  'SERVICE / ACTUATOR STATUS',
  'function serviceActuatorStatus()',
  'const actuatorStates = new Set(["idle", "active", "executing", "blocked", "error"])',
  'receipt reissued',
  'actuator/API health',
  'height: calc(100vh - 24px);',
  'overflow-y: auto;'
];

const requiredIconNames = [
  "ActionPay",
  "ActionReplay",
  "ActionRetry",
  "ActionSend",
  "Activity",
  "ActorClient",
  "ActorFiber",
  "ActorProtectedApi",
  "ActorServer",
  "AttackReplay",
  "CanonicalParity",
  "ClearLog",
  "Copy",
  "Copied",
  "Evidence",
  "F402",
  "FiberNetwork",
  "Method",
  "PaymentReceipt",
  "Price",
  "ReportArtifact",
  "RequestScenario",
  "ResourceHash",
  "Route",
  "SecurityMatrix",
  "StatusFailed",
  "StatusPassed",
  "StatusUnavailable",
  "Terminal",
  "Timeline",
  "VectorHarness"
];

const requiredIconSourceFragments = [
  'from "lucide-react"',
  "export const ICON_SIZE = 16;",
  "export const ICON_STROKE_WIDTH = 1.75;",
  "function wrapIcon(name: ConsoleIconName, Icon: LucideIcon)",
  'color="currentColor"',
  "consoleIconComponents",
  "ClearLogIcon"
];

const forbiddenFragments = [
  '<div class="route-chips"><span>node1</span><span>node2</span><span>node3</span></div>',
  "network.channelCount || 2",
  'step("FIBER NODE B / C", "Settlement across route"',
  "evidence console static build ok",
  "evidence console static lint ok",
  "evidence console static typecheck ok",
  "rustCanonicalEngine: false",
  "canonical.shared_vectors_passed_rust || 14",
  "canonical.error_code_parity ?? true",
  "canonical.f402_parity ?? true",
  "canonical.canonical_hash_parity ?? true",
  "vectors verified",
  "402 challenge ready",
  'class="glyph"',
  ".glyph",
  'actor-icon">${step.icon}',
  ">C</button>",
  ">OK<",
  " Fibd",
  " USD",
  "$0.01",
  "Protected Service",
  "service-mark",
  "service-card",
  "ROBOT STATUS",
  "RobotApiStatus",
  "lottie",
  "https://lottie",
  "http://lottie"
];

for (const fragment of requiredHtmlFragments) {
  assert(html.includes(fragment), `Missing required static console fragment: ${fragment}`);
}

for (const fragment of requiredIconSourceFragments) {
  assert(iconsTsx.includes(fragment), `Missing Lucide icon wrapper source fragment: ${fragment}`);
}

for (const iconName of requiredIconNames) {
  assert(Object.hasOwn(sprite, iconName), `Lucide sprite missing ${iconName}`);
  assert(iconsTsx.includes(`"${iconName}"`), `icons.tsx missing ${iconName}`);
  assert(sprite[iconName].includes('stroke="currentColor"'), `${iconName} does not inherit currentColor`);
  assert(sprite[iconName].includes('stroke-width="1.75"'), `${iconName} does not use the console stroke width`);
  assert(sprite[iconName].includes('data-console-icon="' + iconName + '"'), `${iconName} sprite is not tagged`);
}

for (const fragment of forbiddenFragments) {
  assert(!html.includes(fragment), `Found legacy static console fragment: ${fragment}`);
}

for (const iconName of collectIconReferences(html)) {
  assert(Object.hasOwn(sprite, iconName), `HTML references unknown Lucide icon: ${iconName}`);
}

for (const tag of htmlWithoutSprite.match(/<svg\b[^>]*>/g) || []) {
  assert(tag.includes('class="actuator-glyph"'), `Only the service actuator custom SVG is allowed outside the Lucide sprite: ${tag}`);
}

for (const match of htmlWithoutSprite.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
  const [, attrs, body] = match;
  const visibleText = body.replace(/<[^>]+>/g, "").trim();
  if (visibleText.length === 0) {
    assert(/\baria-label=/.test(attrs), `Icon-only button is missing aria-label: ${match[0].slice(0, 120)}`);
  }
}

assert(!/src=["']https?:\/\//.test(html), "Remote visual assets are not allowed in the static console");
assert(!/href=["']https?:\/\//.test(html), "Remote visual assets are not allowed in the static console");
assert(count(html, "const result = await postJson(`/api/demo/${action}`, body);") === 1, "Demo action must call its backend endpoint exactly once");
assert(htmlWithoutSprite.includes("100 CKB"), "Static fallback pricing must use CKB");
assert(!htmlWithoutSprite.includes("Fibd"), "Frontend pricing must not display Fibd");
assert(!htmlWithoutSprite.includes("USD"), "Frontend pricing must not display USD");
assertModuleScriptParses(htmlWithoutSprite);
assert(count(html, "<script") === count(html, "</script>"), "Unbalanced script tags");
assert(count(html, "<style") === count(html, "</style>"), "Unbalanced style tags");
assert(count(html, "<section") === count(html, "</section>"), "Unbalanced section tags");

console.log(`evidence console static checks passed: ${requiredHtmlFragments.length} fragments, ${requiredIconNames.length} lucide icons, ${forbiddenFragments.length} regressions`);

function collectIconReferences(source) {
  const names = new Set();
  for (const match of source.matchAll(/data-lucide-icon="([^"]+)"/g)) {
    if (!match[1].includes("${")) {
      names.add(match[1]);
    }
  }
  for (const match of source.matchAll(/iconHtml\("([^"]+)"/g)) {
    names.add(match[1]);
  }
  return names;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertModuleScriptParses(source) {
  const moduleScriptMatch = source.match(/<script type="module">([\s\S]*)<\/script>/);
  assert(moduleScriptMatch, "Missing module script");
  try {
    new Function(moduleScriptMatch[1]);
  } catch (error) {
    throw new Error(`Module script does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}
