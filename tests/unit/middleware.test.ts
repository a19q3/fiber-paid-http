import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAYMENT_RECEIPT_HEADER,
  buildAuthorizationPaymentHeader,
  decodeFiberChargeRequest,
  decodeReceipt,
  parseAuthorizationPaymentHeader,
  parseWwwAuthenticatePaymentHeader
} from "@fiber-paid-http/core";
import { buildAuthorizationL402Header, hashPaymentPreimage } from "@fiber-paid-http/fl402-compat";
import { createFiberPaidHttpMiddleware } from "@fiber-paid-http/server-middleware";
import { createFiberFixtureAdapters, createSqliteTestStore } from "../helpers/fiber-fixture.js";

const secret = "middleware-secret-at-least-32-characters";
const url = "http://localhost/paid/weather";

describe("Fiber Paid HTTP middleware security", () => {
  afterEach(() => vi.useRealTimers());
  it("returns a standard MPP 402 with no-store", async () => {
    const { handler } = makeHandler();
    const response = await handler(new Request(url));
    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const challenge = challengeFrom(response);
    expect(challenge).toMatchObject({ realm: "unit.example.test", method: "fiber", intent: "charge" });
    expect(decodeFiberChargeRequest(challenge.request).amount).toBe("1000");
    expect(await response.json()).toMatchObject({ status: 402, title: "Payment Required" });
  });

  it("accepts the explicit F-L402 capability entrance", async () => {
    const rootKey = "middleware-fl402-root-key-at-least-16";
    const preimage = `0x${"11".repeat(32)}`;
    const paymentHash = hashPaymentPreimage(preimage, "sha256");
    const { handler } = makeHandler(
      { fl402: { rootKey, hashAlgorithm: "sha256" } },
      () => Response.json({ fl402: true }),
      { paymentHash }
    );
    const unpaid = await handler(new Request(url));
    const authenticate = unpaid.headers.get("www-authenticate") ?? "";
    const capability = authenticate.match(/capability="([^"]+)"/)?.[1];
    expect(capability).toMatch(/^fiber-l402-capability-v1\./);
    const paid = await handler(new Request(url, {
      headers: { authorization: buildAuthorizationL402Header({ capability: capability!, preimage }) }
    }));
    expect(paid.status).toBe(200);
    expect(decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!).reference).toBe(paymentHash);
  });

  it("returns a standard receipt only for 2xx delivery", async () => {
    const { handler, middleware } = makeHandler();
    const auth = await issueAuth(handler, url);
    const paid = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(paid.status).toBe(200);
    expect(paid.headers.get("cache-control")).toBe("private");
    const receipt = decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!);
    expect(receipt).toMatchObject({ status: "success", method: "fiber" });
    await expect(middleware.store.listDeliveryOutcomes()).resolves.toMatchObject([{
      challengeId: receipt.challengeId,
      paymentHash: receipt.reference,
      receiptReference: receipt.reference,
      status: "delivered",
      responseStatus: 200
    }]);
  });

  it("atomically accepts exactly one of 64 concurrent redemptions and executes upstream once", async () => {
    let executions = 0;
    const { handler } = makeHandler({}, () => {
      executions += 1;
      return Response.json({ ok: true });
    });
    const auth = await issueAuth(handler, url);
    const responses = await Promise.all(Array.from({ length: 64 }, () =>
      handler(new Request(url, { headers: { authorization: auth } }))
    ));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 402)).toHaveLength(63);
    expect(executions).toBe(1);
  });

  it("rejects replay, wrong resource, and tampered challenge echoes with a fresh 402", async () => {
    const { handler } = makeHandler();
    const auth = await issueAuth(handler, url);
    expect((await handler(new Request(url, { headers: { authorization: auth } }))).status).toBe(200);
    expect((await handler(new Request(url, { headers: { authorization: auth } }))).status).toBe(402);

    const { handler: other } = makeHandler();
    const otherAuth = await issueAuth(other, url);
    expect((await other(new Request("http://localhost/paid/file", { headers: { authorization: otherAuth } }))).status).toBe(402);
    const credential = parseAuthorizationPaymentHeader(otherAuth)!;
    const tampered = buildAuthorizationPaymentHeader({
      ...credential,
      challenge: { ...credential.challenge, realm: "evil.example.test" }
    });
    expect((await other(new Request(url, { headers: { authorization: tampered } }))).status).toBe(402);
  });

  it("binds non-GET bodies with an RFC 9530 digest", async () => {
    const { handler } = makeHandler();
    const unpaid = await handler(new Request(url, { method: "POST", body: "alpha" }));
    const challenge = challengeFrom(unpaid);
    expect(challenge.digest).toMatch(/^sha-256=:/);
    const auth = authFromChallenge(challenge);
    const tampered = await handler(new Request(url, {
      method: "POST",
      body: "beta",
      headers: { authorization: auth }
    }));
    expect(tampered.status).toBe(402);
  });

  it("rejects expired challenges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const { handler } = makeHandler({ challengeTtlSeconds: 1, clockSkewSeconds: 0 });
    const auth = await issueAuth(handler, url);
    vi.setSystemTime(new Date("2026-07-13T00:00:02.000Z"));
    expect((await handler(new Request(url, { headers: { authorization: auth } }))).status).toBe(402);
  });

  it("accepts challenges bound by a configured previous secret", async () => {
    const store = createSqliteTestStore();
    const oldSecret = "previous-middleware-secret-at-least-16";
    const newSecret = "current-middleware-secret-at-least-16";
    const { handler: oldHandler } = makeHandler({ store, secret: oldSecret });
    const auth = await issueAuth(oldHandler, url);
    const { handler: newHandler } = makeHandler({ store, secret: newSecret, previousSecrets: [oldSecret] });
    const paid = await newHandler(new Request(url, { headers: { authorization: auth } }));
    expect(paid.status).toBe(200);
    expect(decodeReceipt(paid.headers.get(PAYMENT_RECEIPT_HEADER)!).status).toBe("success");
  });

  it("never emits a receipt when the protected handler fails", async () => {
    const { handler, middleware } = makeHandler({}, () => { throw new Error("handler failed after payment"); });
    const auth = await issueAuth(handler, url);
    const response = await handler(new Request(url, { headers: { authorization: auth } }));
    expect(response.status).toBe(500);
    expect(response.headers.get(PAYMENT_RECEIPT_HEADER)).toBeNull();
    await expect(middleware.store.listDeliveryOutcomes()).resolves.toMatchObject([{
      status: "failed",
      responseStatus: 500,
      errorCode: "internal-error",
      errorMessage: "protected handler failed"
    }]);
  });

  it("requires durable storage", () => {
    const { payeeFiber } = createFiberFixtureAdapters();
    expect(() => createFiberPaidHttpMiddleware({
      secret,
      realm: "unit.example.test",
      serverId: "unit-server",
      publicBaseUrl: "https://unit.example.test",
      store: undefined as never,
      fiber: payeeFiber
    })).toThrow(/durable store/);
  });
});

function makeHandler(
  overrides: Partial<Parameters<typeof createFiberPaidHttpMiddleware>[0]> = {},
  routeHandler: () => Response = () => Response.json({ ok: true }),
  fixtureOptions: { paymentHash?: string } = {}
) {
  const { payeeFiber } = createFiberFixtureAdapters(fixtureOptions);
  const middleware = createFiberPaidHttpMiddleware({
    secret,
    realm: "unit.example.test",
    serverId: "unit-server",
    publicBaseUrl: "https://unit.example.test",
    store: createSqliteTestStore(),
    fiber: payeeFiber,
    challengeTtlSeconds: 120,
    clockSkewSeconds: 0,
    ...overrides
  });
  const handler = middleware.protect({
    charge: { amount: "1000", currency: "ckb", description: "Unit charge" },
    handler: routeHandler
  });
  return { middleware, handler };
}

function challengeFrom(response: Response) {
  const challenge = parseWwwAuthenticatePaymentHeader(response.headers.get("www-authenticate"));
  if (!challenge) throw new Error("missing Payment challenge");
  return challenge;
}

async function issueAuth(handler: (request: Request) => Promise<Response>, targetUrl: string): Promise<string> {
  return authFromChallenge(challengeFrom(await handler(new Request(targetUrl))));
}

function authFromChallenge(challenge: ReturnType<typeof challengeFrom>): string {
  const charge = decodeFiberChargeRequest(challenge.request);
  return buildAuthorizationPaymentHeader({
    challenge,
    payload: { paymentHash: charge.methodDetails.paymentHash }
  });
}
