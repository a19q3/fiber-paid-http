import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const FIBER_PREFLIGHT_TEST_FILE = "tests/integration/fiber-preflight.test.ts";
export const FIBER_LIVE_TEST_FILE = "tests/integration/fiber-live.e2e.test.ts";
export const FIBER_E2E_RESULT_PATH = "reports/fiber-e2e-result.json";

export type FiberE2eMode = "skipped" | "local" | "testnet";
export type FiberE2ePreflightStatus = "skipped" | "ready";
export type FiberE2eStatus = "skipped" | "passed" | "failed";

export type FiberE2ePreflight = {
  mode: FiberE2eMode;
  status: FiberE2ePreflightStatus;
  blockers: string[];
  liveReady: boolean;
  testFileLoaded: true;
  payeeRpcUrl?: string;
  payerRpcUrl?: string;
};

export type LiveFiberEnv = {
  mode: "local" | "testnet";
  payeeRpcUrl: string;
  payerRpcUrl: string;
  payeeRpcAuth?: string;
  payerRpcAuth?: string;
  payeeNodeId?: string;
  payerNodeId?: string;
  currency: string;
  amountShannons: string;
  timeoutMs: number;
  pollMs: number;
  storagePath: string;
  secret: string;
};

export type FiberE2eResult = {
  fiber_preflight_test_loaded?: boolean;
  fiber_live_test_selected?: boolean;
  fiber_live_test_loaded?: boolean;
  fiber_e2e_mode?: FiberE2eMode;
  fiber_e2e_status?: FiberE2eStatus;
  fiber_e2e_blockers?: string[];
  fiber_e2e_error?: string;
  fiber_e2e_payment_hash?: string;
  fiber_e2e_receipt_id?: string;
};

export function readFiberE2ePreflight(env: NodeJS.ProcessEnv = process.env): FiberE2ePreflight {
  const blockers: string[] = [];
  const runRequested = env.RUN_FIBER_E2E === "1";
  const mode = parseRunnableFiberMode(env.FIBER_MODE);
  const payeeRpcUrl = env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
  const payerRpcUrl = env.FIBER_PAYER_RPC_URL;

  if (!runRequested) {
    blockers.push("Fiber live E2E skipped: set RUN_FIBER_E2E=1");
  }
  if (!mode) {
    blockers.push("Fiber live E2E skipped: set FIBER_MODE=local or FIBER_MODE=testnet");
  }
  if (!payeeRpcUrl) {
    blockers.push("Fiber live E2E skipped: set FIBER_RPC_URL or FIBER_PAYEE_RPC_URL for the invoice/payee node");
  }
  if (!payerRpcUrl) {
    blockers.push("Fiber live E2E skipped: set FIBER_PAYER_RPC_URL for the paying node");
  }
  if (!env.FIBER_MPP_SECRET || env.FIBER_MPP_SECRET.length < 32) {
    blockers.push("Fiber live E2E skipped: set FIBER_MPP_SECRET to a random secret of at least 32 characters");
  }

  const liveReady = blockers.length === 0;
  return {
    mode: liveReady ? mode! : "skipped",
    status: liveReady ? "ready" : "skipped",
    blockers,
    liveReady,
    testFileLoaded: true,
    payeeRpcUrl,
    payerRpcUrl
  };
}

export function readLiveFiberEnv(env: NodeJS.ProcessEnv = process.env): LiveFiberEnv {
  const preflight = readFiberE2ePreflight(env);
  if (!preflight.liveReady || preflight.mode === "skipped") {
    throw new Error(`RUN_FIBER_E2E=1 requires live Fiber env: ${preflight.blockers.join("; ")}`);
  }
  return {
    mode: preflight.mode,
    payeeRpcUrl: preflight.payeeRpcUrl!,
    payerRpcUrl: preflight.payerRpcUrl!,
    payeeRpcAuth: env.FIBER_PAYEE_RPC_AUTH ?? env.FIBER_RPC_AUTH,
    payerRpcAuth: env.FIBER_PAYER_RPC_AUTH ?? env.FIBER_RPC_AUTH,
    payeeNodeId: env.FIBER_PAYEE_NODE_ID ?? env.FIBER_NODE_ID,
    payerNodeId: env.FIBER_PAYER_NODE_ID,
    currency: env.FIBER_CURRENCY ?? (preflight.mode === "testnet" ? "Fibt" : "Fibd"),
    amountShannons: env.FIBER_E2E_AMOUNT_SHANNONS ?? "100",
    timeoutMs: parseIntEnv(env.FIBER_SETTLEMENT_TIMEOUT_MS, 60_000),
    pollMs: parseIntEnv(env.FIBER_SETTLEMENT_POLL_MS, 500),
    storagePath: resolve(env.FIBER_E2E_STORAGE_PATH ?? ".tmp/fiber-live-e2e.sqlite"),
    secret: env.FIBER_MPP_SECRET!
  };
}

export function writeFiberE2eResult(patch: FiberE2eResult): FiberE2eResult {
  const path = resolve(FIBER_E2E_RESULT_PATH);
  mkdirSync(dirname(path), { recursive: true });
  let current: FiberE2eResult = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as FiberE2eResult;
  } catch {
    current = {};
  }
  const next: FiberE2eResult = {
    ...current,
    ...patch
  };
  if (next.fiber_e2e_status !== "passed") {
    delete next.fiber_e2e_payment_hash;
    delete next.fiber_e2e_receipt_id;
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function parseRunnableFiberMode(value: string | undefined): "local" | "testnet" | undefined {
  return value === "local" || value === "testnet" ? value : undefined;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
