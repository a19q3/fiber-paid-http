import { describe, expect, it } from "vitest";
import {
  PAYMENT_RECEIPT_HEADER,
  buildAuthorizationPaymentHeader,
  decodeReceipt,
  parseAuthorizationPaymentHeader,
  resourceHashFromRequest
} from "@fiber-mpp/core";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { createFiberMppMiddleware } from "@fiber-mpp/server-middleware";
import { InMemoryStore } from "@fiber-mpp/storage";

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
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url);
    const paid = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ ok: true });
    const receipt = decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!);
    expect(receipt.settlement.status).toBe("simulated");
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
    const wrongAuth = buildAuthorizationPaymentHeader({ ...credential, method: "mock" });
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

  it("pending mock Fiber payment is rejected", async () => {
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url, { status: "pending" });
    const response = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(response.status).toBe(402);
    expect(await response.text()).toContain("fiber-payment-not-settled");
  });

  it("expired challenge is rejected", async () => {
    const { handler } = makeHandler({ challengeTtlSeconds: -5, clockSkewSeconds: 0 });
    const auth = await issueAuth(handler, url);
    const response = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(response.status).toBe(402);
    expect(await response.text()).toContain("expired-challenge");
  });

  it("bad challenge signature is rejected", async () => {
    const store = new InMemoryStore();
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

  it("in-memory store is rejected in production mode", () => {
    expect(() =>
      makeHandler({
        production: true,
        allowInMemoryStore: false,
        store: new InMemoryStore()
      })
    ).toThrow(/In-memory FiberMPP storage/);
  });
});

function makeHandler(overrides: Partial<Parameters<typeof createFiberMppMiddleware>[0]> = {}) {
  const middleware = createFiberMppMiddleware({
    secret,
    serverId: "unit-server",
    store: new InMemoryStore(),
    fiber: new FiberMethodAdapter({ mode: "mock" }),
    defaultFiberAmountShannons: "1000",
    challengeTtlSeconds: 120,
    clockSkewSeconds: 0,
    ...overrides
  });
  const handler = middleware.protect({
    price: { value: "0.01", currency: "USD" },
    methods: ["fiber"],
    fiberAmountShannons: "1000",
    handler: () => Response.json({ ok: true })
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
      mode: "mock",
      paymentHash: fiber.paymentHash,
      invoice: fiber.invoice,
      amountShannons: overrides.amountShannons ?? fiber.amountShannons,
      status: overrides.status ?? "settled",
      observedAt: new Date().toISOString()
    },
    submittedAt: new Date().toISOString()
  });
}
