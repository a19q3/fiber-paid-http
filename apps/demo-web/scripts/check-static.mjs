import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "..", "index.html");
const html = await readFile(htmlPath, "utf8");

const requiredFragments = [
  '<div class="badges" id="badges">',
  '<div class="timeline" id="timeline">',
  '<div class="route-chips" id="route-chips">',
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
  'function unavailableEvidence(reason)'
];

const forbiddenFragments = [
  '<div class="route-chips"><span>node1</span><span>node2</span><span>node3</span></div>',
  'network.channelCount || 2',
  'step("FIBER NODE B / C", "Settlement across route"',
  'evidence console static build ok',
  'evidence console static lint ok',
  'evidence console static typecheck ok',
  'rustCanonicalEngine: false',
  'canonical.shared_vectors_passed_rust || 14',
  'canonical.error_code_parity ?? true',
  'canonical.f402_parity ?? true',
  'canonical.canonical_hash_parity ?? true'
];

for (const fragment of requiredFragments) {
  assert(html.includes(fragment), `Missing required static console fragment: ${fragment}`);
}

for (const fragment of forbiddenFragments) {
  assert(!html.includes(fragment), `Found legacy static console fragment: ${fragment}`);
}

assert(count(html, "<script") === count(html, "</script>"), "Unbalanced script tags");
assert(count(html, "<style") === count(html, "</style>"), "Unbalanced style tags");
assert(count(html, "<section") === count(html, "</section>"), "Unbalanced section tags");

console.log(`evidence console static checks passed: ${requiredFragments.length} fragments, ${forbiddenFragments.length} regressions`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}
