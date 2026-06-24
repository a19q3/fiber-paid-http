import { describe, expect, it } from "vitest";
import {
  PAYMENT_RECEIPT_HEADER,
  buildAuthorizationPaymentHeader,
  decodeReceipt,
  parseAuthorizationPaymentHeader,
  resourceHashFromRequest,
  verifyReceiptSignature
} from "@fiber-mpp/core";
import { createFiberMppMiddleware } from "@fiber-mpp/server-middleware";
import { createFiberFixtureAdapters, createSqliteTestStore } from "../helpers/fiber-fixture.js";

const secret = "middleware-secret-at-least-16";
const url = "http://localhost/paid/weather";

describe("FiberMPP middleware security", () => {
  it("unpaid request returns 402 with no-store and Payment challenge", async () => {
    const { handler } = makeHandler();
    const response = await handler(new Request(url));
    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toContain("Payment ");
    const body = (await response.json()) as { methods: unknown[] };
    expect(body.methods).toHaveLength(1);
  });

  it("paid retry returns resource and Payment-Receipt", async () => {
    const { handler, middleware } = makeHandler();
    const auth = await issueAuth(handler, url);
    const paid = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ ok: true });
    const receipt = decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!);
    expect(receipt.settlement.status).toBe("settled");
    await expect(middleware.store.listDeliveryOutcomes()).resolves.toMatchObject([
      {
        receiptId: receipt.receiptId,
        challengeId: receipt.challengeId,
        status: "delivered",
        responseStatus: 200
      }
    ]);
  });

  it("replayed credential is rejected", async () => {
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url);
    expect((await handler(new Request(url, { headers: { authorization: auth } }))).status).toBe(200);
    const replay = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(replay.status).toBe(402);
    expect(await replay.text()).toContain("replay");
  });

  it("wrong resource is rejected before redemption", async () => {
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url);
    const wrong = await handler(new Request("http://localhost/paid/file", { headers: { authorization: auth } }));
    expect(wrong.status).toBe(402);
    expect(await wrong.text()).toContain("wrong-resource");
  });

  it("wrong method is rejected", async () => {
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url);
    const credential = parseAuthorizationPaymentHeader(auth)!;
    const wrongAuth = buildAuthorizationPaymentHeader({ ...credential, method: "unsupported-method" });
    const response = await handler(new Request(url, { headers: { authorization: wrongAuth } }));
    expect(response.status).toBe(402);
    expect(await response.text()).toContain("wrong-method");
  });

  it("wrong amount is rejected", async () => {
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url, { amountShannons: "999" });
    const response = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(response.status).toBe(402);
    expect(await response.text()).toContain("wrong-amount");
  });

  it("expired challenge is rejected", async () => {
    const { handler } = makeHandler({ challengeTtlSeconds: -5, clockSkewSeconds: 0 });
    const auth = await issueAuth(handler, url);
    const response = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(response.status).toBe(402);
    expect(await response.text()).toContain("expired-challenge");
  });

  it("bad challenge signature is rejected", async () => {
    const store = createSqliteTestStore();
    const { handler } = makeHandler({ store });
    const first = await handler(new Request(url));
    const body = (await first.clone().json()) as { challengeId: string };
    const record = await store.getChallenge(body.challengeId);
    await store.saveChallenge({ ...record!, signature: "0".repeat(64) });
    const auth = await authFromBody(body.challengeId, first, url);
    const response = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(response.status).toBe(402);
    expect(await response.text()).toContain("bad-challenge-signature");
  });

  it("accepts a previous challenge secret while signing receipts with the current secret", async () => {
    const store = createSqliteTestStore();
    const oldSecret = "previous-middleware-secret-at-least-16";
    const newSecret = "current-middleware-secret-at-least-16";
    const { handler: oldHandler } = makeHandler({ store, secret: oldSecret });
    const first = await oldHandler(new Request(url));
    const body = (await first.clone().json()) as { challengeId: string };
    const auth = await authFromBody(body.challengeId, first, url);
    const { handler: newHandler } = makeHandler({
      store,
      secret: newSecret,
      previousSecrets: [oldSecret]
    });

    const paid = await newHandler(new Request(url, { headers: { authorization: auth } }));
    expect(paid.status).toBe(200);
    const receipt = decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!);
    expect(verifyReceiptSignature(receipt, newSecret)).toBe(true);
    expect(verifyReceiptSignature(receipt, oldSecret)).toBe(false);
  });

  it("records paid-but-denied delivery failures with the payment receipt", async () => {
    const { handler, middleware } = makeHandler({}, () => {
      throw new Error("handler failed after payment");
    });
    const auth = await issueAuth(handler, url);
    const response = await handler(new Request(url, { headers: { authorization: auth } }));

    expect(response.status).toBe(500);
    const receipt = decodeReceipt(response.headers.get(PAYMENT_RECEIPT_HEADER)!);
    await expect(middleware.store.listDeliveryOutcomes()).resolves.toMatchObject([
      {
        receiptId: receipt.receiptId,
        challengeId: receipt.challengeId,
        status: "failed",
        responseStatus: 500,
        errorCode: "internal-error",
        errorMessage: "handler failed after payment"
      }
    ]);
  });

  it("durable storage is required", () => {
    expect(() =>
      makeHandler({
        store: undefined
      })
    ).toThrow(/durable store/);
  });
});

function makeHandler(
  overrides: Partial<Parameters<typeof createFiberMppMiddleware>[0]> = {},
  routeHandler: () => Response = () => Response.json({ ok: true })
) {
  const { payeeFiber } = createFiberFixtureAdapters();
  const middleware = createFiberMppMiddleware({
    secret,
    serverId: "unit-server",
    store: createSqliteTestStore(),
    fiber: payeeFiber,
    defaultFiberAmountShannons: "1000",
    challengeTtlSeconds: 120,
    clockSkewSeconds: 0,
    ...overrides
  });
  const handler = middleware.protect({
    price: { value: "1", currency: "CKB" },
    methods: ["fiber"],
    fiberAmountShannons: "1000",
    handler: routeHandler
  });
  return { middleware, handler };
}

async function issueAuth(
  handler: (request: Request) => Promise<Response>,
  targetUrl: string,
  overrides: { status?: string; amountShannons?: string } = {}
): Promise<string> {
  const first = await handler(new Request(targetUrl));
  const body = (await first.clone().json()) as { challengeId: string };
  return authFromBody(body.challengeId, first, targetUrl, overrides);
}

async function authFromBody(
  challengeId: string,
  response: Response,
  targetUrl: string,
  overrides: { status?: string; amountShannons?: string } = {}
): Promise<string> {
  const body = (await response.clone().json()) as {
    challenge: { methods: Array<{ method: string; paymentHash: string; invoice?: string; amountShannons?: string }> };
  };
  const fiber = body.challenge.methods.find((method) => method.method === "fiber")!;
  return buildAuthorizationPaymentHeader({
    domain: "fiber-mpp-credential-v1",
    challengeId,
    method: "fiber",
    resourceHash: await resourceHashFromRequest(new Request(targetUrl)),
    paymentProof: {
      kind: "fiber-payment-proof-v1",
      mode: "local",
      paymentHash: fiber.paymentHash,
      invoice: fiber.invoice,
      amountShannons: overrides.amountShannons ?? fiber.amountShannons,
      status: overrides.status ?? "settled",
      observedAt: new Date().toISOString()
    },
    submittedAt: new Date().toISOString()
  });
}
