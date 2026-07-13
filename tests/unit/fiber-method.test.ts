import { describe, expect, it } from "vitest";
import {
  FiberRpcClient,
  isInvoicePaidStatus,
  isPaymentSuccessStatus,
  toFiberHexQuantity,
  waitForFiberInvoicePaid
} from "@fiber-paid-http/fiber-method";
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
    expect(toFiberHexQuantity("0x0003E8")).toBe("0x3e8");
    expect(() => toFiberHexQuantity("0xnothex")).toThrow(/integer/);
  });

  it("accepts only exact Fiber terminal success statuses", () => {
    expect(isPaymentSuccessStatus("Success")).toBe(true);
    expect(isPaymentSuccessStatus("success")).toBe(false);
    expect(isInvoicePaidStatus("Paid")).toBe(true);
    expect(isInvoicePaidStatus("paid")).toBe(false);
  });

  it("rejects invalid JSON-RPC envelopes and polling settings", async () => {
    const rpc = new FiberRpcClient({
      url: "http://fiber.local",
      fetchImpl: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return Response.json({ jsonrpc: "2.0", id: request.id + 1, result: {} });
      }) as typeof fetch
    });
    await expect(rpc.nodeInfo()).rejects.toMatchObject({ code: "fiber-rpc-invalid-response" });
    await expect(waitForFiberInvoicePaid(rpc, FIXTURE_PAYMENT_HASH, { timeoutMs: 0, pollMs: 1 }))
      .rejects.toThrow(/0 < poll <= timeout/);
  });

  it("adapter uses Fiber RPC for invoice, payment, and settlement inspection", async () => {
    const { payeeFiber, payerFiber, calls } = createFiberFixtureAdapters();
    const charge = await payeeFiber.createChargeRequest({ amount: "100", currency: "ckb" }, 120);
    const payload = await payerFiber.payCharge(charge);
    const receiptEvidence = await payeeFiber.verifyPayload(charge, payload);
    expect(charge.methodDetails.paymentHash).toBe(FIXTURE_PAYMENT_HASH);
    expect(payload.paymentHash).toBe(FIXTURE_PAYMENT_HASH);
    expect(receiptEvidence.settlement.status).toBe("settled");
    expect(calls.map((call) => call.method)).toEqual(["new_invoice", "parse_invoice", "send_payment", "get_payment", "get_invoice"]);
  });

  it.each([
    ["amount", "wrong-amount", (invoice: InvoiceFixture) => { invoice.invoice.amount = "0x65"; }],
    ["currency", "wrong-currency", (invoice: InvoiceFixture) => { invoice.invoice.currency = "Fibt"; }],
    ["hash algorithm", "wrong-hash-algorithm", (invoice: InvoiceFixture) => { invoice.invoice.data.attrs.push({ hash_algorithm: "sha256" }); }],
    ["UDT", "wrong-udt", (invoice: InvoiceFixture) => { invoice.invoice.data.attrs.push({ udt_script: "0x3500000010000000300000003100000000000000000000000000000000000000000000000000000000000000000000000000000000" }); }],
    ["expiry", "wrong-expiry", (invoice: InvoiceFixture) => { invoice.invoice.data.attrs[0] = { expiry_time: "0x79" }; }],
    ["payment hash", "wrong-payment-hash", (invoice: InvoiceFixture) => { invoice.invoice.data.payment_hash = `0x${"ef".repeat(32)}`; }]
  ])("rejects a parsed invoice with the wrong %s before send_payment", async (_field, code, mutate) => {
    const { payeeFiber, payerFiber, calls } = createFiberFixtureAdapters({
      transformResult(method, result) {
        if (method === "parse_invoice") mutate(result as InvoiceFixture);
        return result;
      }
    });
    const charge = await payeeFiber.createChargeRequest({ amount: "100", currency: "ckb" }, 120);
    await expect(payerFiber.payCharge(charge)).rejects.toMatchObject({ code });
    expect(calls.some((call) => call.method === "send_payment")).toBe(false);
  });

  it("rejects a paid invoice record with a different invoice address", async () => {
    const { payeeFiber, payerFiber } = createFiberFixtureAdapters({
      transformResult(method, result) {
        if (method === "get_invoice") (result as InvoiceFixture).invoice_address = "fibd1qwronginvoice";
        return result;
      }
    });
    const charge = await payeeFiber.createChargeRequest({ amount: "100", currency: "ckb" }, 120);
    const payload = await payerFiber.payCharge(charge);
    await expect(payeeFiber.verifyPayload(charge, payload)).rejects.toMatchObject({ code: "wrong-invoice" });
  });
});

type InvoiceFixture = {
  invoice_address: string;
  invoice: {
    amount: string;
    currency: string;
    data: {
      payment_hash: string;
      attrs: Array<Record<string, unknown>>;
    };
  };
};
