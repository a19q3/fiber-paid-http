import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiberMethodAdapter, FiberRpcClient } from "@fiber-paid-http/fiber-method";
import { SqliteStore } from "@fiber-paid-http/storage";

export const FIXTURE_PAYMENT_HASH = `0x${"cd".repeat(32)}`;
export const FIXTURE_INVOICE = "fibd1qproductionfixture0001";

export function createFiberFixtureAdapters(options: { paymentHash?: string } = {}): {
  payeeFiber: FiberMethodAdapter;
  payerFiber: FiberMethodAdapter;
  calls: Array<{ method: string; params: unknown[] }>;
} {
  const paymentHash = options.paymentHash ?? FIXTURE_PAYMENT_HASH;
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    calls.push({ method: payload.method, params: payload.params ?? [] });
    return Response.json({
      jsonrpc: "2.0",
      id: payload.id,
      result: fiberResult(payload.method, paymentHash)
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

function fiberResult(method: string, paymentHash: string): unknown {
  if (method === "new_invoice" || method === "get_invoice") {
    return {
      invoice_address: FIXTURE_INVOICE,
      status: method === "get_invoice" ? "Paid" : undefined,
      invoice: {
        data: {
          payment_hash: paymentHash
        }
      }
    };
  }
  if (method === "send_payment" || method === "get_payment") {
    return {
      payment_hash: paymentHash,
      status: "Success"
    };
  }
  if (method === "list_channels") {
    return { channels: [] };
  }
  if (method === "node_info") {
    return { node_id: "fixture-node" };
  }
  throw new Error(`Unexpected Fiber RPC method ${method}`);
}
