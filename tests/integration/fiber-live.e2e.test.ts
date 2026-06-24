import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_RECEIPT_HEADER,
  buildAuthorizationPaymentHeader,
  decodeReceipt,
  resourceHashFromRequest,
  type FiberMethodChallenge
} from "@fiber-mpp/core";
import {
  FiberMethodAdapter,
  FiberRpcClient,
  isInvoicePaidStatus,
  waitForFiberInvoicePaid
} from "@fiber-mpp/fiber-method";
import { createFiberMppMiddleware } from "@fiber-mpp/server-middleware";
import { SqliteStore } from "@fiber-mpp/storage";
import { formatError, readLiveFiberEnv, writeFiberE2eResult } from "./fiber-e2e-env.js";

describe("live Fiber MPP payment flow", () => {
  it("settles through local/testnet Fiber RPC, returns a receipt, and rejects replay", async () => {
    const env = readLiveFiberEnv();
    let observedPaymentHash: string | undefined;
    let observedReceiptId: string | undefined;
    writeFiberE2eResult({
      fiber_live_test_selected: true,
      fiber_live_test_loaded: true,
      fiber_e2e_mode: env.mode,
      fiber_e2e_error: undefined
    });

    try {
      await mkdir(dirname(env.storagePath), { recursive: true });

      const payeeRpc = new FiberRpcClient({
        url: env.payeeRpcUrl,
        auth: env.payeeRpcAuth,
        label: `${env.mode}-payee`
      });
      const payerRpc = new FiberRpcClient({
        url: env.payerRpcUrl,
        auth: env.payerRpcAuth,
        label: `${env.mode}-payer`
      });

      await expect(payeeRpc.nodeInfo()).resolves.toBeDefined();
      await expect(payerRpc.nodeInfo()).resolves.toBeDefined();

      const payeeFiber = new FiberMethodAdapter({
        mode: env.mode,
        rpc: payeeRpc,
        asset: "CKB",
        currency: env.currency,
        nodeId: env.payeeNodeId,
        rpcLabel: `${env.mode}-payee`,
        settlementTimeoutMs: env.timeoutMs,
        settlementPollMs: env.pollMs
      });
      const payerFiber = new FiberMethodAdapter({
        mode: env.mode,
        rpc: payerRpc,
        asset: "CKB",
        currency: env.currency,
        nodeId: env.payerNodeId,
        rpcLabel: `${env.mode}-payer`,
        settlementTimeoutMs: env.timeoutMs,
        settlementPollMs: env.pollMs
      });

      const middleware = createFiberMppMiddleware({
        secret: env.secret,
        serverId: "fiber-mpp-live-e2e",
        store: new SqliteStore(env.storagePath),
        fiber: payeeFiber,
        defaultFiberAmountShannons: env.amountShannons,
        challengeTtlSeconds: Math.ceil(env.timeoutMs / 1000) + 60,
        clockSkewSeconds: 2,
        production: true
      });
      const handler = middleware.protect({
        price: { value: env.amountShannons, currency: "CKB" },
        methods: ["fiber"],
        fiberAmountShannons: env.amountShannons,
        handler: () => Response.json({ paid: true, rail: "fiber" })
      });

      const url = "http://fiber-mpp-live.local/paid/fiber";
      const first = await handler(new Request(url));
      expect(first.status).toBe(402);
      expect(first.headers.get("www-authenticate")).toContain("Payment ");
      expect(first.headers.get("cache-control")).toBe("no-store");

      const firstBody = (await first.json()) as {
        challengeId: string;
        challenge: { methods: Array<FiberMethodChallenge | { method: string }> };
      };
      const fiberChallenge = firstBody.challenge.methods.find(
        (method): method is FiberMethodChallenge => method.method === "fiber"
      );
      expect(fiberChallenge?.invoice).toBeTruthy();
      expect(fiberChallenge?.paymentHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      if (!fiberChallenge) {
        throw new Error("402 challenge did not include a Fiber method");
      }
      observedPaymentHash = fiberChallenge.paymentHash;

      const invoiceBefore = await payeeRpc.getInvoice(fiberChallenge.paymentHash);
      expect(invoiceBefore.status).toBeTruthy();

      const proof = await payerFiber.payChallenge(fiberChallenge);
      expect(proof.status).toBe("Success");
      expect(proof.paymentHash).toBe(fiberChallenge.paymentHash);

      const paidInvoice = await waitForFiberInvoicePaid(payeeRpc, fiberChallenge.paymentHash, {
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs
      });
      expect(isInvoicePaidStatus(paidInvoice.status)).toBe(true);

      const credential = {
        domain: "fiber-mpp-credential-v1" as const,
        challengeId: firstBody.challengeId,
        method: "fiber" as const,
        resourceHash: await resourceHashFromRequest(new Request(url)),
        paymentProof: proof,
        submittedAt: new Date().toISOString()
      };
      const authorization = buildAuthorizationPaymentHeader(credential);
      const paid = await handler(new Request(url, { headers: { authorization } }));
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ paid: true, rail: "fiber" });

      const receipt = decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!);
      observedReceiptId = receipt.receiptId;
      expect(receipt.settlement.status).toBe("settled");
      expect(receipt.settlement.paymentHash).toBe(fiberChallenge.paymentHash);

      const replay = await handler(new Request(url, { headers: { authorization } }));
      expect(replay.status).toBe(402);
      expect(await replay.text()).toContain("replay");

      writeFiberE2eResult({
        fiber_e2e_status: "passed",
        fiber_e2e_payment_hash: observedPaymentHash,
        fiber_e2e_receipt_id: observedReceiptId,
        fiber_e2e_error: undefined,
        fiber_e2e_blockers: []
      });
    } catch (error) {
      writeFiberE2eResult({
        fiber_e2e_status: "failed",
        fiber_e2e_error: formatError(error),
        fiber_e2e_payment_hash: observedPaymentHash,
        fiber_e2e_receipt_id: observedReceiptId
      });
      throw error;
    }
  });
});
