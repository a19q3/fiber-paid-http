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
  { id: "flow", label: "Flow", icon: "Timeline" },
  { id: "bootstrap", label: "Bootstrap", icon: "FiberNetwork" },
  { id: "tournament", label: "Tournament", icon: "Tournament" },
  { id: "evidence", label: "Evidence", icon: "Evidence" },
  { id: "attacks", label: "Attacks", icon: "AttackReplay" },
  { id: "network", label: "Network", icon: "FiberNetwork" },
] as const;

export const reportKeys = {
  canonical: "canonical",
  fiber: "fiber-local",
  fiberTestnet: "fiber-testnet",
  productionOps: "production-ops",
  productionBootstrap: "production-bootstrap",
  security: "security",
  gate: "gate",
  gateLocal: "gate-local",
  gateDefault: "gate-default",
  rustGate: "rust-gate",
  tsGate: "ts-gate",
} as const;

export const reportDisplayList = [
  { file: "canonical-core-parity.json", key: "canonical" as const },
  { file: "fiber-testnet-e2e-success.json", key: "fiberTestnet" as const },
  { file: "fiber-local-e2e-evidence.json", key: "fiber" as const },
  { file: "production-operations-matrix.json", key: "productionOps" as const },
  { file: "production-bootstrap-e2e.json", key: "productionBootstrap" as const },
  { file: "fiber-paid-http-gate.json", key: "gate" as const },
  { file: "fiber-paid-http-gate.local.json", key: "gateLocal" as const },
  { file: "fiber-paid-http-gate.default.json", key: "gateDefault" as const },
  { file: "security-matrix.json", key: "security" as const },
];

export const consolePersonas: Record<Persona, { title: string; summary: string }> = {
  operator: {
    title: "Operator / evidence auditor",
    summary: "Runs the full 402 -> Fiber payment -> protected service -> receipt evidence flow, with replay rejection as an optional security check.",
  },
  payer: {
    title: "Payer client",
    summary: "Prioritizes the protected request, payer wallet profile, amount, and authenticated request continuation.",
  },
  payee: {
    title: "Payee / gateway operator",
    summary: "Prioritizes invoice issuance, protected resource verification, receipt issuance, and replay-store evidence.",
  },
  auditor: {
    title: "Security auditor",
    summary: "Prioritizes evidence artifacts, canonical parity, bootstrap blockers, and replay rejection records.",
  },
};

export const personaCapabilities: Record<Persona, Record<string, boolean>> = {
  operator: { send: true, pay: true, continue: true, replay: true, bootstrap: true, resetRuntime: true, exportEvidence: true },
  payer: { send: true, pay: true, continue: true, replay: true, bootstrap: true, resetRuntime: false, exportEvidence: true },
  payee: { send: false, pay: false, continue: false, replay: false, bootstrap: true, resetRuntime: true, exportEvidence: true },
  auditor: { send: false, pay: false, continue: false, replay: false, bootstrap: false, resetRuntime: false, exportEvidence: true },
};

const personaActionLabels: Record<string, string> = {
  send: "send unpaid requests",
  pay: "execute payer Fiber payments",
  continue: "continue with Authorization: Payment",
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
  return `${title} cannot ${personaActionLabels[action] || action}; switch to Operator if this is an intentional cross-role operation.`;
}

export function mergeConsoleSettings(value: unknown): { persona: Persona; density: Density } {
  const saved = value && typeof value === "object" ? (value as Record<string, string>) : {};
  const persona = consolePersonas[saved.persona as Persona] ? (saved.persona as Persona) : "operator";
  const density = saved.density === "compact" ? "compact" : "standard";
  return { persona, density };
}
