import {
  FiberPaidHttpError,
  FiberChargeRequestSchema,
  FiberCredentialPayloadSchema,
  FiberUdtTypeScriptSchema,
  type FiberChargeRequest,
  type FiberCredentialPayload,
  type FiberUdtTypeScript,
  type Settlement
} from "@fiber-paid-http/core";

export type FiberMode = "local" | "testnet";
export type FiberEnvRole = "payee" | "payer";

export type FiberCreateChargeInput = {
  amount: string;
  currency?: string;
  description?: string;
  externalId?: string;
  udtTypeScript?: FiberUdtTypeScript;
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
  timeoutMs?: number;
};

export class FiberRpcClient {
  private readonly fetchImpl: typeof fetch;
  public readonly url: string;
  public readonly auth?: string;
  public readonly label?: string;
  private readonly timeoutMs: number;
  private id = 0;

  public constructor(options: FiberRpcClientOptions) {
    this.url = options.url;
    this.auth = options.auth;
    this.label = options.label;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Fiber RPC timeout must be a positive integer");
    }
  }

  public async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.auth) {
      headers.set("authorization", this.auth);
    }
    const requestId = ++this.id;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params
      })
    });
    if (!response.ok) {
      throw new FiberPaidHttpError("fiber-rpc-http-error", `Fiber RPC returned HTTP ${response.status}`, 502);
    }
    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.jsonrpc !== "2.0" || payload.id !== requestId) {
      throw new FiberPaidHttpError("fiber-rpc-invalid-response", "Fiber RPC returned an invalid JSON-RPC envelope", 502);
    }
    if (payload.error) {
      throw new FiberPaidHttpError(
        "fiber-rpc-error",
        `Fiber RPC ${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`,
        502
      );
    }
    if (!Object.hasOwn(payload, "result")) {
      throw new FiberPaidHttpError("fiber-rpc-invalid-response", `Fiber RPC ${method} response omitted result`, 502);
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
    if (
      !Number.isSafeInteger(this.settlementTimeoutMs) ||
      !Number.isSafeInteger(this.settlementPollMs) ||
      this.settlementTimeoutMs <= 0 ||
      this.settlementPollMs <= 0 ||
      this.settlementPollMs > this.settlementTimeoutMs
    ) {
      throw new Error("Fiber settlement polling must satisfy 0 < poll <= timeout using integer milliseconds");
    }
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

  public async createChargeRequest(input: FiberCreateChargeInput, expirySeconds: number): Promise<FiberChargeRequest> {
    const invoice = await this.rpc!.newInvoice({
      amount: input.amount,
      description: input.description ?? "Fiber Paid HTTP charge",
      currency: this.currency,
      udtTypeScript: input.udtTypeScript ?? this.udtTypeScript,
      expirySeconds
    });
    const paymentHash = extractInvoicePaymentHash(invoice);
    if (!invoice.invoice_address) {
      throw new FiberPaidHttpError("fiber-invoice-missing", "Fiber new_invoice did not return invoice_address", 502);
    }
    assertInvoiceMatches({
      invoice,
      expectedPaymentHash: paymentHash,
      expectedAmount: input.amount,
      expectedCurrency: this.currency,
      expectedNetwork: this.mode === "testnet" ? "testnet" : "dev",
      expectedHashAlgorithm: invoiceHashAlgorithm(invoice),
      expectedUdtTypeScript: input.udtTypeScript ?? this.udtTypeScript,
      requireUnexpired: true
    });
    const invoiceExpiresAt = extractInvoiceExpiresAt(invoice);
    const invoiceUdtScript = extractInvoiceUdtScript(invoice);
    return FiberChargeRequestSchema.parse({
      amount: input.amount,
      currency: input.currency ?? this.asset.toLowerCase(),
      recipient: this.nodeId,
      description: input.description,
      externalId: input.externalId,
      methodDetails: {
        invoice: invoice.invoice_address,
        paymentHash,
        network: fiberNetworkFromCurrency(this.currency),
        hashAlgorithm: invoiceHashAlgorithm(invoice),
        invoiceCurrency: this.currency,
        invoiceExpiresAt,
        invoiceUdtScript,
        udtTypeScript: input.udtTypeScript ?? this.udtTypeScript
      }
    });
  }

  public async payCharge(request: FiberChargeRequest): Promise<FiberCredentialPayload> {
    const parsed = FiberChargeRequestSchema.parse(request);
    const expectedNetwork = this.mode === "testnet" ? "testnet" : "dev";
    if (parsed.methodDetails.network !== expectedNetwork) {
      throw new FiberPaidHttpError("wrong-network", "Fiber invoice network does not match the configured payer", 402);
    }
    const decoded = await this.rpc!.parseInvoice(parsed.methodDetails.invoice);
    assertInvoiceMatches({
      invoice: decoded,
      expectedPaymentHash: parsed.methodDetails.paymentHash,
      expectedAmount: parsed.amount,
      expectedCurrency: parsed.methodDetails.invoiceCurrency ?? this.currency,
      expectedNetwork,
      expectedHashAlgorithm: parsed.methodDetails.hashAlgorithm,
      expectedUdtTypeScript: parsed.methodDetails.udtTypeScript,
      expectedInvoiceExpiresAt: parsed.methodDetails.invoiceExpiresAt,
      expectedInvoiceUdtScript: parsed.methodDetails.invoiceUdtScript,
      requireUnexpired: true
    });
    const result = await this.rpc!.sendPayment({
      invoice: parsed.methodDetails.invoice,
      timeoutSeconds: Math.ceil(this.settlementTimeoutMs / 1000)
    });
    const paymentHash = result.payment_hash ?? parsed.methodDetails.paymentHash;
    if (!sameHex32(paymentHash, parsed.methodDetails.paymentHash)) {
      throw new FiberPaidHttpError("wrong-payment-hash", "Fiber send_payment returned a different payment hash", 502);
    }
    const settled = await waitForFiberPaymentSuccess(this.rpc!, paymentHash, {
      timeoutMs: this.settlementTimeoutMs,
      pollMs: this.settlementPollMs
    });
    if (!isPaymentSuccessStatus(settled.status)) {
      throw new FiberPaidHttpError("fiber-payment-not-settled", "Fiber payment did not reach Success", 402);
    }
    return FiberCredentialPayloadSchema.parse({ paymentHash });
  }

  public async verifyPayload(
    request: FiberChargeRequest,
    payload: unknown
  ): Promise<FiberReceiptEvidence> {
    const parsedRequest = FiberChargeRequestSchema.parse(request);
    const normalized = FiberCredentialPayloadSchema.parse(payload);
    if (normalized.paymentHash !== parsedRequest.methodDetails.paymentHash) {
      throw new FiberPaidHttpError("wrong-payment-hash", "Fiber payment hash does not match the challenge", 402);
    }

    const invoiceRecord = await waitForFiberInvoicePaid(this.rpc!, parsedRequest.methodDetails.paymentHash, {
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
    assertInvoiceMatches({
      invoice: invoiceRecord,
      expectedInvoiceAddress: parsedRequest.methodDetails.invoice,
      expectedPaymentHash: parsedRequest.methodDetails.paymentHash,
      expectedAmount: parsedRequest.amount,
      expectedCurrency: parsedRequest.methodDetails.invoiceCurrency ?? this.currency,
      expectedNetwork: parsedRequest.methodDetails.network,
      expectedHashAlgorithm: parsedRequest.methodDetails.hashAlgorithm,
      expectedUdtTypeScript: parsedRequest.methodDetails.udtTypeScript,
      expectedInvoiceExpiresAt: parsedRequest.methodDetails.invoiceExpiresAt,
      expectedInvoiceUdtScript: parsedRequest.methodDetails.invoiceUdtScript
    });

    return {
      paymentHash: parsedRequest.methodDetails.paymentHash,
      amountShannons: parsedRequest.amount,
      settlement: {
        status: "settled",
        paymentHash: parsedRequest.methodDetails.paymentHash,
        invoiceId: parsedRequest.methodDetails.invoice,
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
  return value === "Success";
}

export function isInvoicePaidStatus(value: unknown): boolean {
  return value === "Paid";
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
  assertPollingConfiguration(timeoutMs, pollMs);
  const started = Date.now();
  let last: FiberPaymentResult | null = null;
  while (Date.now() - started <= timeoutMs) {
    last = await rpc.getPayment(paymentHash);
    if (isPaymentSuccessStatus(last.status)) {
      return last;
    }
    if (last.status === "Failed") {
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
  assertPollingConfiguration(timeoutMs, pollMs);
  const started = Date.now();
  let last: FiberInvoiceStatusResult | null = null;
  while (Date.now() - started <= timeoutMs) {
    last = await rpc.getInvoice(paymentHash);
    if (isInvoicePaidStatus(last.status)) {
      return last;
    }
    if (last.status === "Cancelled" || last.status === "Expired") {
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
    currency?: string;
    data?: {
      payment_hash?: string;
      timestamp?: string | number;
      attrs?: Array<Record<string, unknown>>;
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

export function extractInvoicePaymentHash(invoice: FiberInvoiceResult): string {
  const paymentHash = invoice.invoice?.data?.payment_hash;
  if (!paymentHash) {
    throw new FiberPaidHttpError("fiber-invoice-missing-payment-hash", "Fiber new_invoice did not return a payment hash", 502);
  }
  return paymentHash;
}

export function extractInvoiceAmount(invoice: FiberInvoiceResult): string | undefined {
  const amount = invoice.invoice?.amount;
  if (typeof amount === "number") {
    return String(amount);
  }
  if (typeof amount === "string") {
    return amount.startsWith("0x") ? BigInt(amount).toString(10) : amount;
  }
  return undefined;
}

export function extractInvoiceUdtScript(invoice: FiberInvoiceResult): string | undefined {
  return invoiceAttribute(invoice, "udt_script", "udtScript");
}

export function extractInvoiceExpiresAt(invoice: FiberInvoiceResult): string | undefined {
  const timestamp = invoice.invoice?.data?.timestamp;
  const expiry = invoiceAttribute(invoice, "expiry_time", "expiryTime");
  if ((typeof timestamp !== "string" && typeof timestamp !== "number") || !expiry) return undefined;
  try {
    const timestampMs = parseFiberQuantity(timestamp);
    const expirySeconds = parseFiberQuantity(expiry);
    const expiresMs = timestampMs + expirySeconds * 1000n;
    if (expiresMs > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return new Date(Number(expiresMs)).toISOString();
  } catch {
    return undefined;
  }
}

export function serializeFiberUdtTypeScript(script: FiberUdtTypeScript): string {
  const parsed = FiberUdtTypeScriptSchema.parse(script);
  const codeHash = Buffer.from(parsed.code_hash.slice(2), "hex");
  const args = Buffer.from(parsed.args.slice(2), "hex");
  const hashType = new Map<string, number>([["data", 0], ["type", 1], ["data1", 2], ["data2", 4]])
    .get(parsed.hash_type.toLowerCase());
  if (typeof hashType === "undefined") throw new Error("Unsupported CKB script hash_type");
  const argsBytes = Buffer.allocUnsafe(4 + args.length);
  argsBytes.writeUInt32LE(args.length, 0);
  args.copy(argsBytes, 4);
  const total = 4 + (3 * 4) + codeHash.length + 1 + argsBytes.length;
  const encoded = Buffer.allocUnsafe(total);
  encoded.writeUInt32LE(total, 0);
  encoded.writeUInt32LE(16, 4);
  encoded.writeUInt32LE(48, 8);
  encoded.writeUInt32LE(49, 12);
  codeHash.copy(encoded, 16);
  encoded[48] = hashType;
  argsBytes.copy(encoded, 49);
  return `0x${encoded.toString("hex")}`;
}

export function fiberNetworkFromCurrency(currency: string): "mainnet" | "testnet" | "dev" {
  const normalized = currency.toLowerCase();
  if (normalized === "fibb") return "mainnet";
  if (normalized === "fibt") return "testnet";
  if (normalized === "fibd") return "dev";
  throw new FiberPaidHttpError("wrong-network", `Unknown Fiber invoice currency ${currency}`, 402);
}

function assertInvoiceMatches(input: {
  invoice: FiberInvoiceResult;
  expectedInvoiceAddress?: string;
  expectedPaymentHash: string;
  expectedAmount: string;
  expectedCurrency: string;
  expectedNetwork: "mainnet" | "testnet" | "dev";
  expectedHashAlgorithm: "ckb_hash" | "sha256";
  expectedUdtTypeScript?: FiberUdtTypeScript;
  expectedInvoiceExpiresAt?: string;
  expectedInvoiceUdtScript?: string;
  requireUnexpired?: boolean;
}): void {
  if (input.expectedInvoiceAddress && input.invoice.invoice_address !== input.expectedInvoiceAddress) {
    throw new FiberPaidHttpError("wrong-invoice", "Fiber invoice address does not match the challenge", 402);
  }
  if (!sameHex32(extractInvoicePaymentHash(input.invoice), input.expectedPaymentHash)) {
    throw new FiberPaidHttpError("wrong-payment-hash", "Fiber invoice payment hash does not match the challenge", 402);
  }
  const amount = extractInvoiceAmount(input.invoice);
  if (!amount || amount !== input.expectedAmount) {
    throw new FiberPaidHttpError("wrong-amount", "Fiber invoice amount does not match the challenge", 402);
  }
  const currency = input.invoice.invoice?.currency;
  if (!currency || currency.toLowerCase() !== input.expectedCurrency.toLowerCase()) {
    throw new FiberPaidHttpError("wrong-currency", "Fiber invoice currency does not match the challenge", 402);
  }
  if (fiberNetworkFromCurrency(currency) !== input.expectedNetwork) {
    throw new FiberPaidHttpError("wrong-network", "Fiber invoice network does not match the challenge", 402);
  }
  if (invoiceHashAlgorithm(input.invoice) !== input.expectedHashAlgorithm) {
    throw new FiberPaidHttpError("wrong-hash-algorithm", "Fiber invoice hash algorithm does not match the challenge", 402);
  }
  const actualUdt = extractInvoiceUdtScript(input.invoice)?.toLowerCase();
  const expectedUdt = input.expectedUdtTypeScript
    ? serializeFiberUdtTypeScript(input.expectedUdtTypeScript).toLowerCase()
    : undefined;
  if (actualUdt !== expectedUdt || (input.expectedInvoiceUdtScript && actualUdt !== input.expectedInvoiceUdtScript.toLowerCase())) {
    throw new FiberPaidHttpError("wrong-udt", "Fiber invoice UDT type script does not match the challenge", 402);
  }
  const expiresAt = extractInvoiceExpiresAt(input.invoice);
  if (!expiresAt) {
    throw new FiberPaidHttpError("wrong-expiry", "Fiber invoice expiry metadata is missing", 402);
  }
  if (input.expectedInvoiceExpiresAt && expiresAt !== input.expectedInvoiceExpiresAt) {
    throw new FiberPaidHttpError("wrong-expiry", "Fiber invoice expiry does not match the challenge", 402);
  }
  if (input.requireUnexpired && Date.parse(expiresAt) <= Date.now()) {
    throw new FiberPaidHttpError("expired-challenge", "Fiber invoice has expired", 402);
  }
}

function invoiceAttribute(invoice: FiberInvoiceResult, snake: string, camel: string): string | undefined {
  for (const attr of invoice.invoice?.data?.attrs ?? []) {
    const value = attr[snake] ?? attr[camel];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function parseFiberQuantity(value: string | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("invalid Fiber quantity");
  return BigInt(value);
}

function invoiceHashAlgorithm(invoice: FiberInvoiceResult): "ckb_hash" | "sha256" {
  const attrs = invoice.invoice?.data?.attrs ?? [];
  for (const attr of attrs) {
    const value = attr.hash_algorithm ?? attr.hashAlgorithm;
    if (typeof value === "string" && value.toLowerCase() === "sha256") {
      return "sha256";
    }
  }
  return "ckb_hash";
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
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Fiber quantity number must be a safe integer");
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error("Fiber quantity must be an integer");
  }
  if (parsed < 0n) {
    throw new Error("Fiber quantity cannot be negative");
  }
  return `0x${parsed.toString(16)}`;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Fiber millisecond settings must be positive decimal integers");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Fiber millisecond settings exceed the safe integer range");
  }
  return parsed;
}

function sameHex32(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertPollingConfiguration(timeoutMs: number, pollMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(pollMs) ||
    timeoutMs <= 0 ||
    pollMs <= 0 ||
    pollMs > timeoutMs
  ) {
    throw new Error("Fiber settlement polling must satisfy 0 < poll <= timeout using integer milliseconds");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => typeof value !== "undefined"));
}
