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
  previous_secret_envs?: string[];
  cors?: {
    allowed_origins?: string[];
    allowed_headers?: string[];
    allowed_methods?: string[];
    expose_headers?: string[];
    allow_credentials?: boolean;
    max_age_seconds?: number;
  };
  operations?: {
    health_path?: string;
    readiness_path?: string;
    metrics_path?: string;
    request_body_limit_bytes?: number;
    shutdown_grace_ms?: number;
    log_redaction?: {
      enabled?: boolean;
      extra_keys?: string[];
    };
    rate_limit?: {
      window_ms?: number;
      max_requests?: number;
    };
  };
  fiber?: {
    mode?: "local" | "testnet";
    rpc_url?: string;
    payee_rpc_url?: string;
    payer_rpc_url?: string;
    rpc_auth?: string;
    rpc_auth_env?: string;
    payee_rpc_auth?: string;
    payee_rpc_auth_env?: string;
    payer_rpc_auth?: string;
    payer_rpc_auth_env?: string;
    payee_node_id?: string;
    payer_node_id?: string;
    asset?: string;
    currency?: string;
    settlement_timeout_ms?: number;
    settlement_poll_ms?: number;
  };
  fl402?: {
    root_key_env?: string;
    hash_algorithm?: "ckb_hash" | "sha256";
  };
};

type GatewayPrice = NonNullable<GatewayConfig["price"]>;

export type GatewayCorsPolicy = {
  allowedOrigins: string[];
  allowedHeaders: string[];
  allowedMethods: string[];
  exposeHeaders: string[];
  allowCredentials: boolean;
  maxAgeSeconds?: number;
};

export type GatewayOperations = {
  healthPath: string;
  readinessPath: string;
  metricsPath: string;
  requestBodyLimitBytes: number;
  shutdownGraceMs: number;
  logRedaction: {
    enabled: boolean;
    extraKeys: string[];
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
};

export type GatewayCliOptions = {
  config?: GatewayConfig;
  upstream?: string;
  priceCkb?: string;
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
  secretEnv: string;
  previousSecretEnvs: string[];
  previousSecrets: string[];
  fiberEnv: NodeJS.ProcessEnv;
  fl402?: {
    rootKey: string;
    rootKeyEnv: string;
    hashAlgorithm: "ckb_hash" | "sha256";
  };
  cors: GatewayCorsPolicy;
  operations: GatewayOperations;
};

export type BootstrapReport = {
  role: BootstrapRole;
  status: "ready" | "blocked";
  blockers: string[];
  checks: Record<string, boolean | string | number | null>;
  next_steps: string[];
};

export type FiberRpcProbeRole = "payer" | "payee";

export type FiberRpcReadinessProbe = {
  ok: boolean;
  blockers: string[];
  checks: Record<string, boolean | string | number | null>;
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
      value: "1",
      currency: "CKB",
      display: "1 CKB"
    },
    methods: ["fiber"],
    secret_env: "FIBER_MPP_SECRET",
    previous_secret_envs: [],
    cors: {
      allowed_origins: [],
      allowed_headers: ["authorization", "content-type"],
      allowed_methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      expose_headers: ["payment-receipt", "www-authenticate"],
      allow_credentials: false,
      max_age_seconds: 600
    },
    operations: {
      health_path: "/healthz",
      readiness_path: "/readyz",
      metrics_path: "/metrics",
      request_body_limit_bytes: 1048576,
      shutdown_grace_ms: 10000,
      log_redaction: {
        enabled: true,
        extra_keys: []
      },
      rate_limit: {
        window_ms: 60000,
        max_requests: 300
      }
    },
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
  const price = options.priceCkb
    ? { value: options.priceCkb, currency: "CKB", display: `${options.priceCkb} CKB` }
    : config?.price ?? { value: "1", currency: "CKB", display: "1 CKB" };
  const methods = options.methods
    ? options.methods.split(",").map((method) => method.trim()).filter(Boolean)
    : config?.methods ?? ["fiber"];
  const upstream = options.upstream ?? config?.upstream;
  const port = parsePort(options.port, config);
  const secretEnv = config?.secret_env ?? "FIBER_MPP_SECRET";
  const secret = env[secretEnv];
  const previousSecretResolution = previousSecretsFromGatewayConfig(config, env);
  const fl402Configured = Boolean(config?.fl402);
  const fl402RootKeyEnv = config?.fl402?.root_key_env ?? "FIBER_MPP_FL402_ROOT_KEY";
  const fl402RootKey = fl402Configured ? env[fl402RootKeyEnv] : undefined;
  const fl402HashAlgorithm = config?.fl402?.hash_algorithm ?? "ckb_hash";
  const cors = resolveGatewayCorsPolicy(config);
  const operations = resolveGatewayOperations(config);

  const report = buildBootstrapReport("gateway", {
    env: fiberEnv,
    secret,
    storage,
    upstream,
    methods,
    secretEnv,
    previousSecretEnvs: previousSecretResolution.secretEnvs,
    previousSecrets: previousSecretResolution.secrets,
    missingPreviousSecretEnvs: previousSecretResolution.missing,
    shortPreviousSecretEnvs: previousSecretResolution.short,
    literalRpcAuth: gatewayConfigHasLiteralRpcAuth(config),
    price,
    fl402Configured,
    fl402RootKeyEnv,
    fl402RootKey,
    fl402HashAlgorithm,
    cors,
    operations
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
    secretEnv,
    previousSecretEnvs: previousSecretResolution.secretEnvs,
    previousSecrets: previousSecretResolution.secrets,
    fiberEnv,
    fl402: fl402Configured
      ? {
          rootKey: fl402RootKey!,
          rootKeyEnv: fl402RootKeyEnv,
          hashAlgorithm: fl402HashAlgorithm
        }
      : undefined,
    cors,
    operations
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
    previousSecretEnvs?: string[];
    previousSecrets?: string[];
    missingPreviousSecretEnvs?: string[];
    shortPreviousSecretEnvs?: string[];
    literalRpcAuth?: boolean;
    price?: GatewayPrice;
    fl402Configured?: boolean;
    fl402RootKeyEnv?: string;
    fl402RootKey?: string;
    fl402HashAlgorithm?: string;
    cors?: GatewayCorsPolicy;
    operations?: GatewayOperations;
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
    checks.secret_previous_env_count = input.previousSecretEnvs?.length ?? 0;
    checks.secret_previous_present_count = input.previousSecrets?.length ?? 0;
    checks.rpc_auth_from_env = !input.literalRpcAuth;
    checks.methods_fiber_only = input.methods?.every((method) => method === "fiber") ?? true;
    checks.price_currency = input.price?.currency ?? null;
    checks.fl402_enabled = input.fl402Configured ?? false;
    checks.fl402_root_key_env = input.fl402Configured ? input.fl402RootKeyEnv ?? "FIBER_MPP_FL402_ROOT_KEY" : null;
    checks.fl402_hash_algorithm = input.fl402Configured ? input.fl402HashAlgorithm ?? "ckb_hash" : null;
    checks.cors_wildcard_disabled = !(input.cors?.allowedOrigins.includes("*") ?? false);
    checks.rate_limit_enabled = Boolean(input.operations && input.operations.rateLimit.maxRequests > 0 && input.operations.rateLimit.windowMs > 0);
    checks.log_redaction_enabled = input.operations?.logRedaction.enabled ?? false;
    checks.request_body_limit_bytes = input.operations?.requestBodyLimitBytes ?? null;
    if (!input.upstream) {
      blockers.push("set an upstream URL with --upstream or gateway config upstream");
    }
    if (!input.storage?.startsWith("sqlite://")) {
      blockers.push("set storage to sqlite://path");
    }
    if (!input.secret || input.secret.length < 32) {
      blockers.push(`set ${input.secretEnv ?? "FIBER_MPP_SECRET"} to a random secret of at least 32 characters`);
    }
    for (const envName of input.missingPreviousSecretEnvs ?? []) {
      blockers.push(`set previous secret env ${envName} or remove it from previous_secret_envs`);
    }
    for (const envName of input.shortPreviousSecretEnvs ?? []) {
      blockers.push(`previous secret env ${envName} must be at least 32 characters`);
    }
    if (input.literalRpcAuth) {
      blockers.push("Fiber RPC auth must be provided through *_rpc_auth_env or process env, not literal config values");
    }
    if (input.methods && input.methods.some((method) => method !== "fiber")) {
      blockers.push("gateway methods must be fiber only");
    }
    if (input.price && input.price.currency !== "CKB") {
      blockers.push("gateway price currency must be CKB");
    }
    if (input.fl402Configured) {
      if (!input.fl402RootKey || input.fl402RootKey.length < 16) {
        blockers.push(`set ${input.fl402RootKeyEnv ?? "FIBER_MPP_FL402_ROOT_KEY"} to an F-L402 root key of at least 16 characters`);
      }
      if (input.fl402HashAlgorithm !== "ckb_hash" && input.fl402HashAlgorithm !== "sha256") {
        blockers.push("gateway fl402.hash_algorithm must be ckb_hash or sha256");
      }
    }
    if (input.cors?.allowedOrigins.includes("*")) {
      blockers.push("gateway CORS allowed_origins must not include *");
    }
    if (input.operations) {
      if (!isAbsolutePath(input.operations.healthPath) || !isAbsolutePath(input.operations.readinessPath) || !isAbsolutePath(input.operations.metricsPath)) {
        blockers.push("gateway operation paths must start with /");
      }
      if (input.operations.requestBodyLimitBytes < 1024) {
        blockers.push("gateway request_body_limit_bytes must be at least 1024");
      }
      if (input.operations.shutdownGraceMs < 1000) {
        blockers.push("gateway shutdown_grace_ms must be at least 1000");
      }
      if (!input.operations.logRedaction.enabled) {
        blockers.push("gateway log_redaction.enabled must not be false");
      }
      if (input.operations.rateLimit.windowMs < 1000 || input.operations.rateLimit.maxRequests < 1) {
        blockers.push("gateway rate_limit.window_ms must be at least 1000 and max_requests at least 1");
      }
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

export type PreviousSecretResolution = {
  secretEnvs: string[];
  secrets: string[];
  missing: string[];
  short: string[];
};

export function previousSecretsFromGatewayConfig(
  config: GatewayConfig | undefined,
  env: NodeJS.ProcessEnv = process.env
): PreviousSecretResolution {
  const secretEnvs = config?.previous_secret_envs ?? [];
  const secrets: string[] = [];
  const missing: string[] = [];
  const short: string[] = [];

  for (const secretEnv of secretEnvs) {
    const value = env[secretEnv];
    if (!value) {
      missing.push(secretEnv);
      continue;
    }
    if (value.length < 32) {
      short.push(secretEnv);
      continue;
    }
    secrets.push(value);
  }

  return {
    secretEnvs,
    secrets,
    missing,
    short
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
  setEnv(merged, "FIBER_RPC_AUTH", envValue(fiber.rpc_auth_env, env) ?? fiber.rpc_auth);
  setEnv(merged, "FIBER_PAYEE_RPC_AUTH", envValue(fiber.payee_rpc_auth_env, env) ?? fiber.payee_rpc_auth);
  setEnv(merged, "FIBER_PAYER_RPC_AUTH", envValue(fiber.payer_rpc_auth_env, env) ?? fiber.payer_rpc_auth);
  setEnv(merged, "FIBER_PAYEE_NODE_ID", fiber.payee_node_id);
  setEnv(merged, "FIBER_PAYER_NODE_ID", fiber.payer_node_id);
  setEnv(merged, "FIBER_ASSET", fiber.asset);
  setEnv(merged, "FIBER_CURRENCY", fiber.currency);
  setEnv(merged, "FIBER_SETTLEMENT_TIMEOUT_MS", fiber.settlement_timeout_ms);
  setEnv(merged, "FIBER_SETTLEMENT_POLL_MS", fiber.settlement_poll_ms);
  return merged;
}

export function gatewayConfigHasLiteralRpcAuth(config: GatewayConfig | undefined): boolean {
  return Boolean(config?.fiber?.rpc_auth || config?.fiber?.payee_rpc_auth || config?.fiber?.payer_rpc_auth);
}

export function resolveGatewayCorsPolicy(config: GatewayConfig | undefined): GatewayCorsPolicy {
  return {
    allowedOrigins: config?.cors?.allowed_origins ?? [],
    allowedHeaders: config?.cors?.allowed_headers ?? ["authorization", "content-type"],
    allowedMethods: config?.cors?.allowed_methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: config?.cors?.expose_headers ?? ["payment-receipt", "www-authenticate"],
    allowCredentials: config?.cors?.allow_credentials ?? false,
    maxAgeSeconds: config?.cors?.max_age_seconds
  };
}

export function resolveGatewayOperations(config: GatewayConfig | undefined): GatewayOperations {
  return {
    healthPath: config?.operations?.health_path ?? "/healthz",
    readinessPath: config?.operations?.readiness_path ?? "/readyz",
    metricsPath: config?.operations?.metrics_path ?? "/metrics",
    requestBodyLimitBytes: config?.operations?.request_body_limit_bytes ?? 1_048_576,
    shutdownGraceMs: config?.operations?.shutdown_grace_ms ?? 10_000,
    logRedaction: {
      enabled: config?.operations?.log_redaction?.enabled ?? true,
      extraKeys: config?.operations?.log_redaction?.extra_keys ?? []
    },
    rateLimit: {
      windowMs: config?.operations?.rate_limit?.window_ms ?? 60_000,
      maxRequests: config?.operations?.rate_limit?.max_requests ?? 300
    }
  };
}

export async function probeFiberRpcReadiness(input: {
  url: string;
  auth?: string;
  role: FiberRpcProbeRole;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<FiberRpcReadinessProbe> {
  const blockers: string[] = [];
  const checks: FiberRpcReadinessProbe["checks"] = {};
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 2_000;

  try {
    const info = await fiberRpcRequest<unknown>({
      url: input.url,
      auth: input.auth,
      method: "node_info",
      params: [],
      timeoutMs,
      fetchImpl
    });
    checks.rpc_probe = "node_info ok";
    checks.rpc_node_pubkey = stringField(info, "pubkey") ?? stringField(info, "node_id");
    checks.rpc_node_version = stringField(info, "version");
    checks.rpc_node_commit_hash = stringField(info, "commit_hash");
    checks.rpc_node_info_peers = quantityField(info, "peers_count");
    checks.rpc_node_info_channels = quantityField(info, "channel_count");
  } catch (error) {
    const message = errorMessage(error);
    checks.rpc_probe = message;
    return {
      ok: false,
      checks,
      blockers: [`${input.role} Fiber RPC node_info failed: ${message}`]
    };
  }

  try {
    const peersResult = await fiberRpcRequest<unknown>({
      url: input.url,
      auth: input.auth,
      method: "list_peers",
      params: [],
      timeoutMs,
      fetchImpl
    });
    const peerCount = countNamedArray(peersResult, "peers");
    checks.rpc_peer_count = peerCount;
    if (peerCount === 0) {
      blockers.push(`${input.role} Fiber node has no connected peers; connect it to a local or testnet Fiber peer`);
    }
  } catch (error) {
    const message = errorMessage(error);
    checks.rpc_peer_count = `list_peers failed: ${message}`;
    blockers.push(`${input.role} Fiber RPC list_peers failed: ${message}`);
  }

  try {
    const channelsResult = await fiberRpcRequest<unknown>({
      url: input.url,
      auth: input.auth,
      method: "list_channels",
      params: [{}],
      timeoutMs,
      fetchImpl
    });
    const channels = namedArray(channelsResult, "channels");
    const channelCount = channels.length;
    const readyChannelCount = channels.filter(isReadyChannel).length;
    checks.rpc_channel_count = channelCount;
    checks.rpc_ready_channel_count = readyChannelCount;
    checks.rpc_channel_states = summarizeChannelStates(channels);
    if (channelCount === 0) {
      blockers.push(`${input.role} Fiber node has no channels; open and fund a channel before live FiberMPP payments`);
    } else if (readyChannelCount === 0) {
      blockers.push(`${input.role} Fiber node has no ChannelReady channels; wait for channel funding and readiness`);
    }
  } catch (error) {
    const message = errorMessage(error);
    checks.rpc_channel_count = `list_channels failed: ${message}`;
    checks.rpc_ready_channel_count = null;
    blockers.push(`${input.role} Fiber RPC list_channels failed: ${message}`);
  }

  return {
    ok: blockers.length === 0,
    checks,
    blockers
  };
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

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

function setEnv(env: NodeJS.ProcessEnv, key: string, value: string | number | undefined): void {
  if (typeof value !== "undefined") {
    env[key] = String(value);
  }
}

function envValue(envName: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return envName ? env[envName] : undefined;
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

async function fiberRpcRequest<T>(input: {
  url: string;
  auth?: string;
  method: string;
  params: unknown[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (input.auth) {
      headers.set("authorization", input.auth);
    }
    const response = await input.fetchImpl(input.url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `fiber-mpp-doctor-${input.method}`,
        method: input.method,
        params: input.params
      })
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      result?: T;
      error?: { message?: string } | unknown;
    };
    if (payload.error) {
      throw new Error(errorMessage(payload.error));
    }
    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

function quantityField(value: unknown, key: string): number | null {
  const field = stringField(value, key);
  if (!field) {
    return null;
  }
  if (field.startsWith("0x")) {
    return Number.parseInt(field.slice(2), 16);
  }
  const parsed = Number.parseInt(field, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function countNamedArray(value: unknown, key: string): number {
  return namedArray(value, key).length;
}

function namedArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const array = (value as Record<string, unknown>)[key];
  return Array.isArray(array) ? array : [];
}

function isReadyChannel(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const channel = value as Record<string, unknown>;
  return isChannelReadyState(channelStateName(channel));
}

function isChannelReadyState(state: string): boolean {
  const normalized = state.replace(/[_\s-]/g, "").toLowerCase();
  return normalized === "channelready";
}

function summarizeChannelStates(channels: unknown[]): string {
  if (channels.length === 0) {
    return "none";
  }
  const states = new Map<string, number>();
  for (const channel of channels) {
    const state = channelStateName(channel);
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return [...states.entries()].map(([state, count]) => `${state}:${count}`).join(", ");
}

function channelStateName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }
  const channel = value as Record<string, unknown>;
  const state = channel.state;
  if (typeof state === "string") {
    return state;
  }
  if (state && typeof state === "object") {
    const stateName = (state as Record<string, unknown>).state_name;
    return typeof stateName === "string" ? stateName : "unknown";
  }
  return typeof channel.state_name === "string" ? channel.state_name : "unknown";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}
