import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export type BootstrapRole = "payer" | "payee" | "gateway";

export type GatewayConfig = {
  role?: "gateway";
  listen?: string;
  port?: number;
  server_id?: string;
  upstream?: string;
  storage?: string;
  price?: {
    value: string;
    currency: string;
    display?: string;
  };
  methods?: string[];
  secret_env?: string;
  fiber?: {
    mode?: "local" | "testnet";
    rpc_url?: string;
    payee_rpc_url?: string;
    payer_rpc_url?: string;
    rpc_auth?: string;
    payee_rpc_auth?: string;
    payer_rpc_auth?: string;
    payee_node_id?: string;
    payer_node_id?: string;
    asset?: string;
    currency?: string;
    settlement_timeout_ms?: number;
    settlement_poll_ms?: number;
  };
};

export type GatewayCliOptions = {
  config?: GatewayConfig;
  upstream?: string;
  priceUsd?: string;
  methods?: string;
  storage?: string;
  port?: string;
  serverId?: string;
};

export type ResolvedGatewayConfig = {
  upstream: string;
  price: { value: string; currency: string; display?: string };
  methods: string[];
  storage: string;
  port: number;
  serverId: string;
  secret: string;
  fiberEnv: NodeJS.ProcessEnv;
};

export type BootstrapReport = {
  role: BootstrapRole;
  status: "ready" | "blocked";
  blockers: string[];
  checks: Record<string, boolean | string | null>;
  next_steps: string[];
};

export class BootstrapError extends Error {
  public readonly report: BootstrapReport;

  public constructor(report: BootstrapReport) {
    super(`FiberMPP ${report.role} bootstrap blocked`);
    this.report = report;
  }
}

export function gatewayConfigTemplate(): GatewayConfig {
  return {
    role: "gateway",
    listen: "127.0.0.1:8790",
    server_id: "fiber-mpp-gateway",
    upstream: "http://localhost:8080",
    storage: "sqlite://./fiber-mpp.sqlite",
    price: {
      value: "0.01",
      currency: "USD",
      display: "$0.01"
    },
    methods: ["fiber"],
    secret_env: "FIBER_MPP_SECRET",
    fiber: {
      mode: "local",
      payee_rpc_url: "http://127.0.0.1:21716",
      payer_rpc_url: "http://127.0.0.1:21714",
      currency: "Fibd"
    }
  };
}

export async function writeGatewayConfigTemplate(path: string): Promise<GatewayConfig> {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const template = gatewayConfigTemplate();
  await writeFile(absolutePath, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
  return template;
}

export function parseGatewayConfig(value: unknown): GatewayConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Gateway config must be a JSON object");
  }
  const config = value as GatewayConfig;
  if (config.role && config.role !== "gateway") {
    throw new Error("Gateway config role must be gateway");
  }
  return config;
}

export function resolveGatewayConfig(options: GatewayCliOptions, env: NodeJS.ProcessEnv = process.env): ResolvedGatewayConfig {
  const config = options.config;
  const fiberEnv = fiberEnvFromGatewayConfig(config, env);
  const storage = normalizeStorageUri(options.storage ?? config?.storage ?? "sqlite://./fiber-mpp.sqlite");
  const serverId = options.serverId ?? config?.server_id ?? "fiber-mpp-gateway";
  const price = options.priceUsd
    ? { value: options.priceUsd, currency: "USD", display: `$${options.priceUsd}` }
    : config?.price ?? { value: "0.01", currency: "USD", display: "$0.01" };
  const methods = options.methods
    ? options.methods.split(",").map((method) => method.trim()).filter(Boolean)
    : config?.methods ?? ["fiber"];
  const upstream = options.upstream ?? config?.upstream;
  const port = parsePort(options.port, config);
  const secretEnv = config?.secret_env ?? "FIBER_MPP_SECRET";
  const secret = env[secretEnv];

  const report = buildBootstrapReport("gateway", {
    env: fiberEnv,
    secret,
    storage,
    upstream,
    methods,
    secretEnv
  });
  if (report.status === "blocked") {
    throw new BootstrapError(report);
  }
  return {
    upstream: upstream!,
    price,
    methods,
    storage,
    port,
    serverId,
    secret: secret!,
    fiberEnv
  };
}

export function buildBootstrapReport(
  role: BootstrapRole,
  input: {
    env?: NodeJS.ProcessEnv;
    secret?: string;
    storage?: string;
    upstream?: string;
    methods?: string[];
    secretEnv?: string;
  } = {}
): BootstrapReport {
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  const checks: BootstrapReport["checks"] = {};
  const mode = env.FIBER_MODE;
  const payeeRpc = env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
  const payerRpc = env.FIBER_PAYER_RPC_URL ?? env.FIBER_RPC_URL;

  checks.fiber_mode = mode === "local" || mode === "testnet" ? mode : null;
  if (mode !== "local" && mode !== "testnet") {
    blockers.push("set FIBER_MODE=local or FIBER_MODE=testnet");
  }

  if (role === "payer") {
    checks.payer_rpc_url = payerRpc ?? null;
    if (!payerRpc) {
      blockers.push("set FIBER_PAYER_RPC_URL or FIBER_RPC_URL for the payer node");
    }
  }

  if (role === "payee" || role === "gateway") {
    checks.payee_rpc_url = payeeRpc ?? null;
    if (!payeeRpc) {
      blockers.push("set FIBER_PAYEE_RPC_URL or FIBER_RPC_URL for the invoice/payee node");
    }
  }

  if (role === "gateway") {
    checks.upstream = input.upstream ?? null;
    checks.storage = input.storage ?? null;
    checks.secret_env = input.secretEnv ?? "FIBER_MPP_SECRET";
    checks.secret_present = Boolean(input.secret);
    checks.methods_fiber_only = input.methods?.every((method) => method === "fiber") ?? true;
    if (!input.upstream) {
      blockers.push("set an upstream URL with --upstream or gateway config upstream");
    }
    if (!input.storage?.startsWith("sqlite://")) {
      blockers.push("set storage to sqlite://path");
    }
    if (!input.secret || input.secret.length < 32) {
      blockers.push(`set ${input.secretEnv ?? "FIBER_MPP_SECRET"} to a random secret of at least 32 characters`);
    }
    if (input.methods && input.methods.some((method) => method !== "fiber")) {
      blockers.push("gateway methods must be fiber only");
    }
  }

  return {
    role,
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    checks,
    next_steps: nextSteps(role, blockers)
  };
}

export function fiberEnvFromGatewayConfig(config: GatewayConfig | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  const fiber = config?.fiber;
  if (!fiber) {
    return merged;
  }
  setEnv(merged, "FIBER_MODE", fiber.mode);
  setEnv(merged, "FIBER_RPC_URL", fiber.rpc_url);
  setEnv(merged, "FIBER_PAYEE_RPC_URL", fiber.payee_rpc_url);
  setEnv(merged, "FIBER_PAYER_RPC_URL", fiber.payer_rpc_url);
  setEnv(merged, "FIBER_RPC_AUTH", fiber.rpc_auth);
  setEnv(merged, "FIBER_PAYEE_RPC_AUTH", fiber.payee_rpc_auth);
  setEnv(merged, "FIBER_PAYER_RPC_AUTH", fiber.payer_rpc_auth);
  setEnv(merged, "FIBER_PAYEE_NODE_ID", fiber.payee_node_id);
  setEnv(merged, "FIBER_PAYER_NODE_ID", fiber.payer_node_id);
  setEnv(merged, "FIBER_ASSET", fiber.asset);
  setEnv(merged, "FIBER_CURRENCY", fiber.currency);
  setEnv(merged, "FIBER_SETTLEMENT_TIMEOUT_MS", fiber.settlement_timeout_ms);
  setEnv(merged, "FIBER_SETTLEMENT_POLL_MS", fiber.settlement_poll_ms);
  return merged;
}

function parsePort(value: string | undefined, config: GatewayConfig | undefined): number {
  const source = value ?? config?.port ?? portFromListen(config?.listen) ?? 8790;
  const parsed = typeof source === "number" ? source : Number(source);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid gateway port: ${String(source)}`);
  }
  return parsed;
}

function portFromListen(listen: string | undefined): number | undefined {
  if (!listen) {
    return undefined;
  }
  const match = listen.match(/:(\d+)$/) ?? listen.match(/^(\d+)$/);
  return match?.[1] ? Number(match[1]) : undefined;
}

function normalizeStorageUri(storage: string): string {
  if (storage.startsWith("sqlite://") || storage.includes("://")) {
    return storage;
  }
  return `sqlite://${storage}`;
}

function setEnv(env: NodeJS.ProcessEnv, key: string, value: string | number | undefined): void {
  if (typeof value !== "undefined") {
    env[key] = String(value);
  }
}

function nextSteps(role: BootstrapRole, blockers: string[]): string[] {
  if (blockers.length === 0) {
    return role === "gateway"
      ? ["start with fiber-mpp serve --config fiber-mpp.gateway.json"]
      : ["run a paid request or role-specific RPC check"];
  }
  if (role === "gateway") {
    return [
      "generate a gateway template with fiber-mpp init --role gateway --out fiber-mpp.gateway.json",
      "export FIBER_MPP_SECRET=$(openssl rand -hex 32)",
      "start or point at a payee Fiber node and set FIBER_MODE plus FIBER_PAYEE_RPC_URL",
      "run fiber-mpp doctor --role gateway --config fiber-mpp.gateway.json"
    ];
  }
  if (role === "payer") {
    return [
      "start or point at a funded payer Fiber node",
      "set FIBER_MODE and FIBER_PAYER_RPC_URL",
      "run fiber-mpp doctor --role payer"
    ];
  }
  return [
    "start or point at an invoice/payee Fiber node",
    "set FIBER_MODE and FIBER_PAYEE_RPC_URL",
    "run fiber-mpp doctor --role payee"
  ];
}
