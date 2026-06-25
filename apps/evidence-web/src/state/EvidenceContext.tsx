import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import type { ApiClient } from "../lib/api.js";
import {
  fallbackEndpoints,
  reportKeys,
  personaActionReason,
  mergeConsoleSettings,
} from "../constants.js";
import { sanitizeAmountInput, ckbToShannons, normalizeApiBase, readStorage, writeStorage, downloadJson, copyTextToClipboard, boundedInteger } from "../lib/utils.js";
import type {
  Persona,
  Density,
  WorkspaceTab,
  Phase,
  ApiConnection,
  Endpoint,
  Profile,
  RoleCapability,
  BootstrapRole,
  FlowEvent,
  BootstrapDraft,
  ConsolePreferences,
} from "../types.js";

interface FlowState {
  events?: FlowEvent[];
  fiberChallenge?: { paymentHash?: string } | null;
  authorization?: unknown | null;
  receipt?: { receiptId?: string; settlement?: { paymentHash?: string }; resourceHash?: string } | null;
  replayStatus?: number | null;
  challengeId?: string;
  challengeBody?: { challengeId?: string; resourceHash?: string; challenge?: { challengeId?: string } } | null;
  resourceHash?: string;
  resourceUrl?: string;
  credential?: { resourceHash?: string } | null;
  proof?: { mode?: string } | null;
  tournament?: unknown;
}

export interface EvidenceState {
  selected: string;
  status: StatusData | null;
  bootstrap: BootstrapData | null;
  configuration: ConfigurationData | null;
  profileSelection: { payer: string; payee: string; gateway: string };
  parameters: { amountCkb: string; amountShannons: string };
  bootstrapDraft: BootstrapDraft;
  apiConnection: ApiConnection;
  apiMessage: string;
  lastRefreshedAt: string | null;
  refreshing: boolean;
  autoRefresh: boolean;
  reports: Record<string, unknown>;
  workspaceTab: WorkspaceTab;
  persona: Persona;
  density: Density;
  settingsOpen: boolean;
  inspectorOpen: boolean;
  flow: FlowState;
  activeTab: string;
  phase: Phase;
  busy: boolean;
  activeAction: string | null;
  localLogs: FlowEvent[];
  actionHint: string;
}

interface StatusData {
  mode?: string;
  endpoints?: Endpoint[];
  blockers?: string[];
  badges?: Record<string, boolean | null>;
  productionEvidence?: Record<string, unknown>;
  localFiberNetwork?: Record<string, unknown> & { route?: unknown };
  engine?: { canonical: string; typescriptRole: string; typescriptTrustedBoundary: boolean };
  livePaymentEnabled?: boolean;
  flow?: FlowState;
}

interface BootstrapData {
  generatedAt?: string;
  mode?: string;
  liveReady?: boolean;
  evidence?: Record<string, unknown> & { productionReady?: boolean };
  roles?: BootstrapRole[];
}

interface ConfigurationData {
  generatedAt?: string;
  currency?: string;
  profiles?: Record<string, Profile[]>;
  executionRoleCapabilities?: Record<string, RoleCapability>;
  defaults?: {
    endpoint?: string;
    amountCkb?: string;
    amountShannons?: string;
    payerProfileId?: string;
    payeeProfileId?: string;
    gatewayProfileId?: string;
  };
  parameters?: { resources?: Endpoint[]; challengeTtlSeconds?: number; settlementTimeoutMs?: number; amountLimits?: Record<string, string> };
  envTemplate?: string;
  runtimeBootstrap?: Record<string, unknown> & { configured?: boolean; source?: string; mode?: string; secret?: string; blockers?: string[] };
  warnings?: string[];
}

interface RuntimeBootstrapSecrets {
  payerRpcAuth?: string;
  payeeRpcAuth?: string;
}

interface EvidenceContextValue extends EvidenceState {
  api: ApiClient;
  apiBase: string;
  validation: { ok: boolean; message: string };
  setApiBase: (base: string) => void;
  refreshAll: (reason: string) => Promise<void>;
  runAction: (action: string) => Promise<void>;
  resetEvidenceFlow: (reason: string) => Promise<void>;
  applyRuntimeBootstrap: (secrets?: RuntimeBootstrapSecrets) => Promise<void>;
  clearRuntimeBootstrap: () => Promise<void>;
  setSelected: (path: string) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setPersona: (p: Persona) => void;
  setDensity: (d: Density) => void;
  setAutoRefresh: (v: boolean) => void;
  setProfileSelection: (role: string, id: string) => void;
  setAmountCkb: (v: string) => void;
  setAmountShannons: (v: string) => void;
  setBootstrapDraft: (key: string, value: string | boolean) => void;
  setActiveTab: (tab: string) => void;
  clearLog: () => Promise<void>;
  exportEvidence: () => Promise<void>;
  copyEnv: () => Promise<void>;
  addLocalLog: (level: string, actor: string, message: string, detail?: string) => void;
}

const EvidenceContext = createContext<EvidenceContextValue | null>(null);

export function useEvidence(): EvidenceContextValue {
  const ctx = useContext(EvidenceContext);
  if (!ctx) throw new Error("useEvidence must be used within EvidenceProvider");
  return ctx;
}

function defaultFiberRpcCurrency(mode?: string): string {
  return mode === "testnet" ? "Fibt" : "Fibd";
}

function normalizeBootstrapDraft(saved?: BootstrapDraft): BootstrapDraft {
  const mode = saved?.mode === "testnet" ? "testnet" : "local";
  const savedCurrency = String(saved?.currency || "").trim();
  return {
    mode,
    payerRpcUrl: saved?.payerRpcUrl || "http://127.0.0.1:21714",
    payeeRpcUrl: saved?.payeeRpcUrl || "http://127.0.0.1:21716",
    routerRpcUrl: saved?.routerRpcUrl || "http://127.0.0.1:21715",
    currency: savedCurrency && savedCurrency !== "CKB" ? savedCurrency : defaultFiberRpcCurrency(mode),
    amountShannons: saved?.amountShannons || "100",
    generateRuntimeSecret: saved?.generateRuntimeSecret === true,
  };
}

function logEvent(level: string, actor: string, message: string, detail?: string): FlowEvent {
  return { time: new Date().toISOString(), level, actor, message, detail };
}

function fallbackBootstrap(mode: string, error?: Error): BootstrapData {
  const blocker = error?.message || "bootstrap API not loaded";
  const mkRole = (id: string, title: string): BootstrapRole => ({
    role: id, title, status: "blocked", summary: "Bootstrap checks require /api/bootstrap",
    checks: [{ id: "api", label: "Bootstrap API", value: "unavailable", status: "fail", source: "runtime" }],
    blockers: [blocker], nextSteps: ["start the evidence API"],
  });
  return {
    generatedAt: new Date().toISOString(),
    mode: mode || "unconfigured", liveReady: false,
    evidence: { localFiberE2e: false, testnetFiberE2e: false, productionOperationsReady: false, productionBootstrapReady: false, productionReady: false, gateReady: false, gateBlockers: [] },
    roles: [mkRole("payer", "Payer FNN"), mkRole("payee", "Payee FNN"), mkRole("gateway", "Rust Gateway")],
  };
}

function fallbackConfiguration(error?: Error): ConfigurationData {
  const fp = (role: string, title: string): Profile => ({
    id: `env-${role}`, role, label: title, mode: "unconfigured", status: "blocked",
    custody: role === "gateway" ? "rust-gateway" : "fnn-built-in-wallet",
    auth: "missing", source: "env", notes: ["Configuration API not loaded."],
    blockers: [error?.message || "start the evidence API"],
  });
  const fc = (role: string, label: string, boundary: string, env: string): RoleCapability => ({
    role, label, boundary, selectedProfileId: `env-${role}`, liveExecution: false,
    canSendPayment: false, canCreateInvoice: false, canInspectSettlement: false,
    canProtectResource: false, canIssueReceipt: false, rpcEnv: [env],
    blockers: [error?.message || `set ${env} and load /api/configuration`], notes: ["Configuration API not loaded."],
  });
  return {
    generatedAt: new Date().toISOString(), currency: "CKB",
    profiles: { payer: [fp("payer", "Payer FNN")], payee: [fp("payee", "Payee FNN")], gateway: [fp("gateway", "Rust Gateway")] },
    executionRoleCapabilities: {
      payer: fc("payer", "Payer client", "payer-client", "FIBER_PAYER_RPC_URL"),
      payee: fc("payee", "Payee FNN", "payee-fnn", "FIBER_PAYEE_RPC_URL"),
      gateway: fc("gateway", "Rust gateway", "rust-gateway", "FIBER_MPP_SECRET"),
    },
    defaults: { endpoint: fallbackEndpoints[0]!.path, amountCkb: "100", amountShannons: "100", payerProfileId: "env-payer", payeeProfileId: "env-payee", gatewayProfileId: "env-gateway" },
    parameters: { resources: fallbackEndpoints, challengeTtlSeconds: 120, settlementTimeoutMs: 30000, amountLimits: { minCkb: "0.00000001", maxCkb: "1000000000", minShannons: "1", maxShannons: "100000000000000000" } },
    envTemplate: ["RUN_FIBER_E2E=1", "FIBER_MODE=testnet", "FIBER_PAYER_RPC_URL=<payer-fnn-rpc-url>", "FIBER_PAYEE_RPC_URL=<payee-fnn-rpc-url>", "FIBER_MPP_SECRET=<32+ character random secret>", "FIBER_E2E_AMOUNT_SHANNONS=100"].join("\n"),
    warnings: [error?.message || "configuration API unavailable"],
  };
}

function inferPhase(flow: FlowState | undefined, current: Phase): Phase {
  if (flow?.replayStatus === 402) return "replay_rejected";
  if (flow?.receipt) return "receipt_returned";
  if (flow?.authorization || flow?.proof) return "payment_settled";
  if (flow?.fiberChallenge || flow?.challengeBody) return "challenge_received";
  return current || "idle";
}

export function EvidenceProvider({
  children,
  api,
  initialApiBase,
  savedPrefs,
  pollMs,
}: {
  children: React.ReactNode;
  api: ApiClient;
  initialApiBase: string;
  savedPrefs: ConsolePreferences;
  pollMs?: number;
}) {
  const [state, setState] = useState<EvidenceState>(() => ({
    selected: savedPrefs.selected || "/paid/protocol-service",
    status: null,
    bootstrap: null,
    configuration: null,
    profileSelection: {
      payer: savedPrefs.profileSelection?.payer || "env-payer",
      payee: savedPrefs.profileSelection?.payee || "env-payee",
      gateway: savedPrefs.profileSelection?.gateway || "env-gateway",
    },
    parameters: {
      amountCkb: savedPrefs.parameters?.amountCkb || "100",
      amountShannons: savedPrefs.parameters?.amountShannons || "100",
    },
    bootstrapDraft: normalizeBootstrapDraft(savedPrefs.bootstrapDraft),
    apiConnection: "refreshing",
    apiMessage: "connecting API",
    lastRefreshedAt: null,
    refreshing: false,
    autoRefresh: savedPrefs.autoRefresh !== false,
    reports: {},
    workspaceTab: (savedPrefs.workspaceTab || "flow") as WorkspaceTab,
    persona: mergeConsoleSettings(savedPrefs.consoleSettings).persona,
    density: mergeConsoleSettings(savedPrefs.consoleSettings).density,
    settingsOpen: false,
    inspectorOpen: true,
    flow: { events: [] },
    activeTab: "chain",
    phase: "idle",
    busy: false,
    activeAction: null,
    localLogs: [],
    actionHint: "",
  }));

  const [apiBaseState, setApiBaseState] = useState(initialApiBase);
  const autoRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const configLoadedRef = useRef(false);
  const hasSavedRunSelection = useRef(Boolean(savedPrefs.selected || savedPrefs.parameters || savedPrefs.profileSelection));

  const persist = useCallback((s: EvidenceState) => {
    writeStorage("fiberMppConsolePreferences", JSON.stringify({
      apiBase: apiBaseState,
      selected: s.selected,
      profileSelection: s.profileSelection,
      parameters: s.parameters,
      bootstrapDraft: s.bootstrapDraft,
      workspaceTab: s.workspaceTab,
      autoRefresh: s.autoRefresh,
      consoleSettings: { persona: s.persona, density: s.density },
    }));
  }, [apiBaseState]);

  const update = useCallback((patch: Partial<EvidenceState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      return next;
    });
  }, []);

  const addLocalLog = useCallback((level: string, actor: string, message: string, detail?: string) => {
    setState((prev) => ({ ...prev, localLogs: [...prev.localLogs, logEvent(level, actor, message, detail)] }));
  }, []);

  const validation = useCallback((): { ok: boolean; message: string } => {
    const amountCkb = String(state.parameters.amountCkb || "").trim();
    const amountShannons = String(state.parameters.amountShannons || "").trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(amountCkb) || ckbToShannons(amountCkb) === "0")
      return { ok: false, message: "enter a positive CKB amount with up to 8 decimals" };
    if (!/^\d+$/.test(amountShannons) || BigInt(amountShannons || "0") <= 0n)
      return { ok: false, message: "enter a positive integer Fiber amount" };
    if (BigInt(amountShannons) > 100000000000000000n)
      return { ok: false, message: "Fiber amount exceeds safety limit" };
    return { ok: true, message: "ready" };
  }, [state.parameters]);

  const selectedEndpoint = useCallback((): Endpoint => {
    return (state.status?.endpoints || fallbackEndpoints).find((e) => e.path === state.selected) || fallbackEndpoints[0]!;
  }, [state.status, state.selected]);

  const refreshAll = useCallback(async (reason: string) => {
    if (state.refreshing) return;
    update({ refreshing: true, apiConnection: "refreshing", apiMessage: reason });
    try {
      let refreshedStatusMode = state.status?.mode;
      await Promise.all([
        (async () => {
          try {
            const config = await api.getJson<ConfigurationData>("/api/configuration");
            if (!configLoadedRef.current && !hasSavedRunSelection.current) {
              const next = { ...state };
              next.selected = config.defaults?.endpoint || next.selected;
              next.parameters.amountCkb = config.defaults?.amountCkb || next.parameters.amountCkb;
              next.parameters.amountShannons = config.defaults?.amountShannons || next.parameters.amountShannons;
              next.profileSelection.payer = config.defaults?.payerProfileId || next.profileSelection.payer;
              next.profileSelection.payee = config.defaults?.payeeProfileId || next.profileSelection.payee;
              next.profileSelection.gateway = config.defaults?.gatewayProfileId || next.profileSelection.gateway;
              update({ configuration: config, selected: next.selected, parameters: next.parameters, profileSelection: next.profileSelection });
            } else {
              update({ configuration: config });
            }
            configLoadedRef.current = true;
          } catch (error) {
            update({ configuration: fallbackConfiguration(error as Error) });
            configLoadedRef.current = true;
            addLocalLog("ERROR", "configuration", "configuration API unavailable", (error as Error).message);
          }
        })(),
        (async () => {
          try {
            const status = await api.getJson<StatusData>("/api/status");
            refreshedStatusMode = status.mode;
            const flow = status.flow || state.flow;
            update({
              status,
              flow,
              phase: inferPhase(flow, state.phase),
              localLogs: [],
              selected: status.endpoints?.[0] && !status.endpoints.some((e) => e.path === state.selected) ? status.endpoints[0]!.path : state.selected,
            });
          } catch (error) {
            const fallbackStatus: StatusData = {
              mode: "api-unreachable",
              blockers: [`Evidence API unreachable at ${apiBaseState}`],
              endpoints: fallbackEndpoints,
              badges: { rustCanonicalEngine: null, tsVectorHarness: null, localFiberE2e: null, f402Compatibility: null, productionReady: false, gateReady: false },
              localFiberNetwork: {
                node1: { role: "payer", rpc: "127.0.0.1:21714", status: "unconfigured" },
                node2: { role: "router", rpc: "127.0.0.1:21715", status: "unconfigured" },
                node3: { role: "payee", rpc: "127.0.0.1:21716", status: "unconfigured" },
                route: [], routeSource: "unavailable", channelCount: null, channelCountSource: "unavailable", routeStatus: "api unreachable",
              },
              engine: { canonical: "rust", typescriptRole: "compatibility tooling", typescriptTrustedBoundary: false },
            };
            refreshedStatusMode = fallbackStatus.mode;
            update({ status: fallbackStatus });
            addLocalLog("ERROR", "web", "evidence API unreachable", (error as Error).message);
          }
        })(),
        (async () => {
          try {
            const bs = await api.getJson<BootstrapData>("/api/bootstrap");
            update({ bootstrap: bs });
          } catch (error) {
            update({ bootstrap: fallbackBootstrap(state.status?.mode || "unconfigured", error as Error) });
            addLocalLog("ERROR", "bootstrap", "bootstrap API unavailable", (error as Error).message);
          }
        })(),
        (async () => {
          const entries = await Promise.all(Object.entries(reportKeys).map(async ([key, slug]) => {
            try { return [key, await api.getJson(`/api/reports/${slug}`)]; } catch { return [key, { exists: false, path: `reports/${slug}.json` }]; }
          }));
          update({ reports: Object.fromEntries(entries) });
        })(),
      ]);
      const connected = refreshedStatusMode !== "api-unreachable";
      update({
        lastRefreshedAt: new Date().toISOString(),
        apiConnection: connected ? "connected" : "error",
        apiMessage: connected ? `connected ${apiBaseState}` : "API unreachable",
        refreshing: false,
      });
    } catch (error) {
      update({ apiConnection: "error", apiMessage: (error as Error).message || "refresh failed", refreshing: false });
      addLocalLog("ERROR", "web", "refresh failed", (error as Error).message);
    }
  }, [state.refreshing, state.phase, state.flow, state.selected, state.status, api, apiBaseState, update, addLocalLog]);

  const evidenceActionBody = useCallback(() => ({
    endpoint: state.selected,
    amountCkb: state.parameters.amountCkb,
    amountShannons: state.parameters.amountShannons,
    payerProfileId: state.profileSelection.payer,
    payeeProfileId: state.profileSelection.payee,
    gatewayProfileId: state.profileSelection.gateway,
  }), [state.selected, state.parameters, state.profileSelection]);

  const runAction = useCallback(async (action: string) => {
    if (state.busy) return;
    const perm = action === "unpaid" ? "send" : action;
    const reason = personaActionReason(state.persona, perm);
    if (reason) {
      addLocalLog("WARN", "role-guard", `${action} blocked`, reason);
      update({ actionHint: reason });
      return;
    }
    update({ busy: true, activeAction: action, phase: action === "unpaid" ? "unpaid_request_sent" : state.phase });
    try {
      const body = action === "unpaid" ? evidenceActionBody() : {};
      const result = await api.postJson<{ flow: FlowState }>(`/api/evidence/${action}`, body);
      const flow = result.flow || state.flow;
      const phase: Phase = action === "unpaid" ? "challenge_received" : action === "pay" ? "payment_settled" : action === "retry" ? "receipt_returned" : action === "replay" ? "replay_rejected" : state.phase;
      update({ flow, phase });
      try {
        const status = await api.getJson<StatusData>("/api/status");
        update({ status, flow: status.flow || flow });
      } catch { /* status refresh optional */ }
    } catch (error) {
      update({ phase: "failed" });
      addLocalLog("ERROR", "web", `${action} failed`, (error as Error).message);
    } finally {
      setState((prev) => {
        const next = { ...prev, busy: false, activeAction: null };
        persist(next);
        return next;
      });
    }
  }, [state.busy, state.persona, state.phase, state.flow, api, evidenceActionBody, update, addLocalLog, persist]);

  const resetEvidenceFlow = useCallback(async (reason: string) => {
    update({ flow: { events: [] }, phase: "idle" });
    try {
      const result = await api.postJson<{ flow: FlowState }>("/api/evidence/reset", {});
      update({ flow: result.flow || { events: [] } });
      addLocalLog("INFO", "configuration", "flow reset", reason);
    } catch (error) {
      addLocalLog("WARN", "configuration", "flow reset unavailable", (error as Error).message);
    }
  }, [api, update, addLocalLog]);

  const applyRuntimeBootstrap = useCallback(async (secrets: RuntimeBootstrapSecrets = {}) => {
    const reason = personaActionReason(state.persona, "bootstrap");
    if (reason) { addLocalLog("WARN", "role-guard", "runtime bootstrap blocked", reason); update({ actionHint: reason }); return; }
    update({ busy: true, activeAction: "runtime-bootstrap" });
    try {
      const body = {
        confirmRuntimeBootstrap: true, enableLive: true,
        mode: state.bootstrapDraft.mode,
        payerRpcUrl: state.bootstrapDraft.payerRpcUrl,
        payeeRpcUrl: state.bootstrapDraft.payeeRpcUrl,
        routerRpcUrl: state.bootstrapDraft.routerRpcUrl,
        currency: state.bootstrapDraft.currency,
        amountShannons: state.bootstrapDraft.amountShannons,
        generateRuntimeSecret: state.bootstrapDraft.generateRuntimeSecret,
        payerRpcAuth: secrets.payerRpcAuth || undefined,
        payeeRpcAuth: secrets.payeeRpcAuth || undefined,
      };
      const result = await api.postJson<{ bootstrap: BootstrapData; configuration: ConfigurationData; flow: FlowState; runtimeBootstrap?: { configured?: boolean; source?: string } }>("/api/bootstrap/runtime", body);
      const profileSelection = result.runtimeBootstrap?.configured
        ? { payer: "runtime-payer", payee: "runtime-payee", gateway: "runtime-gateway" }
        : state.profileSelection;
      update({
        bootstrap: result.bootstrap || state.bootstrap,
        configuration: result.configuration || state.configuration,
        flow: result.flow || { events: [] },
        profileSelection, phase: "idle" as Phase,
      });
      configLoadedRef.current = true;
      addLocalLog("INFO", "bootstrap", "runtime bootstrap applied", result.runtimeBootstrap?.source || "runtime");
    } catch (error) {
      addLocalLog("ERROR", "bootstrap", "runtime bootstrap failed", (error as Error).message);
    } finally {
      setState((prev) => { const next = { ...prev, busy: false, activeAction: null }; persist(next); return next; });
    }
  }, [state.persona, state.bootstrapDraft, state.profileSelection, state.bootstrap, state.configuration, api, update, addLocalLog, persist]);

  const clearRuntimeBootstrap = useCallback(async () => {
    const reason = personaActionReason(state.persona, "resetRuntime");
    if (reason) { addLocalLog("WARN", "role-guard", "runtime clear blocked", reason); update({ actionHint: reason }); return; }
    update({ busy: true, activeAction: "runtime-clear" });
    try {
      const result = await api.postJson<{ bootstrap: BootstrapData; configuration: ConfigurationData; flow: FlowState; runtimeBootstrap?: { source?: string } }>("/api/bootstrap/runtime/reset", {});
      update({
        bootstrap: result.bootstrap || state.bootstrap,
        configuration: result.configuration || state.configuration,
        flow: result.flow || { events: [] },
        profileSelection: { payer: "env-payer", payee: "env-payee", gateway: "env-gateway" },
        phase: "idle" as Phase,
      });
      addLocalLog("INFO", "bootstrap", "runtime bootstrap cleared", result.runtimeBootstrap?.source || "env");
    } catch (error) {
      addLocalLog("ERROR", "bootstrap", "runtime clear failed", (error as Error).message);
    } finally {
      setState((prev) => { const next = { ...prev, busy: false, activeAction: null }; persist(next); return next; });
    }
  }, [state.persona, state.bootstrap, state.configuration, api, update, addLocalLog, persist]);

  const clearLog = useCallback(async () => {
    update({ busy: true, activeAction: "reset", flow: { events: [] }, phase: "idle" as Phase, localLogs: [] });
    try {
      const result = await api.postJson<{ flow: FlowState }>("/api/evidence/reset", {});
      update({ flow: result.flow || { events: [] }, phase: "idle" as Phase, localLogs: [] });
    } catch (error) {
      update({ localLogs: [], flow: { events: [] } });
      addLocalLog("WARN", "web", "server reset unavailable", (error as Error).message);
    } finally {
      setState((prev) => { const next = { ...prev, busy: false, activeAction: null }; persist(next); return next; });
    }
  }, [api, update, addLocalLog, persist]);

  const exportEvidence = useCallback(async () => {
    if (state.busy) return;
    update({ busy: true, activeAction: "export" });
    try {
      const bundle = await api.postJson<{ generatedAt?: string }>("/api/evidence/export", evidenceActionBody());
      downloadJson(`fiber-mpp-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, bundle);
      addLocalLog("INFO", "evidence", "exported evidence bundle", bundle.generatedAt || "downloaded");
    } catch (error) {
      addLocalLog("ERROR", "evidence", "export failed", (error as Error).message);
    } finally {
      setState((prev) => { const next = { ...prev, busy: false, activeAction: null }; persist(next); return next; });
    }
  }, [state.busy, api, evidenceActionBody, update, addLocalLog, persist]);

  const copyEnv = useCallback(async () => {
    if (state.busy) return;
    update({ activeAction: "copy-env" });
    try {
      const base = state.configuration?.envTemplate || [
        "RUN_FIBER_E2E=1", "FIBER_MODE=testnet",
        "FIBER_PAYER_RPC_URL=<payer-fnn-rpc-url>", "FIBER_PAYEE_RPC_URL=<payee-fnn-rpc-url>",
        "FIBER_MPP_SECRET=<32+ character random secret>", "FIBER_E2E_AMOUNT_SHANNONS=100",
      ].join("\n");
      const patched = base.replace(/FIBER_E2E_AMOUNT_SHANNONS=.*/g, `FIBER_E2E_AMOUNT_SHANNONS=${state.parameters.amountShannons || "100"}`);
      const copied = await copyTextToClipboard(patched);
      addLocalLog(copied ? "INFO" : "WARN", "configuration", copied ? "env copied" : "env copy failed", "clipboard");
    } finally {
      update({ activeAction: null });
    }
  }, [state.busy, state.configuration, state.parameters.amountShannons, update, addLocalLog]);

  const setApiBase = useCallback((base: string) => {
    const normalized = normalizeApiBase(base);
    if (!normalized) return;
    setApiBaseState(normalized);
    writeStorage("fiberMppApi", normalized);
    api.setApiBase(normalized);
    configLoadedRef.current = false;
  }, [api]);

  const setWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setState((prev) => { const next = { ...prev, workspaceTab: tab }; persist(next); return next; });
  }, [persist]);

  const setSettingsOpen = useCallback((open: boolean) => update({ settingsOpen: open }), [update]);
  const setInspectorOpen = useCallback((open: boolean) => update({ inspectorOpen: open }), [update]);
  const setPersona = useCallback((p: Persona) => { setState((prev) => { const next = { ...prev, persona: p }; persist(next); return next; }); }, [persist]);
  const setDensity = useCallback((d: Density) => { setState((prev) => { const next = { ...prev, density: d }; persist(next); return next; }); }, [persist]);
  const setAutoRefresh = useCallback((v: boolean) => { setState((prev) => { const next = { ...prev, autoRefresh: v }; persist(next); return next; }); }, [persist]);
  const setSelected = useCallback((path: string) => { setState((prev) => { const next = { ...prev, selected: path }; persist(next); return next; }); }, [persist]);
  const setActiveTab = useCallback((tab: string) => update({ activeTab: tab }), [update]);

  const setProfileSelection = useCallback((role: string, id: string) => {
    setState((prev) => { const next = { ...prev, profileSelection: { ...prev.profileSelection, [role]: id } }; persist(next); return next; });
  }, [persist]);

  const setAmountCkb = useCallback((v: string) => {
    const sanitized = sanitizeAmountInput(v, true);
    setState((prev) => { const next = { ...prev, parameters: { ...prev.parameters, amountCkb: sanitized } }; persist(next); return next; });
  }, [persist]);

  const setAmountShannons = useCallback((v: string) => {
    const sanitized = sanitizeAmountInput(v, false);
    setState((prev) => { const next = { ...prev, parameters: { ...prev.parameters, amountShannons: sanitized } }; persist(next); return next; });
  }, [persist]);

  const setBootstrapDraft = useCallback((key: string, value: string | boolean) => {
    setState((prev) => {
      const v = key === "amountShannons" && typeof value === "string" ? sanitizeAmountInput(value, false) : value;
      const bootstrapDraft = { ...prev.bootstrapDraft, [key]: v };
      if (key === "mode" && typeof v === "string") {
        const oldDefault = defaultFiberRpcCurrency(prev.bootstrapDraft.mode);
        const currentCurrency = String(prev.bootstrapDraft.currency || "").trim();
        if (!currentCurrency || currentCurrency === "CKB" || currentCurrency === oldDefault) {
          bootstrapDraft.currency = defaultFiberRpcCurrency(v);
        }
      }
      const next = { ...prev, bootstrapDraft };
      persist(next);
      return next;
    });
  }, [persist]);

  // auto-refresh
  useEffect(() => {
    if (autoRefreshTimer.current) { clearInterval(autoRefreshTimer.current); autoRefreshTimer.current = null; }
    if (!state.autoRefresh) return;
    autoRefreshTimer.current = setInterval(() => {
      if (!state.busy && !state.refreshing) refreshAll("auto refresh");
    }, pollMs || 15000);
    return () => { if (autoRefreshTimer.current) clearInterval(autoRefreshTimer.current); };
  }, [state.autoRefresh, state.busy, state.refreshing, refreshAll]);

  // initial load
  useEffect(() => {
    refreshAll("initial");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.settingsOpen) { setSettingsOpen(false); return; }
      if (state.settingsOpen || event.target instanceof HTMLElement && event.target.closest("input, select, textarea")) return;
      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "u") runAction("unpaid");
      if (key === "p") runAction("pay");
      if (key === "r") runAction("retry");
      if (key === "y") runAction("replay");
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [state.settingsOpen, state.busy, runAction, setSettingsOpen]);

  const val: EvidenceContextValue = {
    ...state,
    api,
    apiBase: apiBaseState,
    validation: validation(),
    setApiBase,
    refreshAll,
    runAction,
    resetEvidenceFlow,
    applyRuntimeBootstrap,
    clearRuntimeBootstrap,
    setSelected,
    setWorkspaceTab,
    setSettingsOpen,
    setInspectorOpen,
    setPersona,
    setDensity,
    setAutoRefresh,
    setProfileSelection,
    setAmountCkb,
    setAmountShannons,
    setBootstrapDraft,
    setActiveTab,
    clearLog,
    exportEvidence,
    copyEnv,
    addLocalLog,
  };

  return React.createElement(EvidenceContext.Provider, { value: val }, children);
}
