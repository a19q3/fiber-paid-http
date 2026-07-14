import type { Endpoint, Persona, Density } from "./types.js";

export const DEFAULT_API_BASE = "http://localhost:8787";
export const API_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_AUTO_REFRESH_MS = 15000;

export const fallbackEndpoints: Endpoint[] = [
  { path: "/paid/protocol-service", label: "GET /paid/protocol-service", charge: { amount: "100", currency: "ckb", display: "0.000001 CKB" } },
  { path: "/paid/weather", label: "GET /paid/weather", charge: { amount: "10", currency: "ckb", display: "0.0000001 CKB" } },
  { path: "/paid/mpp-tool", label: "GET /paid/mpp-tool", charge: { amount: "50", currency: "ckb", display: "0.0000005 CKB" } },
  { path: "/paid/file", label: "GET /paid/file", charge: { amount: "25", currency: "ckb", display: "0.00000025 CKB" } },
];

export const evidenceTabs = [
  { id: "chain", label: "Chain Data", icon: "Evidence" },
  { id: "receipt", label: "Payment Receipt", icon: "PaymentReceipt" },
  { id: "security", label: "Security Matrix", icon: "SecurityMatrix" },
  { id: "canonical", label: "Canonical Parity", icon: "CanonicalParity" },
  { id: "fiber", label: "Fiber Evidence", icon: "FiberNetwork" },
] as const;

export const workspaceTabs = [
  { id: "overview", label: "Overview", icon: "Overview", group: "Build" },
  { id: "flow", label: "Payment demo", icon: "Timeline", group: "Build" },
  { id: "evidence", label: "Verifier", icon: "Evidence", group: "Verify" },
  { id: "attacks", label: "Security", icon: "AttackReplay", group: "Verify" },
  { id: "tournament", label: "Battlecode", icon: "Tournament", group: "Explore" },
  { id: "bootstrap", label: "Runtime setup", icon: "FiberNetwork", group: "Operate" },
  { id: "network", label: "Network health", icon: "Activity", group: "Operate" },
] as const;

export interface ReportEntry {
  key: string;
  slug: string;
  file?: string;
}

export const reportRegistry: readonly ReportEntry[] = [
  { key: "canonical", slug: "canonical", file: "canonical-core-parity.json" },
  { key: "fiberTestnet", slug: "fiber-testnet", file: "fiber-testnet-e2e-success.json" },
  { key: "fiber", slug: "fiber-local", file: "fiber-local-e2e-evidence.json" },
  { key: "productionOps", slug: "production-ops", file: "production-operations-matrix.json" },
  { key: "productionBootstrap", slug: "production-bootstrap", file: "production-bootstrap-e2e.json" },
  { key: "gate", slug: "gate", file: "fiber-paid-http-gate.json" },
  { key: "gateLocal", slug: "gate-local", file: "fiber-paid-http-gate.local.json" },
  { key: "gateDefault", slug: "gate-default", file: "fiber-paid-http-gate.default.json" },
  { key: "security", slug: "security", file: "security-matrix.json" },
  { key: "rustGate", slug: "rust-gate" },
  { key: "tsGate", slug: "ts-gate" },
];

export const reportDisplayList: ReadonlyArray<{ key: string; file: string }> = reportRegistry
  .filter((e): e is ReportEntry & { file: string } => Boolean(e.file))
  .map((e) => ({ key: e.key, file: e.file }));

export const consolePersonas: Record<Persona, { title: string; summary: string }> = {
  operator: {
    title: "Full payment flow",
    summary: "Shows and enables the complete 402 -> Fiber payment -> receipt -> replay rejection sequence across client, Fiber, gateway, and upstream.",
  },
  payer: {
    title: "Payer perspective",
    summary: "Emphasizes the protected request, payer profile, amount, payment execution, and Authorization: Payment retry path.",
  },
  payee: {
    title: "Payee perspective",
    summary: "Emphasizes invoice issuance, protected resource verification, receipt issuance, and replay-store evidence.",
  },
  auditor: {
    title: "Read-only audit",
    summary: "Exposes evidence artifacts, canonical parity, runtime blockers, and replay rejection records without executing payment actions.",
  },
};

export const personaCapabilities: Record<Persona, Record<string, boolean>> = {
  operator: { send: true, pay: true, retry: true, replay: true, bootstrap: true, resetRuntime: true, exportEvidence: true },
  payer: { send: true, pay: true, retry: true, replay: true, bootstrap: true, resetRuntime: false, exportEvidence: true },
  payee: { send: true, pay: false, retry: true, replay: true, bootstrap: true, resetRuntime: true, exportEvidence: true },
  auditor: { send: false, pay: false, retry: false, replay: false, bootstrap: false, resetRuntime: false, exportEvidence: true },
};

const personaActionLabels: Record<string, string> = {
  send: "send unpaid requests",
  pay: "execute payer Fiber payments",
  retry: "retry with Authorization: Payment",
  replay: "replay credentials",
  bootstrap: "apply runtime bootstrap",
  resetRuntime: "clear runtime bootstrap",
  exportEvidence: "export evidence",
};

export function personaCan(persona: Persona, action: string): boolean {
  return Boolean(personaCapabilities[persona]?.[action]);
}

export function personaActionReason(persona: Persona, action: string): string {
  if (personaCan(persona, action)) return "";
  const title = consolePersonas[persona]?.title || persona;
  return `${title} cannot ${personaActionLabels[action] || action}; switch to Full payment flow if this is an intentional cross-role operation.`;
}

export function mergeConsoleSettings(value: unknown): { persona: Persona; density: Density } {
  const saved = value && typeof value === "object" ? (value as Record<string, string>) : {};
  const persona = consolePersonas[saved.persona as Persona] ? (saved.persona as Persona) : "operator";
  const density = saved.density === "compact" ? "compact" : "standard";
  return { persona, density };
}
