import {
  FiberMppError,
  PAYMENT_RECEIPT_HEADER,
  PaymentChallengeSchema,
  PaymentCredentialSchema,
  attachReceiptSignature,
  buildWwwAuthenticatePaymentHeader,
  credentialHash,
  parseAuthorizationPaymentHeader,
  paymentProblemBody,
  randomId,
  randomNonce,
  resourceDescriptorFromRequest,
  resourceHash,
  signChallenge,
  toProblemJson,
  verifyChallengeSignature,
  encodeReceipt,
  sha256Hex,
  canonicalJson,
  type Amount,
  type FiberMethodChallenge,
  type PaymentChallenge,
  type PaymentCredential,
  type PaymentMethodName,
  type PaymentReceipt
} from "@fiber-mpp/core";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import {
  InMemoryStore,
  assertProductionStore,
  type ChallengeRecord,
  type FiberMppStore
} from "@fiber-mpp/storage";

export type PaidRouteConfig = {
  price: Amount;
  methods?: PaymentMethodName[];
  fiberAmountShannons?: string;
  ttlSeconds?: number;
  audience?: string;
  metadata?: unknown;
  handler: (request: Request) => Promise<Response> | Response;
};

export type FiberMppMiddlewareConfig = {
  secret: string;
  serverId: string;
  store?: FiberMppStore;
  fiber?: FiberMethodAdapter;
  defaultFiberAmountShannons?: string;
  challengeTtlSeconds?: number;
  clockSkewSeconds?: number;
  production?: boolean;
  allowInMemoryStore?: boolean;
};

export type FiberMppMiddleware = {
  protect: (route: PaidRouteConfig) => (request: Request) => Promise<Response>;
  protectRoute: (route: PaidRouteConfig) => (request: Request) => Promise<Response>;
  issueChallenge: (request: Request, route: PaidRouteConfig) => Promise<Response>;
  verifyCredential: (request: Request, credential: PaymentCredential) => Promise<PaymentReceipt>;
  store: FiberMppStore;
};

export type ReverseProxyConfig = Omit<PaidRouteConfig, "handler"> & {
  upstream: string;
  fetchImpl?: typeof fetch;
};

export function createFiberMppMiddleware(config: FiberMppMiddlewareConfig): FiberMppMiddleware {
  if (!config.secret || config.secret.length < 16) {
    throw new Error("FiberMPP middleware requires a secret of at least 16 characters");
  }
  const store = config.store ?? new InMemoryStore();
  if (config.production) {
    assertProductionStore(store, config.allowInMemoryStore || process.env.ALLOW_IN_MEMORY_STORE === "1");
  }
  const fiber = config.fiber ?? FiberMethodAdapter.fromEnv();
  const challengeTtlSeconds = config.challengeTtlSeconds ?? 120;
  const clockSkewSeconds = config.clockSkewSeconds ?? 5;

  async function issueChallenge(request: Request, route: PaidRouteConfig): Promise<Response> {
    const descriptor = await resourceDescriptorFromRequest(request);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (route.ttlSeconds ?? challengeTtlSeconds) * 1000).toISOString();
    const challengeId = randomId("chal");
    const enabledMethods = route.methods ?? ["fiber"];
    const methods = [];

    if (enabledMethods.includes("fiber")) {
      methods.push(
        await fiber.createChallenge({
          challengeId,
          amountShannons: route.fiberAmountShannons ?? config.defaultFiberAmountShannons ?? "1000",
          expiresAt,
          description: `FiberMPP ${request.method.toUpperCase()} ${new URL(request.url).pathname}`
        })
      );
    }

    if (enabledMethods.includes("mock")) {
      methods.push({
        method: "mock" as const,
        intent: "charge" as const,
        amount: route.price.value,
        currency: route.price.currency,
        settlement: "simulated" as const
      });
    }

    if (methods.length === 0) {
      throw new FiberMppError("no-payment-method", "No configured payment method can serve this route", 500);
    }

    const challenge = PaymentChallengeSchema.parse({
      domain: "fiber-mpp-challenge-v1",
      challengeId,
      resource: descriptor,
      amount: route.price,
      methods,
      nonce: randomNonce(),
      issuedAt: now.toISOString(),
      expiresAt,
      serverId: config.serverId,
      audience: route.audience,
      maxUses: 1,
      metadataHash: route.metadata ? sha256Hex(canonicalJson(route.metadata)) : undefined
    });
    const signature = signChallenge(challenge, config.secret);
    const record: ChallengeRecord = {
      challenge,
      signature,
      resourceHash: resourceHash(descriptor),
      createdAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt
    };
    await store.saveChallenge(record);

    return new Response(JSON.stringify(paymentProblemBody(challenge, signature), null, 2), {
      status: 402,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "www-authenticate": buildWwwAuthenticatePaymentHeader({ challenge, signature })
      }
    });
  }

  async function verifyCredential(request: Request, credential: PaymentCredential): Promise<PaymentReceipt> {
    const parsed = PaymentCredentialSchema.parse(credential);
    const record = await store.getChallenge(parsed.challengeId);
    if (!record) {
      throw new FiberMppError("unknown-challenge", "Payment challenge is unknown or expired", 402);
    }
    const challenge = PaymentChallengeSchema.parse(record.challenge);
    if (!verifyChallengeSignature(challenge, record.signature, config.secret)) {
      throw new FiberMppError("bad-challenge-signature", "Payment challenge signature is invalid", 402);
    }
    assertNotExpired(challenge, clockSkewSeconds);

    const currentResource = await resourceDescriptorFromRequest(request);
    const currentResourceHash = resourceHash(currentResource);
    if (parsed.resourceHash !== record.resourceHash || currentResourceHash !== record.resourceHash) {
      throw new FiberMppError("wrong-resource", "Payment credential is not bound to this resource", 402);
    }

    const methodChallenge = challenge.methods.find((method) => method.method === parsed.method);
    if (!methodChallenge) {
      throw new FiberMppError("wrong-method", "Payment credential method does not match the challenge", 402);
    }

    const hash = credentialHash(parsed);
    if (await store.hasCredentialUse(hash)) {
      throw new FiberMppError("replay", "Payment credential was already used", 402);
    }

    const evidence = await verifyMethodProof(methodChallenge, parsed);
    const now = new Date().toISOString();
    const marked = await store.markChallengeUsed(challenge.challengeId, now);
    if (!marked) {
      throw new FiberMppError("replay", "Payment challenge was already redeemed", 402);
    }
    const saved = await store.saveCredentialUse(hash, parsed, now);
    if (!saved) {
      throw new FiberMppError("replay", "Payment credential was already used", 402);
    }

    if (evidence.settlement.paymentHash) {
      await store.savePaymentObservation({
        paymentHash: evidence.settlement.paymentHash,
        challengeId: challenge.challengeId,
        settlement: evidence.settlement,
        amountShannons: evidence.amountShannons,
        updatedAt: now
      });
    }

    const receipt = attachReceiptSignature(
      {
        domain: "fiber-mpp-receipt-v1",
        receiptId: randomId("rcpt"),
        challengeId: challenge.challengeId,
        method: parsed.method,
        resourceHash: record.resourceHash,
        amount: {
          value: challenge.amount.value,
          currency: challenge.amount.currency
        },
        settlement: evidence.settlement,
        serverId: config.serverId,
        issuedAt: now
      },
      config.secret
    );
    await store.saveReceipt(receipt);
    return receipt;
  }

  async function verifyMethodProof(
    methodChallenge: PaymentChallenge["methods"][number],
    credential: PaymentCredential
  ): Promise<{ settlement: PaymentReceipt["settlement"]; amountShannons?: string }> {
    if (methodChallenge.method === "fiber") {
      return fiber.verifyProof(methodChallenge as FiberMethodChallenge, credential.paymentProof);
    }
    if (methodChallenge.method === "mock") {
      const proof = credential.paymentProof as { status?: string; observedAt?: string };
      if (proof?.status !== "settled") {
        throw new FiberMppError("mock-payment-not-settled", "Mock payment proof is not settled", 402);
      }
      return {
        settlement: {
          status: "simulated",
          provider: "mock",
          observedAt: proof.observedAt ?? new Date().toISOString()
        }
      };
    }
    throw new FiberMppError("unsupported-method", `${methodChallenge.method} verification is not implemented`, 402);
  }

  function protect(route: PaidRouteConfig): (request: Request) => Promise<Response> {
    return async (request: Request) => {
      try {
        const credential = parseAuthorizationPaymentHeader(request.headers.get("authorization"));
        if (!credential) {
          return await issueChallenge(request, route);
        }
        const receipt = await verifyCredential(request, credential);
        const upstream = await route.handler(request);
        const headers = new Headers(upstream.headers);
        headers.set(PAYMENT_RECEIPT_HEADER, encodeReceipt(receipt));
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers
        });
      } catch (error) {
        const problem = toProblemJson(error);
        return new Response(JSON.stringify(problem.body, null, 2), {
          status: problem.status,
          headers: {
            "content-type": "application/problem+json",
            "cache-control": "no-store"
          }
        });
      }
    };
  }

  return {
    protect,
    protectRoute: protect,
    issueChallenge,
    verifyCredential,
    store
  };
}

export function createReverseProxyHandler(
  middleware: FiberMppMiddleware,
  config: ReverseProxyConfig
): (request: Request) => Promise<Response> {
  const upstream = new URL(config.upstream);
  const fetchImpl = config.fetchImpl ?? fetch;
  return middleware.protect({
    ...config,
    handler: async (request) => {
      const source = new URL(request.url);
      const target = new URL(source.pathname + source.search, upstream);
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      const init: RequestInit = {
        method: request.method,
        headers
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.clone().arrayBuffer();
      }
      return fetchImpl(new Request(target, init));
    }
  });
}

function assertNotExpired(challenge: PaymentChallenge, clockSkewSeconds: number): void {
  const now = Date.now();
  const expiresAt = new Date(challenge.expiresAt).getTime();
  if (Number.isNaN(expiresAt) || now - clockSkewSeconds * 1000 > expiresAt) {
    throw new FiberMppError("expired-challenge", "Payment challenge is expired", 402);
  }
}
