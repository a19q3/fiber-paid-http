import { describe, expect, it } from "vitest";
import { FiberRpcClient, toFiberHexQuantity } from "@fiber-paid-http/fiber-method";
import { createFiberFixtureAdapters, FIXTURE_PAYMENT_HASH } from "../helpers/fiber-fixture.js";

describe("Fiber RPC client payloads", () => {
  it("encodes Fiber numeric JSON-RPC fields as hex quantities", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          invoice_address: "fibd1qfixture",
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

  it("adapter uses Fiber RPC for invoice, payment, and settlement inspection", async () => {
    const { payeeFiber, payerFiber, calls } = createFiberFixtureAdapters();
    const challenge = await payeeFiber.createChallenge({
      challengeId: "chal_fixture_0001",
      amountShannons: "100",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    const proof = await payerFiber.payChallenge(challenge);
    const receiptEvidence = await payeeFiber.verifyProof(challenge, proof);
    expect(challenge.paymentHash).toBe(FIXTURE_PAYMENT_HASH);
    expect(proof.mode).toBe("local");
    expect(receiptEvidence.settlement.status).toBe("settled");
    expect(calls.map((call) => call.method)).toEqual(["new_invoice", "send_payment", "get_payment", "get_invoice"]);
  });
});
