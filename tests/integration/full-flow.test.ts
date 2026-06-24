import { describe, expect, it } from "vitest";
import {
  buildAuthorizationPaymentHeader,
  resourceHash,
  resourceHashFromRequest,
  signChallenge
} from "@fiber-mpp/core";
import { paidFetch } from "@fiber-mpp/client";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { f402ChallengeToMpp, f402ProofToCredential } from "@fiber-mpp/f402-compat";
import { createFiberMppMiddleware, createReverseProxyHandler } from "@fiber-mpp/server-middleware";
import { InMemoryStore } from "@fiber-mpp/storage";
import { createDemoApi } from "@fiber-mpp/demo-api";

describe("FiberMPP integration flows", () => {
  it("demo paid endpoint completes full flow", async () => {
    const app = createDemoApi();
    const result = await paidFetch("http://localhost/paid/weather", {}, { fetchImpl: appFetch(app) });
    expect(result.response.status).toBe(200);
    expect(result.receipt?.settlement.status).toBe("simulated");
  });

  it("evidence console API exposes a non-theatrical proof flow", async () => {
    const app = createDemoApi();
    const status = await app.request("http://localhost/api/status");
    expect(status.status).toBe(200);
    const statusBody = await status.json() as {
      endpoints: Array<{ path: string }>;
      localFiberNetwork: { node1: { status: string }; node2: { status: string }; node3: { status: string } };
    };
    expect(statusBody.endpoints[0]?.path).toBe("/paid/protocol-service");
    expect(JSON.stringify(statusBody)).not.toContain("robot");
    expect(new Set([
      statusBody.localFiberNetwork.node1.status,
      statusBody.localFiberNetwork.node2.status,
      statusBody.localFiberNetwork.node3.status
    ])).not.toContain("online");

    const unpaid = await app.request("http://localhost/api/demo/unpaid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/paid/protocol-service" })
    });
    expect(unpaid.status).toBe(200);
    expect((await unpaid.clone().json()) as { status: number }).toMatchObject({ status: 402 });

    const pay = await app.request("http://localhost/api/demo/pay", { method: "POST" });
    expect(pay.status).toBe(200);
    expect((await pay.clone().json()) as { proof: { paymentHash: string } }).toMatchObject({
      proof: { paymentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }
    });

    const retry = await app.request("http://localhost/api/demo/retry", { method: "POST" });
    expect(retry.status).toBe(200);
    const retryBody = await retry.clone().json() as { status: number; receipt?: { receiptId: string }; body?: unknown };
    expect(retryBody.status).toBe(200);
    expect(retryBody.receipt?.receiptId).toMatch(/^rcpt_/);
    expect(JSON.stringify(retryBody.body)).toContain("protected-api");

    const replay = await app.request("http://localhost/api/demo/replay", { method: "POST" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: 402,
      rejected: true,
      receiptReissued: false
    });
  });

  it("reverse proxy completes full flow", async () => {
    const middleware = createFiberMppMiddleware({
      secret: "reverse-proxy-secret-at-least-16",
      serverId: "reverse-proxy",
      store: new InMemoryStore(),
      fiber: new FiberMethodAdapter({ mode: "mock" })
    });
    const proxy = createReverseProxyHandler(middleware, {
      upstream: "http://upstream.local",
      price: { value: "0.01", currency: "USD" },
      methods: ["fiber"],
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return Response.json({
          upstream: new URL(request.url).pathname,
          authForwarded: request.headers.has("authorization")
        });
      }
    });
    const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return proxy(request);
    }) as typeof fetch;
    const result = await paidFetch("http://proxy.local/paid/data", {}, { fetchImpl: proxyFetch });
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ upstream: "/paid/data", authForwarded: false });
  });

  it("F402 compatibility credential can redeem an MPP route", async () => {
    const store = new InMemoryStore();
    const secret = "f402-flow-secret-at-least-16";
    const middleware = createFiberMppMiddleware({
      secret,
      serverId: "f402-flow",
      store,
      fiber: new FiberMethodAdapter({ mode: "mock" })
    });
    const url = "http://localhost/paid/weather";
    const resource = { method: "GET", url };
    const challenge = f402ChallengeToMpp({
      f402: {
        token: "v1.aaa.bbb",
        invoice: "fibd1qmock",
        paymentHash: `0x${"ef".repeat(32)}`,
        amount: "1000",
        currency: "CKB",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      resource,
      serverId: "f402-flow"
    });
    await store.saveChallenge({
      challenge,
      signature: signChallenge(challenge, secret),
      resourceHash: resourceHash(resource),
      createdAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt
    });
    const credential = f402ProofToCredential({
      challengeId: challenge.challengeId,
      resourceHash: resourceHash(resource),
      proof: {
        token: "v1.aaa.bbb",
        invoice: "fibd1qmock",
        paymentHash: `0x${"ef".repeat(32)}`,
        amountShannons: "1000",
        status: "settled"
      }
    });
    const handler = middleware.protect({
      price: { value: "1000", currency: "CKB" },
      methods: ["fiber"],
      handler: () => Response.json({ f402: true })
    });
    const response = await handler(new Request(url, { headers: { authorization: buildAuthorizationPaymentHeader(credential) } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ f402: true });
  });

  it("replay, wrong-resource, and expired challenge attacks are rejected", async () => {
    const app = createDemoApi({ challengeTtlSeconds: 120 });
    const first = await app.request("http://localhost/paid/weather");
    const body = (await first.clone().json()) as {
      challengeId: string;
      challenge: { methods: Array<{ method: string; paymentHash: string; invoice?: string; amountShannons?: string }> };
    };
    const fiber = body.challenge.methods.find((method) => method.method === "fiber")!;
    const credential = {
      domain: "fiber-mpp-credential-v1" as const,
      challengeId: body.challengeId,
      method: "fiber" as const,
      resourceHash: await resourceHashFromRequest(new Request("http://localhost/paid/weather")),
      paymentProof: {
        kind: "fiber-payment-proof-v1",
        mode: "mock",
        paymentHash: fiber.paymentHash,
        invoice: fiber.invoice,
        amountShannons: fiber.amountShannons,
        status: "settled",
        observedAt: new Date().toISOString()
      },
      submittedAt: new Date().toISOString()
    };
    const auth = buildAuthorizationPaymentHeader(credential);
    expect((await app.request("http://localhost/paid/file", { headers: { authorization: auth } })).status).toBe(402);
    expect((await app.request("http://localhost/paid/weather", { headers: { authorization: auth } })).status).toBe(200);
    expect((await app.request("http://localhost/paid/weather", { headers: { authorization: auth } })).status).toBe(402);

    const expired = createDemoApi({ challengeTtlSeconds: -5, clockSkewSeconds: 0 });
    const expiredFirst = await expired.request("http://localhost/paid/weather");
    const expiredBody = (await expiredFirst.json()) as typeof body;
    const expiredFiber = expiredBody.challenge.methods.find((method) => method.method === "fiber")!;
    const expiredAuth = buildAuthorizationPaymentHeader({
      ...credential,
      challengeId: expiredBody.challengeId,
      paymentProof: {
        ...credential.paymentProof,
        paymentHash: expiredFiber.paymentHash,
        invoice: expiredFiber.invoice,
        amountShannons: expiredFiber.amountShannons
      },
      submittedAt: new Date().toISOString()
    });
    expect((await expired.request("http://localhost/paid/weather", { headers: { authorization: expiredAuth } })).status).toBe(402);
  });
});

function appFetch(app: ReturnType<typeof createDemoApi>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return app.request(request);
  }) as typeof fetch;
}
