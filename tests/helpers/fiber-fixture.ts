import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiberMethodAdapter, FiberRpcClient, serializeFiberUdtTypeScript } from "@fiber-paid-http/fiber-method";
import type { FiberUdtTypeScript } from "@fiber-paid-http/core";
import { SqliteStore } from "@fiber-paid-http/storage";

export const FIXTURE_PAYMENT_HASH = `0x${"cd".repeat(32)}`;
export const FIXTURE_INVOICE = "fibd1qproductionfixture0001";

export function createFiberFixtureAdapters(options: {
  paymentHash?: string;
  transformResult?: (method: string, result: unknown) => unknown;
} = {}): {
  payeeFiber: FiberMethodAdapter;
  payerFiber: FiberMethodAdapter;
  calls: Array<{ method: string; params: unknown[] }>;
} {
  const paymentHash = options.paymentHash ?? FIXTURE_PAYMENT_HASH;
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let invoiceCounter = 0;
  const invoicesByAddress = new Map<string, InvoiceRecord>();
  const invoicesByHash = new Map<string, InvoiceRecord>();
  const defaultInvoice = invoiceRecord(FIXTURE_INVOICE, paymentHash, "0x3e8", "Fibd", "0x78");
  invoicesByAddress.set(defaultInvoice.invoice_address, defaultInvoice);
  invoicesByHash.set(paymentHash, defaultInvoice);
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    calls.push({ method: payload.method, params: payload.params ?? [] });
    let result: unknown;
    if (payload.method === "new_invoice") {
      const params = payload.params?.[0] as {
        amount?: unknown;
        currency?: unknown;
        expiry?: unknown;
        hash_algorithm?: unknown;
        udt_type_script?: unknown;
      } | undefined;
      const currentHash = invoiceCounter === 0
        ? paymentHash
        : `0x${invoiceCounter.toString(16).padStart(64, "0")}`;
      const address = invoiceCounter === 0 ? FIXTURE_INVOICE : `${FIXTURE_INVOICE}${invoiceCounter}`;
      const record = invoiceRecord(
        address,
        currentHash,
        typeof params?.amount === "string" ? params.amount : "0x3e8",
        typeof params?.currency === "string" ? params.currency : "Fibd",
        typeof params?.expiry === "string" ? params.expiry : "0x78",
        params?.hash_algorithm === "sha256" ? "sha256" : "ckb_hash",
        params?.udt_type_script as FiberUdtTypeScript | undefined
      );
      invoiceCounter += 1;
      invoicesByAddress.set(address, record);
      invoicesByHash.set(currentHash, record);
      result = structuredClone(record);
    } else if (payload.method === "parse_invoice") {
      const address = (payload.params?.[0] as { invoice?: unknown } | undefined)?.invoice;
      result = structuredClone(typeof address === "string" ? invoicesByAddress.get(address) ?? defaultInvoice : defaultInvoice);
    } else if (payload.method === "send_payment") {
      const address = (payload.params?.[0] as { invoice?: unknown } | undefined)?.invoice;
      const record = typeof address === "string" ? invoicesByAddress.get(address) ?? defaultInvoice : defaultInvoice;
      result = { payment_hash: record.invoice.data.payment_hash, status: "Success" };
    } else if (payload.method === "get_payment") {
      const hash = (payload.params?.[0] as { payment_hash?: unknown } | undefined)?.payment_hash;
      result = { payment_hash: typeof hash === "string" ? hash : paymentHash, status: "Success" };
    } else if (payload.method === "get_invoice") {
      const hash = (payload.params?.[0] as { payment_hash?: unknown } | undefined)?.payment_hash;
      const record = typeof hash === "string" ? invoicesByHash.get(hash) ?? defaultInvoice : defaultInvoice;
      result = { ...structuredClone(record), status: "Paid" };
    } else if (payload.method === "list_channels") {
      result = { channels: [] };
    } else if (payload.method === "node_info") {
      result = { node_id: "fixture-node" };
    } else {
      throw new Error(`Unexpected Fiber RPC method ${payload.method}`);
    }
    return Response.json({
      jsonrpc: "2.0",
      id: payload.id,
      result: options.transformResult?.(payload.method, structuredClone(result)) ?? result
    });
  }) as typeof fetch;
  const payeeRpc = new FiberRpcClient({ url: "http://fiber.local/payee", fetchImpl, label: "local-payee" });
  const payerRpc = new FiberRpcClient({ url: "http://fiber.local/payer", fetchImpl, label: "local-payer" });
  return {
    payeeFiber: new FiberMethodAdapter({ mode: "local", rpc: payeeRpc, currency: "Fibd", rpcLabel: "local-payee" }),
    payerFiber: new FiberMethodAdapter({ mode: "local", rpc: payerRpc, currency: "Fibd", rpcLabel: "local-payer" }),
    calls
  };
}

export function createSqliteTestStore(prefix = "fiber-paid-http-test-"): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return new SqliteStore(join(dir, "store.sqlite"));
}

type InvoiceRecord = {
  invoice_address: string;
  invoice: {
    amount: string;
    currency: string;
    data: {
      payment_hash: string;
      timestamp: string;
      attrs: Array<Record<string, unknown>>;
    };
  };
};

function invoiceRecord(
  address: string,
  paymentHash: string,
  amount: string,
  currency: string,
  expiry: string,
  hashAlgorithm: "ckb_hash" | "sha256" = "ckb_hash",
  udtTypeScript?: FiberUdtTypeScript
): InvoiceRecord {
  const attrs: Array<Record<string, unknown>> = [{ expiry_time: expiry }];
  if (hashAlgorithm === "sha256") attrs.push({ hash_algorithm: hashAlgorithm });
  if (udtTypeScript) attrs.push({ udt_script: serializeFiberUdtTypeScript(udtTypeScript) });
  return {
    invoice_address: address,
    invoice: {
      amount,
      currency,
      data: {
        payment_hash: paymentHash,
        timestamp: "0x1b8d4aef000",
        attrs
      }
    }
  };
}
