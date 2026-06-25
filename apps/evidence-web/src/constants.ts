import type { Endpoint, Persona, Density } from "./types.js";

export const DEFAULT_API_BASE = "http://localhost:8787";
export const API_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_AUTO_REFRESH_MS = 15000;

export const fallbackEndpoints: Endpoint[] = [
  { path: "/paid/protocol-service", label: "GET /paid/protocol-service", price: { display: "100 CKB" }, fiberAmountShannons: "100" },
  { path: "/paid/weather", label: "GET /paid/weather", price: { display: "10 CKB" }, fiberAmountShannons: "10" },
  { path: "/paid/mpp-tool", label: "GET /paid/mpp-tool", price: { display: "50 CKB" }, fiberAmountShannons: "50" },
  { path: "/paid/file", label: "GET /paid/file", price: { display: "25 CKB" }, fiberAmountShannons: "25" },
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
  { file: "fiber-mpp-gate.json", key: "gate" as const },
  { file: "fiber-mpp-gate.local.json", key: "gateLocal" as const },
  { file: "fiber-mpp-gate.default.json", key: "gateDefault" as const },
  { file: "security-matrix.json", key: "security" as const },
];

export const consolePersonas: Record<Persona, { title: string; summary: string }> = {
  operator: {
    title: "Operator / evidence auditor",
    summary: "Runs the full 402 -> Fiber payment -> receipt -> replay rejection evidence flow across payer, payee, and gateway roles.",
  },
  payer: {
    title: "Payer client",
    summary: "Prioritizes the protected request, payer wallet profile, amount, and Authorization: Payment retry path.",
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
  return `${title} cannot ${personaActionLabels[action] || action}; switch to Operator if this is an intentional cross-role operation.`;
}

export function mergeConsoleSettings(value: unknown): { persona: Persona; density: Density } {
  const saved = value && typeof value === "object" ? (value as Record<string, string>) : {};
  const persona = consolePersonas[saved.persona as Persona] ? (saved.persona as Persona) : "operator";
  const density = saved.density === "compact" ? "compact" : "standard";
  return { persona, density };
}
