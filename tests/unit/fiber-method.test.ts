import { describe, expect, it } from "vitest";
import { FiberRpcClient, toFiberHexQuantity } from "@fiber-mpp/fiber-method";

describe("Fiber RPC client payloads", () => {
  it("encodes Fiber numeric JSON-RPC fields as hex quantities", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          invoice_address: "fibd1qmock",
          invoice: {
            data: { payment_hash: `0x${"11".repeat(32)}` }
          }
        }
      });
    }) as typeof fetch;
    const rpc = new FiberRpcClient({ url: "http://fiber.local", fetchImpl });
    await rpc.newInvoice({ amount: "1000", currency: "Fibd", expirySeconds: 3600 });
    expect(calls[0]).toMatchObject({
      method: "new_invoice",
      params: [
        {
          amount: "0x3e8",
          expiry: "0xe10"
        }
      ]
    });
  });

  it("preserves already-hex quantities", () => {
    expect(toFiberHexQuantity("0x3E8")).toBe("0x3e8");
  });
});
