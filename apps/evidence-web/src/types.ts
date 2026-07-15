export type Persona = "operator" | "payer" | "payee" | "auditor";
export type Density = "standard" | "compact";
export type FlowMode = "guided" | "manual";
export type WorkspaceTab = "bootstrap" | "flow" | "tournament" | "evidence" | "attacks" | "network";
export type Phase =
  | "idle"
  | "unpaid_request_sent"
  | "challenge_received"
  | "payment_settled"
  | "receipt_returned"
  | "replay_rejected"
  | "failed";
export type ApiConnection = "refreshing" | "connected" | "error";

export interface Endpoint {
  path: string;
  label: string;
  charge: { amount: string; currency: string; display: string };
}

export interface Profile {
  id: string;
  role: string;
  label: string;
  mode?: string;
  status: string;
  custody: string;
  auth?: string;
  source: string;
  notes?: string[];
  blockers?: string[];
}

export interface RoleCapability {
  role: string;
  label: string;
  boundary: string;
  selectedProfileId: string;
  liveExecution: boolean;
  canSendPayment: boolean;
  canCreateInvoice: boolean;
  canInspectSettlement: boolean;
  canProtectResource: boolean;
  canIssueReceipt: boolean;
  rpcEnv?: string[];
  blockers?: string[];
  notes?: string[];
}

export interface BootstrapRole {
  role: string;
  title: string;
  status: string;
  summary?: string;
  checks?: { id: string; label: string; value: unknown; status: string; source?: string }[];
  blockers?: string[];
  nextSteps?: string[];
}

export interface FlowEvent {
  time: string;
  level: string;
  actor: string;
  message: string;
  detail?: string;
}

export interface ConsolePreferences {
  apiBase?: string;
  selected?: string;
  profileSelection?: { payer: string; payee: string; gateway: string };
  parameters?: { amountCkb: string; amountShannons: string };
  bootstrapDraft?: BootstrapDraft;
  workspaceTab?: WorkspaceTab;
  autoRefresh?: boolean;
  flowMode?: FlowMode;
  consoleSettings?: { persona: Persona; density: Density };
}

export interface BootstrapDraft {
  mode: string;
  payerRpcUrl: string;
  payeeRpcUrl: string;
  routerRpcUrl: string;
  currency: string;
  amountShannons: string;
  generateRuntimeSecret: boolean;
}
