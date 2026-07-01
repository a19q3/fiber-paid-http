import {
  FiberPaidHttpError,
  FiberMethodChallengeSchema,
  type FiberMethodChallenge,
  type FiberUdtTypeScript,
  type Settlement
} from "@fiber-paid-http/core";

export type FiberMode = "local" | "testnet";
export type FiberEnvRole = "payee" | "payer";

export type FiberCreateChallengeInput = {
  challengeId: string;
  amountShannons: string;
  expiresAt: string;
  description?: string;
  udtTypeScript?: FiberUdtTypeScript;
};

export type FiberPaymentProof = {
  kind: "fiber-payment-proof-v1";
  mode: FiberMode;
  paymentHash: string;
  invoice?: string;
  amountShannons?: string;
  udtTypeScript?: FiberUdtTypeScript;
  status?: string;
  observedAt: string;
  evidence?: unknown;
};

export type FiberReceiptEvidence = {
  paymentHash: string;
  invoiceId?: string;
  amountShannons?: string;
  settlement: Settlement;
  raw?: unknown;
};

export type FiberRpcClientOptions = {
  url: string;
  auth?: string;
  label?: string;
  fetchImpl?: typeof fetch;
};

export class FiberRpcClient {
  private readonly fetchImpl: typeof fetch;
  public readonly url: string;
  public readonly auth?: string;
  public readonly label?: string;
  private id = 0;

  public constructor(options: FiberRpcClientOptions) {
    this.url = options.url;
    this.auth = options.auth;
    this.label = options.label;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.auth) {
      headers.set("authorization", this.auth);
    }
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.id,
        method,
        params
      })
    });
    if (!response.ok) {
      throw new FiberPaidHttpError("fiber-rpc-http-error", `Fiber RPC returned HTTP ${response.status}`, 502);
    }
    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.error) {
      throw new FiberPaidHttpError(
        "fiber-rpc-error",
        `Fiber RPC ${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`,
        502
      );
    }
    return payload.result as T;
  }

  public async nodeInfo(): Promise<unknown> {
    return this.request("node_info", []);
  }

  public async listChannels(pubkey?: string): Promise<unknown> {
    return this.request("list_channels", pubkey ? [{ pubkey }] : [{}]);
  }

  public async newInvoice(input: {
    amount: string;
    description?: string;
    currency: string;
    udtTypeScript?: FiberUdtTypeScript;
    paymentHash?: string;
    paymentPreimage?: string;
    expirySeconds?: number;
  }): Promise<FiberInvoiceResult> {
    const params: Record<string, unknown> = {
      amount: toFiberHexQuantity(input.amount),
      description: input.description,
      currency: input.currency,
      udt_type_script: input.udtTypeScript,
      expiry: typeof input.expirySeconds === "number" ? toFiberHexQuantity(input.expirySeconds) : undefined
    };
    if (input.paymentHash) {
      params.payment_hash = input.paymentHash;
    }
    if (input.paymentPreimage) {
      params.payment_preimage = input.paymentPreimage;
    }
    return this.request<FiberInvoiceResult>("new_invoice", [stripUndefined(params)]);
  }

  public async parseInvoice(invoice: string): Promise<FiberInvoiceResult> {
    return this.request<FiberInvoiceResult>("parse_invoice", [{ invoice }]);
  }

  public async getInvoice(paymentHash: string): Promise<FiberInvoiceStatusResult> {
    return this.request<FiberInvoiceStatusResult>("get_invoice", [{ payment_hash: paymentHash }]);
  }

  public async sendPayment(input: {
    invoice?: string;
    targetPubkey?: string;
    amount?: string;
    paymentHash?: string;
    maxFeeAmount?: string;
    maxFeeRate?: string;
    maxParts?: number;
    timeoutSeconds?: number;
    udtTypeScript?: FiberUdtTypeScript;
    keysend?: boolean;
    dryRun?: boolean;
  }): Promise<FiberPaymentResult> {
    return this.request<FiberPaymentResult>("send_payment", [
      stripUndefined({
        invoice: input.invoice,
        target_pubkey: input.targetPubkey,
        amount: input.amount ? toFiberHexQuantity(input.amount) : undefined,
        payment_hash: input.paymentHash,
        max_fee_amount: input.maxFeeAmount ? toFiberHexQuantity(input.maxFeeAmount) : undefined,
        max_fee_rate: input.maxFeeRate ? toFiberHexQuantity(input.maxFeeRate) : undefined,
        max_parts: typeof input.maxParts === "number" ? toFiberHexQuantity(input.maxParts) : undefined,
        timeout: typeof input.timeoutSeconds === "number" ? toFiberHexQuantity(input.timeoutSeconds) : undefined,
        udt_type_script: input.invoice ? undefined : input.udtTypeScript,
        keysend: input.keysend,
        dry_run: input.dryRun
      })
    ]);
  }

  public async getPayment(paymentHash: string): Promise<FiberPaymentResult> {
    return this.request<FiberPaymentResult>("get_payment", [{ payment_hash: paymentHash }]);
  }
}

export class FiberMethodAdapter {
  public readonly mode: FiberMode;
  public readonly asset: string;
  public readonly currency: string;
  private readonly rpc?: FiberRpcClient;
  private readonly nodeId?: string;
  private readonly rpcLabel?: string;
  private readonly udtTypeScript?: FiberUdtTypeScript;
  private readonly settlementTimeoutMs: number;
  private readonly settlementPollMs: number;

  public constructor(options: {
    mode: FiberMode;
    rpc?: FiberRpcClient;
    asset?: string;
    currency?: string;
    nodeId?: string;
    rpcLabel?: string;
    udtTypeScript?: FiberUdtTypeScript;
    settlementTimeoutMs?: number;
    settlementPollMs?: number;
  }) {
    if (!options.rpc) {
      throw new Error("Fiber local/testnet mode requires a FiberRpcClient");
    }
    this.mode = options.mode;
    this.rpc = options.rpc;
    this.asset = options.asset ?? "CKB";
    this.currency = options.currency ?? (options.mode === "testnet" ? "Fibt" : "Fibd");
    this.nodeId = options.nodeId;
    this.rpcLabel = options.rpcLabel ?? options.rpc?.label;
    this.udtTypeScript = options.udtTypeScript;
    this.settlementTimeoutMs = options.settlementTimeoutMs ?? 30_000;
    this.settlementPollMs = options.settlementPollMs ?? 250;
  }

  public static fromEnv(env: NodeJS.ProcessEnv = process.env, role: FiberEnvRole = "payee"): FiberMethodAdapter {
    const mode = parseFiberMode(env.FIBER_MODE);
    const rolePrefix = role === "payer" ? "PAYER" : "PAYEE";
    const url = role === "payer" ? env.FIBER_PAYER_RPC_URL ?? env.FIBER_RPC_URL : env.FIBER_PAYEE_RPC_URL ?? env.FIBER_RPC_URL;
    if (!url) {
      throw new Error(
        `FIBER_${rolePrefix}_RPC_URL or FIBER_RPC_URL is required when FIBER_MODE is local or testnet`
      );
    }
    const auth =
      role === "payer"
        ? env.FIBER_PAYER_RPC_AUTH ?? env.FIBER_RPC_AUTH
        : env.FIBER_PAYEE_RPC_AUTH ?? env.FIBER_RPC_AUTH;
    const nodeId =
      role === "payer"
        ? env.FIBER_PAYER_NODE_ID ?? env.FIBER_NODE_ID
        : env.FIBER_PAYEE_NODE_ID ?? env.FIBER_NODE_ID;
    return new FiberMethodAdapter({
      mode,
      rpc: new FiberRpcClient({
        url,
        auth,
        label: env.FIBER_RPC_LABEL ?? `${mode}-${role}`
      }),
      asset: env.FIBER_ASSET ?? "CKB",
      currency: env.FIBER_CURRENCY ?? (mode === "testnet" ? "Fibt" : "Fibd"),
      nodeId,
      rpcLabel: env.FIBER_RPC_LABEL ?? `${mode}-${role}`,
      udtTypeScript: parseFiberUdtTypeScriptFromEnv(env),
      settlementTimeoutMs: parseOptionalInt(env.FIBER_SETTLEMENT_TIMEOUT_MS),
      settlementPollMs: parseOptionalInt(env.FIBER_SETTLEMENT_POLL_MS)
    });
  }

  public async createChallenge(input: FiberCreateChallengeInput): Promise<FiberMethodChallenge> {
    const expirySeconds = Math.max(
      1,
      Math.ceil((new Date(input.expiresAt).getTime() - Date.now()) / 1000)
    );
    const invoice = await this.rpc!.newInvoice({
      amount: input.amountShannons,
      description: input.description ?? `Fiber Paid HTTP challenge ${input.challengeId}`,
      currency: this.currency,
      udtTypeScript: input.udtTypeScript ?? this.udtTypeScript,
      expirySeconds
    });
    const paymentHash = extractInvoicePaymentHash(invoice);
    return FiberMethodChallengeSchema.parse({
      method: "fiber",
      intent: "charge",
      asset: this.asset,
      amountShannons: input.amountShannons,
      paymentHash,
      invoice: invoice.invoice_address,
      udtTypeScript: input.udtTypeScript ?? this.udtTypeScript,
      fiberNodeId: this.nodeId,
      fiberRpcLabel: this.rpcLabel,
      expiresAt: input.expiresAt
    });
  }

  public async payChallenge(challenge: FiberMethodChallenge): Promise<FiberPaymentProof> {
    const result = await this.rpc!.sendPayment({
      invoice: challenge.invoice,
      timeoutSeconds: Math.ceil(this.settlementTimeoutMs / 1000)
    });
    const paymentHash = result.payment_hash ?? challenge.paymentHash;
    const settled = await waitForFiberPaymentSuccess(this.rpc!, paymentHash, {
      timeoutMs: this.settlementTimeoutMs,
      pollMs: this.settlementPollMs
    });
    return {
      kind: "fiber-payment-proof-v1",
      mode: this.mode,
      paymentHash,
      invoice: challenge.invoice,
      amountShannons: challenge.amountShannons,
      udtTypeScript: challenge.udtTypeScript,
      status: settled.status,
      observedAt: new Date().toISOString(),
      evidence: {
        sendResult: result,
        settledPayment: settled
      }
    };
  }

  public async verifyProof(
    challenge: FiberMethodChallenge,
    proof: unknown
  ): Promise<FiberReceiptEvidence> {
    const normalized = normalizeProof(proof);
    if (normalized.paymentHash !== challenge.paymentHash) {
      throw new FiberPaidHttpError("wrong-payment-hash", "Fiber payment hash does not match the challenge", 402);
    }
    if (challenge.amountShannons && normalized.amountShannons && normalized.amountShannons !== challenge.amountShannons) {
      throw new FiberPaidHttpError("wrong-amount", "Fiber payment amount does not match the challenge", 402);
    }
    if (normalized.mode !== this.mode) {
      throw new FiberPaidHttpError(
        "wrong-fiber-mode",
        `Fiber payment proof mode ${normalized.mode} does not match configured ${this.mode} mode`,
        402
      );
    }
    if (JSON.stringify(normalized.udtTypeScript ?? null) !== JSON.stringify(challenge.udtTypeScript ?? null)) {
      throw new FiberPaidHttpError("wrong-fiber-udt", "Fiber UDT type script does not match the challenge", 402);
    }

    const invoiceRecord = await waitForFiberInvoicePaid(this.rpc!, challenge.paymentHash, {
      timeoutMs: this.settlementTimeoutMs,
      pollMs: this.settlementPollMs
    });
    const invoiceStatus = invoiceRecord.status;
    if (!isInvoicePaidStatus(invoiceStatus)) {
      throw new FiberPaidHttpError(
        "fiber-payment-not-settled",
        `Fiber invoice is not paid; invoice status is ${invoiceStatus ?? "unknown"}`,
        402
      );
    }

    return {
      paymentHash: challenge.paymentHash,
      amountShannons: challenge.amountShannons,
      settlement: {
        status: "settled",
        paymentHash: challenge.paymentHash,
        invoiceId: challenge.invoice,
        provider: this.rpcLabel ?? "fiber-rpc",
        observedAt: new Date().toISOString()
      },
      raw: invoiceRecord
    };
  }
}

export function parseFiberMode(value: string | undefined): FiberMode {
  if (value === "local" || value === "testnet") {
    return value;
  }
  throw new Error("FIBER_MODE must be set to local or testnet");
}

export function isSettledStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return ["settled", "success", "succeeded", "paid"].includes(value.toLowerCase());
}

export function isPaymentSuccessStatus(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "success";
}

export function isInvoicePaidStatus(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "paid";
}

export function normalizeFiberPaymentStatus(value: unknown): "settled" | "pending" | "failed" {
  if (isSettledStatus(value)) {
    return "settled";
  }
  if (typeof value === "string" && ["failed", "failure", "cancelled", "expired"].includes(value.toLowerCase())) {
    return "failed";
  }
  return "pending";
}

export async function waitForFiberPaymentSuccess(
  rpc: FiberRpcClient,
  paymentHash: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<FiberPaymentResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const started = Date.now();
  let last: FiberPaymentResult | null = null;
  while (Date.now() - started <= timeoutMs) {
    last = await rpc.getPayment(paymentHash);
    if (isPaymentSuccessStatus(last.status)) {
      return last;
    }
    if (typeof last.status === "string" && last.status.toLowerCase() === "failed") {
      throw new FiberPaidHttpError(
        "fiber-payment-failed",
        `Fiber payment ${paymentHash} failed: ${last.failed_error ?? "unknown error"}`,
        502
      );
    }
    await sleep(pollMs);
  }
  throw new FiberPaidHttpError(
    "fiber-payment-timeout",
    `Timed out waiting for Fiber payment ${paymentHash} to reach Success; last status ${last?.status ?? "unknown"}`,
    504
  );
}

export async function waitForFiberInvoicePaid(
  rpc: FiberRpcClient,
  paymentHash: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<FiberInvoiceStatusResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const started = Date.now();
  let last: FiberInvoiceStatusResult | null = null;
  while (Date.now() - started <= timeoutMs) {
    last = await rpc.getInvoice(paymentHash);
    if (isInvoicePaidStatus(last.status)) {
      return last;
    }
    if (typeof last.status === "string" && ["cancelled", "expired"].includes(last.status.toLowerCase())) {
      throw new FiberPaidHttpError(
        "fiber-invoice-not-payable",
        `Fiber invoice ${paymentHash} reached terminal status ${last.status}`,
        402
      );
    }
    await sleep(pollMs);
  }
  throw new FiberPaidHttpError(
    "fiber-invoice-timeout",
    `Timed out waiting for Fiber invoice ${paymentHash} to reach Paid; last status ${last?.status ?? "unknown"}`,
    504
  );
}

export type FiberInvoiceResult = {
  invoice_address?: string;
  invoice?: {
    amount?: string | number;
    data?: {
      payment_hash?: string;
      attrs?: unknown[];
    };
  };
};

export type FiberInvoiceStatusResult = FiberInvoiceResult & {
  status?: string;
};

export type FiberPaymentResult = {
  payment_hash?: string;
  status?: string;
  created_at?: string | number;
  last_updated_at?: string | number;
  failed_error?: string;
  fee?: string | number;
  custom_records?: unknown;
};

export function parseFiberUdtTypeScriptFromEnv(env: NodeJS.ProcessEnv = process.env): FiberUdtTypeScript | undefined {
  return parseFiberUdtTypeScript(
    env.FIBER_UDT_TYPE_SCRIPT ?? env.FIBER_XUDT_TYPE_SCRIPT,
    {
      codeHash: env.FIBER_UDT_CODE_HASH ?? env.FIBER_XUDT_CODE_HASH,
      hashType: env.FIBER_UDT_HASH_TYPE ?? env.FIBER_XUDT_HASH_TYPE,
      args: env.FIBER_UDT_ARGS ?? env.FIBER_XUDT_ARGS
    }
  );
}

export function parseFiberUdtTypeScript(
  value?: string,
  parts: { codeHash?: string; hashType?: string; args?: string } = {}
): FiberUdtTypeScript | undefined {
  const fromParts = normalizeFiberUdtTypeScript({
    code_hash: parts.codeHash,
    hash_type: parts.hashType,
    args: parts.args
  });
  if (fromParts) {
    return fromParts;
  }
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const normalized = normalizeFiberUdtTypeScript(parsed);
    if (normalized) {
      return normalized;
    }
  }
  const tuple = trimmed.split(",").map((item) => item.trim());
  if (tuple.length === 3) {
    const normalized = normalizeFiberUdtTypeScript({
      code_hash: tuple[0],
      hash_type: tuple[1],
      args: tuple[2]
    });
    if (normalized) {
      return normalized;
    }
  }
  throw new Error("Fiber UDT type script must be JSON or code_hash,hash_type,args");
}

type JsonRpcResponse<T> = {
  jsonrpc?: "2.0";
  id?: number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

function normalizeProof(proof: unknown): FiberPaymentProof {
  if (!proof || typeof proof !== "object") {
    throw new FiberPaidHttpError("invalid-fiber-proof", "Fiber payment proof must be an object", 402);
  }
  const candidate = proof as Partial<FiberPaymentProof>;
  if (candidate.kind !== "fiber-payment-proof-v1" || !candidate.paymentHash || !candidate.observedAt) {
    throw new FiberPaidHttpError("invalid-fiber-proof", "Fiber payment proof is missing required fields", 402);
  }
  if (candidate.mode !== "local" && candidate.mode !== "testnet") {
    throw new FiberPaidHttpError("invalid-fiber-proof", "Fiber payment proof mode must be local or testnet", 402);
  }
  return {
    kind: "fiber-payment-proof-v1",
    mode: candidate.mode,
    paymentHash: candidate.paymentHash,
    invoice: candidate.invoice,
    amountShannons: candidate.amountShannons,
    udtTypeScript: normalizeFiberUdtTypeScript(candidate.udtTypeScript),
    status: candidate.status,
    observedAt: candidate.observedAt,
    evidence: candidate.evidence
  };
}

export function extractInvoicePaymentHash(invoice: FiberInvoiceResult): string {
  const paymentHash = invoice.invoice?.data?.payment_hash;
  if (!paymentHash) {
    throw new FiberPaidHttpError("fiber-invoice-missing-payment-hash", "Fiber new_invoice did not return a payment hash", 502);
  }
  return paymentHash;
}

function normalizeFiberUdtTypeScript(input: unknown): FiberUdtTypeScript | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const codeHash = typeof record.code_hash === "string" ? record.code_hash.toLowerCase() : undefined;
  const hashType = typeof record.hash_type === "string" ? record.hash_type.toLowerCase() : undefined;
  const args = typeof record.args === "string" ? record.args.toLowerCase() : undefined;
  if (!codeHash && !hashType && !args) {
    return undefined;
  }
  if (!codeHash || !/^0x[a-f0-9]{64}$/.test(codeHash)) {
    throw new Error("Fiber UDT type script code_hash must be a 32-byte hex string");
  }
  if (!hashType || !["data", "data1", "data2", "type"].includes(hashType)) {
    throw new Error("Fiber UDT type script hash_type must be data, data1, data2, or type");
  }
  if (!args || !/^0x[a-f0-9]*$/.test(args)) {
    throw new Error("Fiber UDT type script args must be hex");
  }
  return {
    code_hash: codeHash,
    hash_type: hashType,
    args
  };
}

export function toFiberHexQuantity(value: string | number | bigint): string {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value.toLowerCase();
  }
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error("Fiber quantity cannot be negative");
  }
  return `0x${parsed.toString(16)}`;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => typeof value !== "undefined"));
}
